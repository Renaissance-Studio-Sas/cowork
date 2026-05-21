// Lifecycle manager for steelyard — the Docker-based browser control plane.
//
// cowork keeps its OWN managed checkout of steelyard, brings it up with Docker
// Compose on demand (lazy), and records what it knows in a local state file.
// In compose mode steelyard serves both its API and UI on host :4000.
//
// Flow of ensureSteelyardUp():
//   1. already healthy? → done
//   2. Docker running? → if not, try to launch Docker Desktop, else ask the user
//   3. managed checkout present? → if not, clone it (remote, or a local checkout)
//   4. `docker compose up -d` in the checkout
//   5. wait for /api/health, persist state

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const exec = promisify(execFile);

export const STEELYARD_REPO_URL =
  process.env.STEELYARD_REPO_URL ?? "https://github.com/Renaissance-Studio-Sas/Steelyard.git";

// cowork-managed checkout location (decision: always a cowork-owned copy).
export const STEELYARD_DIR =
  process.env.STEELYARD_DIR ?? path.join(os.homedir(), ".cowork", "steelyard");

// In compose mode the API + UI are both published on host :4000.
export const STEELYARD_BASE_URL =
  process.env.BROWSER_CONTROL_PLANE_URL ?? "http://localhost:4000";

// A possible existing local checkout to clone FROM (fast, no remote auth).
const LOCAL_SOURCE_CANDIDATES = [
  path.join(os.homedir(), "Documents", "projects", "steelyard"),
  path.join(os.homedir(), "Documents", "projects", "browser-control-plane"),
];

const STATE_FILE = path.join(process.cwd(), ".steelyard", "state.json");

export class DockerNotRunningError extends Error {
  constructor() {
    super(
      "Docker isn't running and I couldn't start it automatically. Please open Docker Desktop (or start the Docker daemon), then retry.",
    );
    this.name = "DockerNotRunningError";
  }
}
export class SteelyardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SteelyardError";
  }
}

interface SteelyardState {
  repoUrl: string;
  dir: string;
  mode: "compose";
  baseUrl: string;
  uiUrl: string;
  composeService: string;
  status: "running" | "starting" | "error" | "stopped";
  lastStartedAt?: string;
  lastHealthyAt?: string;
  lastError?: string;
}

async function writeState(patch: Partial<SteelyardState>): Promise<void> {
  try {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    let current: Partial<SteelyardState> = {};
    try { current = JSON.parse(await fs.readFile(STATE_FILE, "utf8")); } catch { /* none yet */ }
    const next: SteelyardState = {
      repoUrl: STEELYARD_REPO_URL,
      dir: STEELYARD_DIR,
      mode: "compose",
      baseUrl: STEELYARD_BASE_URL,
      uiUrl: STEELYARD_BASE_URL,
      composeService: "steelyard",
      status: "stopped",
      ...current,
      ...patch,
    };
    await fs.writeFile(STATE_FILE, JSON.stringify(next, null, 2));
  } catch { /* best effort */ }
}

export async function readState(): Promise<SteelyardState | null> {
  try { return JSON.parse(await fs.readFile(STATE_FILE, "utf8")); } catch { return null; }
}

async function isDockerRunning(): Promise<boolean> {
  try {
    await exec("docker", ["info"], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

// Best-effort: launch Docker Desktop (macOS/Windows) and wait for the daemon.
async function tryStartDocker(): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      await exec("open", ["-a", "Docker"], { timeout: 8000 });
    } else if (process.platform === "win32") {
      await exec("cmd", ["/c", "start", "", "Docker Desktop"], { timeout: 8000 });
    } else {
      // Linux: try to start the daemon via systemd (may need privileges).
      await exec("systemctl", ["start", "docker"], { timeout: 8000 }).catch(() => {});
    }
  } catch { /* ignore — we still poll below */ }
  // Poll up to ~90s for the daemon to come up.
  for (let i = 0; i < 45; i++) {
    if (await isDockerRunning()) return true;
    await sleep(2000);
  }
  return false;
}

async function isHealthy(timeoutMs = 3000): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${STEELYARD_BASE_URL}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const j = (await res.json()) as { ok?: boolean };
    return !!j.ok;
  } catch {
    return false;
  }
}

async function ensureCheckout(): Promise<void> {
  if (existsSync(path.join(STEELYARD_DIR, "docker-compose.yml"))) return;
  await fs.mkdir(path.dirname(STEELYARD_DIR), { recursive: true });

  // Prefer cloning from a local checkout (fast, no remote auth); fall back to
  // the remote repo. Either way the managed copy lives at STEELYARD_DIR.
  const localSource = LOCAL_SOURCE_CANDIDATES.find((p) =>
    existsSync(path.join(p, "docker-compose.yml")),
  );
  const sources = localSource ? [localSource, STEELYARD_REPO_URL] : [STEELYARD_REPO_URL];

  let lastErr = "";
  for (const src of sources) {
    try {
      await exec("git", ["clone", "--depth", "1", src, STEELYARD_DIR], { timeout: 180000 });
      if (existsSync(path.join(STEELYARD_DIR, "docker-compose.yml"))) return;
      lastErr = `clone from ${src} produced no docker-compose.yml`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      // clean a partial clone before trying the next source
      await fs.rm(STEELYARD_DIR, { recursive: true, force: true }).catch(() => {});
    }
  }
  throw new SteelyardError(`Could not obtain a steelyard checkout at ${STEELYARD_DIR}: ${lastErr}`);
}

async function composeUp(): Promise<void> {
  try {
    // `up -d` builds the image on first run (the service has `build: .`) and
    // reuses it afterwards. Detached so we don't block.
    await exec("docker", ["compose", "up", "-d"], { cwd: STEELYARD_DIR, timeout: 600000 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new SteelyardError(`'docker compose up -d' failed in ${STEELYARD_DIR}: ${msg}`);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

let pending: Promise<{ baseUrl: string }> | null = null;

// Ensure steelyard is up and healthy, bringing it up (clone + compose) if not.
// Concurrent callers share one in-flight attempt.
export async function ensureSteelyardUp(): Promise<{ baseUrl: string }> {
  if (await isHealthy()) {
    await writeState({ status: "running", lastHealthyAt: new Date().toISOString() });
    return { baseUrl: STEELYARD_BASE_URL };
  }
  if (pending) return pending;

  pending = (async () => {
    await writeState({ status: "starting", lastError: undefined });
    try {
      if (!(await isDockerRunning())) {
        const ok = await tryStartDocker();
        if (!ok) {
          await writeState({ status: "error", lastError: "docker not running" });
          throw new DockerNotRunningError();
        }
      }
      await ensureCheckout();
      await writeState({ lastStartedAt: new Date().toISOString() });
      await composeUp();

      // Wait for the API to answer (first build can take a while).
      for (let i = 0; i < 90; i++) {
        if (await isHealthy()) {
          await writeState({ status: "running", lastHealthyAt: new Date().toISOString() });
          return { baseUrl: STEELYARD_BASE_URL };
        }
        await sleep(2000);
      }
      await writeState({ status: "error", lastError: "health check timed out" });
      throw new SteelyardError(
        `steelyard came up but ${STEELYARD_BASE_URL}/api/health never responded. Check 'docker compose logs' in ${STEELYARD_DIR}.`,
      );
    } catch (e) {
      if (!(e instanceof DockerNotRunningError)) {
        await writeState({ status: "error", lastError: e instanceof Error ? e.message : String(e) });
      }
      throw e;
    }
  })().finally(() => { pending = null; });

  return pending;
}
