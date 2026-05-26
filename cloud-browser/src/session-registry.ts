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
import * as r2 from "./r2-client.js";
import * as store from "./profile-store.js";
import { createWriteStream, createReadStream, promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";

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

  // 1. Make a fresh per-session profile dir and seed it from R2 if present.
  const { dir: profileDir, sessionId } = await store.makeFreshProfileDir(profile);
  try {
    const tarball = await r2.downloadProfileTarball(profile);
    if (tarball) {
      log.info("seeding profile from R2", { profile, dir: profileDir });
      await store.untarProfileDir(tarball, profileDir);
    } else {
      log.info("no R2 tarball — starting from empty profile", { profile });
    }
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
  uploaded: boolean;
}

// Release a session: stop container, upload to R2, clean up.
export async function release(profile: string): Promise<ReleaseResult> {
  const s = sessions.get(profile);
  if (!s) return { uploaded: false };
  sessions.delete(profile);

  log.info("releasing profile", { profile, sessionId: s.sessionId });

  try {
    await s.browser.close();
  } catch (e) {
    log.debug("playwright close error", { err: String(e) });
  }

  // Stop the container gracefully so chromium flushes cookie DB.
  await docker.stop(s.containerId, 10);

  // Upload to R2 (best-effort). On failure, leave the local dir intact so a
  // human can recover.
  let uploaded = false;
  try {
    const tmp = path.join(os.tmpdir(), `cbmcp-${s.profile}-${s.sessionId}.tar.gz`);
    const dest = createWriteStream(tmp);
    await store.tarProfileDir(s.profileDir, dest);
    const buf = await fsp.readFile(tmp);
    uploaded = await r2.uploadProfileTarball(profile, buf);
    await fsp.unlink(tmp).catch(() => undefined);
    if (uploaded) log.info("profile uploaded to R2", { profile, bytes: buf.length });
    await store.deleteProfileDir(s.profileDir);
  } catch (e) {
    log.error("failed to upload profile to R2; local dir preserved", {
      profile,
      dir: s.profileDir,
      err: String(e),
    });
  }
  return { uploaded };
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
