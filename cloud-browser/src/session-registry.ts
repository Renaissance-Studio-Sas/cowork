// In-process session registry: profile-name → live binding.
//
// One session per profile per MCP process — the profile name is the browser
// handle the agent uses. Multiple agents in the same MCP that ask for the
// same profile name share one container. Across MCP processes there's no
// coordination (each gets its own remote session).
//
// The container itself runs in Cloudflare via the cloud-browser infra worker
// (monorepo/infra/workers/cloud-browser). Profile state is currently
// ephemeral — each acquire spins up a fresh container; nothing is restored
// or saved. Persistence will be wired back in once the cloud side learns to
// snapshot /profile to R2 on idle shutdown.

import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { IDLE_TIMEOUT_MS } from "./config.js";
import { authHeaders } from "./auth.js";
import * as cloud from "./cloud-client.js";
import { log } from "./log.js";

export interface Session {
  profile: string;
  sessionId: string;
  cdpWsEndpoint: string;
  novncUrl: string;
  browser: Browser;
  context: BrowserContext;
  activePageIndex: number;
  acquiredAt: number;
  lastActivityAt: number;
}

const sessions = new Map<string, Session>();
let reaperTimer: NodeJS.Timeout | null = null;

export function getSession(profile: string): Session | undefined {
  return sessions.get(profile);
}

export function listSessions(): Session[] {
  return [...sessions.values()];
}

export function touch(profile: string): void {
  const s = sessions.get(profile);
  if (s) s.lastActivityAt = Date.now();
}

export interface AcquireResult {
  session: Session;
  reused: boolean;
}

export async function acquire(profile: string): Promise<AcquireResult> {
  const existing = sessions.get(profile);
  if (existing) {
    existing.lastActivityAt = Date.now();
    return { session: existing, reused: true };
  }

  log.info("acquiring profile", { profile });

  const remote = await cloud.createSession(profile);

  let browser: Browser;
  try {
    // The wsEndpoint is wss://app.rowads.studio/api/browser/.../cdp/...; we
    // attach the gateway session cookie so the WebSocket upgrade authenticates.
    browser = await chromium.connectOverCDP({
      wsEndpoint: remote.cdpWsEndpoint,
      headers: authHeaders(),
    });
  } catch (e) {
    // Tear the remote session down — no point leaving a container running we
    // couldn't connect to.
    await cloud.terminateSession(remote.sessionId);
    throw e;
  }

  const context = browser.contexts()[0] ?? (await browser.newContext());

  // Chromium boots with one tab. Wait briefly for it to materialize so we
  // don't redundantly open about:blank.
  if (context.pages().length === 0) {
    await new Promise((r) => setTimeout(r, 600));
  }
  if (context.pages().length === 0) {
    await context.newPage();
  }

  const now = Date.now();
  const session: Session = {
    profile,
    sessionId: remote.sessionId,
    cdpWsEndpoint: remote.cdpWsEndpoint,
    novncUrl: remote.novncUrl,
    browser,
    context,
    activePageIndex: 0,
    acquiredAt: now,
    lastActivityAt: now,
  };
  sessions.set(profile, session);
  startReaperIfNeeded();
  return { session, reused: false };
}

export interface ReleaseResult {
  persisted: boolean;
}

export async function release(profile: string): Promise<ReleaseResult> {
  const s = sessions.get(profile);
  if (!s) return { persisted: false };
  sessions.delete(profile);

  log.info("releasing profile", { profile, sessionId: s.sessionId });

  try {
    await s.browser.close();
  } catch (e) {
    log.debug("playwright close error", { err: String(e) });
  }

  await cloud.terminateSession(s.sessionId);

  // Persistence is currently a no-op: profile state lives only inside the
  // container's filesystem and is destroyed with it. Returning persisted:false
  // makes that visible to the agent so it doesn't expect logins to survive.
  return { persisted: false };
}

export async function releaseAll(): Promise<void> {
  const profiles = [...sessions.keys()];
  log.info("releasing all sessions", { count: profiles.length });
  await Promise.all(profiles.map((p) => release(p)));
}

function startReaperIfNeeded(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    const now = Date.now();
    for (const s of [...sessions.values()]) {
      if (now - s.lastActivityAt > IDLE_TIMEOUT_MS) {
        log.info("reaping idle session", {
          profile: s.profile,
          idleMs: now - s.lastActivityAt,
        });
        release(s.profile).catch((e) =>
          log.error("reaper release failed", { profile: s.profile, err: String(e) }),
        );
      }
    }
    if (sessions.size === 0 && reaperTimer) {
      clearInterval(reaperTimer);
      reaperTimer = null;
    }
  }, 60_000);
  reaperTimer.unref?.();
}

export function activePage(profile: string) {
  const s = sessions.get(profile);
  if (!s) throw new Error(`No active session for profile "${profile}". Call browser_use_profile first.`);
  const pages = s.context.pages();
  if (pages.length === 0) throw new Error(`No tabs open in profile "${profile}"`);
  const idx = Math.min(s.activePageIndex, pages.length - 1);
  return pages[idx]!;
}
