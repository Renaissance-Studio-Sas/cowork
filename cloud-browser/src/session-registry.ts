// In-process session registry: profile-name → live binding.
//
// One session per profile per MCP process (we treat profile name as the
// browser handle). An agent can hold multiple sessions concurrently (one per
// distinct profile). Across MCP processes, sessions on the same profile are
// allowed (each gets its own physical userDataDir) — they last-writer-wins on
// release.

import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { IDLE_TIMEOUT_MS } from "./config.js";
import { log } from "./log.js";
import * as docker from "./docker-client.js";
import * as persistence from "./persistence.js";
import * as store from "./profile-store.js";

export interface Session {
  profile: string;
  sessionId: string;
  containerId: string;
  cdpPort: number;
  novncPort: number;
  novncUrl: string;
  profileDir: string;
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

// Acquire (or reuse) a session for the given profile.
export async function acquire(profile: string): Promise<AcquireResult> {
  const existing = sessions.get(profile);
  if (existing) {
    existing.lastActivityAt = Date.now();
    return { session: existing, reused: true };
  }

  log.info("acquiring profile", { profile });

  // 1. Make a fresh per-session profile dir and seed it from the persistence
  //    backend (R2 or local folder) if a baseline exists for this profile.
  const { dir: profileDir, sessionId } = await store.makeFreshProfileDir(profile);
  try {
    const loaded = await persistence.loadProfileInto(profile, profileDir);
    if (loaded) log.info("seeded profile from persistence", { profile, dir: profileDir, backend: persistence.backend });
    else log.info("no baseline — starting from empty profile", { profile, backend: persistence.backend });
  } catch (e) {
    await store.deleteProfileDir(profileDir);
    throw e;
  }

  // 2. Spawn the container with the dir mounted.
  let spawned: docker.SpawnedContainer;
  try {
    spawned = await docker.spawn({ profile, hostProfileDir: profileDir });
  } catch (e) {
    await store.deleteProfileDir(profileDir);
    throw e;
  }

  // 3. Wait for CDP + attach Playwright.
  let browser: Browser;
  try {
    const cdpUrl = await docker.waitForCdpReady(spawned.cdpPort);
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (e) {
    await docker.stop(spawned.id, 1);
    await store.deleteProfileDir(profileDir);
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
    sessionId,
    containerId: spawned.id,
    cdpPort: spawned.cdpPort,
    novncPort: spawned.novncPort,
    novncUrl: `http://127.0.0.1:${spawned.novncPort}/vnc.html?autoconnect=1&resize=remote`,
    profileDir,
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

// Release a session: stop container, persist to backend, clean up.
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

  // Stop the container gracefully so chromium flushes cookie DB.
  await docker.stop(s.containerId, 10);

  // Persist the session dir (filtering caches) via the active backend. On
  // failure, leave the session dir intact so a human can recover.
  let persisted = false;
  try {
    persisted = await persistence.saveProfileFrom(profile, s.profileDir, s.sessionId);
    await store.deleteProfileDir(s.profileDir);
  } catch (e) {
    log.error("failed to persist profile; session dir preserved for recovery", {
      profile,
      dir: s.profileDir,
      backend: persistence.backend,
      err: String(e),
    });
  }
  return { persisted };
}

// Release every session in parallel. Used on SIGTERM / SIGINT.
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
  }, 60_000); // check every minute
  // Don't keep the event loop alive solely for the reaper
  reaperTimer.unref?.();
}

// Look up the active page within a profile's session.
export function activePage(profile: string) {
  const s = sessions.get(profile);
  if (!s) throw new Error(`No active session for profile "${profile}". Call browser_use_profile first.`);
  const pages = s.context.pages();
  if (pages.length === 0) throw new Error(`No tabs open in profile "${profile}"`);
  const idx = Math.min(s.activePageIndex, pages.length - 1);
  return pages[idx]!;
}
