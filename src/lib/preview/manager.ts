// Manages local dev servers for rowads monorepo apps so cowork can embed them
// live (HMR included) in an iframe. Each app is run via `rw worker dev --port N`
// — which assigns the port, injects auth, and wires /api — so the running
// server is fully functional and embeddable cross-origin (Vite sets no
// X-Frame-Options, and auth is injected server-side, not via browser cookies).
//
// One dev process per app, shared across sessions (refcounted); idle processes
// are reaped. This module owns processes only; per-session binding + SSE live
// in preview-session-store.ts.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { EventEmitter } from "node:events";

// Emits "dead" { app, sessions } when a local dev server stops (idle-reaped,
// crashed, or killed) so the preview-session store can tell the UI. Kept as a
// bus to avoid a manager → sessions import cycle.
export const previewEvents = new EventEmitter();
previewEvents.setMaxListeners(0);

// Resolve the workspace root the same way ../fs does, but WITHOUT importing it
// — keeping this module dependency-light avoids a circular-import TDZ
// (preview-session-store ↔ sessions ↔ fs).
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT
  ? path.resolve(process.env.WORKSPACE_ROOT)
  : path.resolve(process.cwd(), "..", "..");

export const MONOREPO_DIR =
  process.env.ROWADS_MONOREPO_DIR ?? path.join(WORKSPACE_ROOT, "projects", "monorepo");

const READY_TIMEOUT_MS = 90_000;
const IDLE_TIMEOUT_MS = Number(process.env.PREVIEW_IDLE_TIMEOUT_MS ?? 20 * 60 * 1000);
const MAX_CONCURRENT = Number(process.env.PREVIEW_MAX_CONCURRENT ?? 4);
const LOG_LINES = 400;

export class PreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewError";
  }
}

interface PreviewProc {
  app: string;
  port: number;
  url: string;
  proc: ChildProcess;
  status: "starting" | "ready" | "error" | "stopped";
  logs: string[];
  startedAt: number;
  lastUsedAt: number;
  // cowork session ids currently showing this app (refcount for teardown)
  sessions: Set<string>;
  readyPromise: Promise<void>;
}

const procs = new Map<string, PreviewProc>();

// ^[a-z0-9][a-z0-9-_]*$ — guards the path we cd into and the arg we spawn.
const APP_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;

export function appDir(app: string): string {
  return path.join(MONOREPO_DIR, "apps", app);
}

export function isValidApp(app: string): boolean {
  return APP_RE.test(app) && existsSync(path.join(appDir(app), "package.json"));
}

// List app names that have a package.json under monorepo/apps.
export function listApps(): string[] {
  const appsRoot = path.join(MONOREPO_DIR, "apps");
  if (!existsSync(appsRoot)) return [];
  try {
    return readdirSync(appsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(path.join(appsRoot, d.name, "package.json")))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

function append(p: PreviewProc, chunk: string) {
  for (const line of chunk.split(/\r?\n/)) {
    if (line.trim()) p.logs.push(line);
  }
  if (p.logs.length > LOG_LINES) p.logs.splice(0, p.logs.length - LOG_LINES);
}

async function waitReady(port: number, signal: () => boolean): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!signal()) return false; // process died
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(`http://localhost:${port}/`, { signal: ctrl.signal });
      clearTimeout(t);
      // any HTTP response means the server is listening
      if (res) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

export interface PreviewInfo {
  app: string;
  port: number;
  url: string;
  status: PreviewProc["status"];
}

function info(p: PreviewProc): PreviewInfo {
  return { app: p.app, port: p.port, url: p.url, status: p.status };
}

// Ensure a dev server is running for `app`, binding it to `sessionId`.
// Reuses an already-running process. Throws PreviewError on bad input,
// missing deps, capacity, or startup failure.
export async function startPreview(app: string, sessionId: string): Promise<PreviewInfo> {
  if (!APP_RE.test(app)) throw new PreviewError(`Invalid app name "${app}".`);
  const dir = appDir(app);
  if (!existsSync(path.join(dir, "package.json"))) {
    throw new PreviewError(`No app "${app}" under ${path.join(MONOREPO_DIR, "apps")}.`);
  }
  if (!existsSync(path.join(dir, "node_modules"))) {
    throw new PreviewError(`Dependencies not installed for "${app}". Run \`rw install\` (or npm install) in ${dir} first.`);
  }

  const existing = procs.get(app);
  if (existing && existing.status !== "stopped" && existing.status !== "error") {
    existing.sessions.add(sessionId);
    existing.lastUsedAt = Date.now();
    await existing.readyPromise.catch(() => {});
    // status may have flipped to "error" while awaiting; read it untyped.
    if ((existing.status as string) === "error") throw new PreviewError(`Dev server for "${app}" failed to start. See preview_logs.`);
    return info(existing);
  }

  const live = [...procs.values()].filter((p) => p.status === "starting" || p.status === "ready");
  if (live.length >= MAX_CONCURRENT) {
    throw new PreviewError(`Too many previews running (${live.length}/${MAX_CONCURRENT}). Stop one with stop_preview first.`);
  }

  const port = await allocatePort();
  const proc = spawn("rw", ["worker", "dev", "--port", String(port)], {
    cwd: dir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const p: PreviewProc = {
    app,
    port,
    url: `http://localhost:${port}`,
    proc,
    status: "starting",
    logs: [],
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
    sessions: new Set([sessionId]),
    readyPromise: Promise.resolve(),
  };
  procs.set(app, p);

  proc.stdout?.on("data", (d: Buffer) => append(p, d.toString()));
  proc.stderr?.on("data", (d: Buffer) => append(p, d.toString()));
  proc.on("exit", (code) => {
    append(p, `[rw worker dev exited with code ${code}]`);
    if (p.status !== "stopped") {
      // Crashed/exited on its own — notify bound sessions so the UI doesn't
      // keep showing a dead iframe.
      p.status = "error";
      previewEvents.emit("dead", { app: p.app, sessions: [...p.sessions] });
    }
  });
  proc.on("error", (e) => {
    append(p, `[spawn error: ${e.message}]`);
    p.status = "error";
  });

  p.readyPromise = (async () => {
    const ok = await waitReady(port, () => p.status === "starting" && !proc.killed && proc.exitCode === null);
    if (ok && p.status === "starting") p.status = "ready";
    else if (p.status === "starting") p.status = "error";
  })();

  await p.readyPromise;
  if (p.status !== "ready") {
    throw new PreviewError(`Dev server for "${app}" did not become ready within ${READY_TIMEOUT_MS / 1000}s. Check preview_logs (missing auth via \`rw auth\`, build error, or wrong app type).`);
  }
  return info(p);
}

export function getPreviewByApp(app: string): PreviewInfo | null {
  const p = procs.get(app);
  return p ? info(p) : null;
}

// Is a local dev server for `app` currently up and serving?
export function isPreviewAlive(app: string): boolean {
  const p = procs.get(app);
  return !!p && p.status === "ready";
}

// Warn when an app's dev server runs ALL /api locally (broad honoDevServer
// intercept), which makes gateway-only routes like /api/storage 404 in local
// dev (assets/media won't load). Returns a message, or null if it looks fine.
export function localApiCaveat(app: string): string | null {
  try {
    const cfg = readFileSync(path.join(appDir(app), "vite.config.ts"), "utf8");
    const interceptsAllApi = /req\.url\??\.startsWith\(\s*["']\/api["']\s*\)/.test(cfg);
    if (cfg.includes("honoDevServer") && interceptsAllApi) {
      return "Heads-up: this app's dev server intercepts ALL /api locally, so gateway-only routes (e.g. /api/storage) will 404 in local preview — media/assets may not load. Use target \"prod\" for a fully-working view, or fix the app's vite.config so it only intercepts its own worker routes.";
    }
  } catch { /* no vite.config */ }
  return null;
}

export function previewLogs(app: string, tail = 80): string[] {
  const p = procs.get(app);
  if (!p) return [];
  return p.logs.slice(-tail);
}

export function touchPreview(app: string): void {
  const p = procs.get(app);
  if (p) p.lastUsedAt = Date.now();
}

function killProc(p: PreviewProc): void {
  p.status = "stopped";
  previewEvents.emit("dead", { app: p.app, sessions: [...p.sessions] });
  try { p.proc.kill("SIGTERM"); } catch { /* already gone */ }
  // hard-kill if it lingers
  setTimeout(() => { try { if (p.proc.exitCode === null) p.proc.kill("SIGKILL"); } catch { /* ignore */ } }, 4000);
  procs.delete(p.app);
}

// Stop the dev server for `app` outright (all sessions).
export function stopPreviewApp(app: string): boolean {
  const p = procs.get(app);
  if (!p) return false;
  killProc(p);
  return true;
}

// Detach a session; stop the process when no session is showing it anymore.
export function detachSession(sessionId: string): string[] {
  const stopped: string[] = [];
  for (const p of [...procs.values()]) {
    if (p.sessions.delete(sessionId) && p.sessions.size === 0) {
      killProc(p);
      stopped.push(p.app);
    }
  }
  return stopped;
}

// Idle reaper: kill dev servers unused past IDLE_TIMEOUT_MS.
function reap(): void {
  const now = Date.now();
  for (const p of [...procs.values()]) {
    if (now - p.lastUsedAt > IDLE_TIMEOUT_MS) killProc(p);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __wb_preview_reaper: ReturnType<typeof setInterval> | undefined;
}
if (!globalThis.__wb_preview_reaper) {
  globalThis.__wb_preview_reaper = setInterval(reap, 60_000);
  globalThis.__wb_preview_reaper.unref?.();
  const cleanup = () => { for (const p of [...procs.values()]) killProc(p); };
  process.once("exit", cleanup);
  process.once("SIGINT", () => { cleanup(); process.exit(0); });
  process.once("SIGTERM", () => { cleanup(); process.exit(0); });
}
