// Local Docker controller for the cloud agent runner.
//
// Listens on 127.0.0.1:8090 by default. Cowork's "remote" runtime calls this
// to provision a per-session container and to tear it down.
//
// Env:
//   PORT                  default 8090
//   AGENT_CONTROLLER_TOKEN if set, required as Bearer on every request
//                          (CONTROLLER_TOKEN also accepted as a fallback so
//                          older scripts keep working)
//   DOCKER_IMAGE          default "rowads-agent-runner:latest"
//   WORKSPACE_DIR         host path bind-mounted into containers as /workspace.
//                          default $HOME/git/rowads-automation
//   RUNNER_HOME_DIR       host path bind-mounted as /root (so OAuth +
//                          conversation history persist across container
//                          restarts). default $HOME/.rowads-agent/runner-home
//   RUNNER_CLAUDE_DIR     host path bind-mounted as /root/.claude when set.
//                          default: $HOME/.claude (laptop's existing OAuth)
//   IDLE_TIMEOUT_MS       forwarded to the runner. default 900000
//
// Surface (matches design.html § "Session controller"):
//   GET    /v1/health
//   POST   /v1/sessions       { user, project, task, cli? }  ->
//                              { session_id, container_id, runner_url, runner_token }
//   GET    /v1/sessions
//   DELETE /v1/sessions/:id

import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT ?? "8090", 10);
const TOKEN = process.env.AGENT_CONTROLLER_TOKEN ?? process.env.CONTROLLER_TOKEN ?? "";
const IMAGE = process.env.DOCKER_IMAGE ?? "rowads-agent-runner:latest";
const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? path.join(os.homedir(), "git/rowads-automation");
// Runner src bind-mounted over the image's /opt/runner/src so edits on host
// take effect on next container start without rebuilding. Defaults to the
// sibling runner/ folder in this repo (cloud-agent-runner lives alongside
// cowork's app code).
const RUNNER_SRC_DIR = process.env.RUNNER_SRC_DIR ?? path.resolve(__dirname, "../../runner/src");
const RUNNER_HOME_DIR = process.env.RUNNER_HOME_DIR ?? path.join(os.homedir(), ".rowads-agent/runner-home");
const RUNNER_CLAUDE_DIR = process.env.RUNNER_CLAUDE_DIR ?? path.join(os.homedir(), ".claude");
const IDLE_TIMEOUT_MS = process.env.IDLE_TIMEOUT_MS ?? String(15 * 60 * 1000);

// In-memory session table. Persisted only in docker — on controller restart we
// reconcile against `docker ps` (see reconcile()).
const sessions = new Map();

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": buf.length,
  });
  res.end(buf);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function runDocker(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    p.stdout.on("data", (c) => out.push(c));
    p.stderr.on("data", (c) => err.push(c));
    p.on("error", reject);
    p.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (code !== 0) {
        const e = new Error(`docker ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
        e.stdout = stdout; e.stderr = stderr; e.code = code;
        return reject(e);
      }
      resolve({ stdout, stderr });
    });
    if (input) { p.stdin.write(input); p.stdin.end(); }
  });
}

async function dockerInspect(id) {
  const { stdout } = await runDocker(["inspect", id]);
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

async function waitForHealthy(url, token, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (r.ok) return;
      lastErr = new Error(`status ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`runner did not become healthy: ${lastErr?.message ?? "unknown"}`);
}

async function ensureDir(p) {
  try { await fs.mkdir(p, { recursive: true }); } catch { /* ok */ }
}

async function createSession(body) {
  if (!body.user) throw new Error("missing field: user");

  const sessionId = randomUUID();
  const runnerToken = randomBytes(32).toString("hex");
  const containerName = `rowads-agent-${sessionId.slice(0, 8)}`;

  // Per-user runner home so OAuth + Claude history persist between containers.
  // For MVP we share one runner-home across all sessions of the same user.
  const userHome = path.join(RUNNER_HOME_DIR, body.user);
  await ensureDir(userHome);

  const env = {
    RUNNER_TOKEN: runnerToken,
    IDLE_TIMEOUT_MS,
    WORKSPACE_DIR: "/workspace",
    USER_TAG: body.user,
  };
  // Forward Anthropic auth if the controller has it; otherwise the runner
  // relies on whatever's mounted into /root/.claude (laptop OAuth).
  for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    if (process.env[key]) env[key] = process.env[key];
  }

  const dockerArgs = ["run", "-d", "--name", containerName, "--rm",
    "--label", "rowads.runner=1",
    "--label", `rowads.session=${sessionId}`,
    "--label", `rowads.user=${body.user}`,
    "-p", "127.0.0.1::8080",
    "-v", `${WORKSPACE_DIR}:/workspace`,
    "-v", `${userHome}:/home/agent`,
  ];
  // Dev iteration: bind-mount the runner's src/ over the image's
  // /opt/runner/src so code edits take effect on container start without
  // rebuilding the image. node_modules stays in /opt/runner/ (linux binaries
  // built at image time). Skip if the host path doesn't exist — protects
  // against running an older controller without the runner code locally.
  try {
    await fs.access(RUNNER_SRC_DIR);
    dockerArgs.push("-v", `${RUNNER_SRC_DIR}:/opt/runner/src:ro`);
  } catch { /* no live src, image's src wins */ }
  // Mount the laptop's ~/.claude if it exists so the container inherits
  // history + skills. OAuth credentials live in the macOS keychain (not in
  // ~/.claude), so we also pass CLAUDE_CODE_OAUTH_TOKEN below — see env.
  try {
    await fs.access(RUNNER_CLAUDE_DIR);
    dockerArgs.push("-v", `${RUNNER_CLAUDE_DIR}:/home/agent/.claude`);
  } catch { /* no laptop .claude, skip */ }
  // Also mount ~/.claude.json (the standalone config file at $HOME, separate
  // from the ~/.claude directory). The Claude CLI requires this file to exist
  // before any subcommand — `claude setup-token` silently loops on "config
  // file not found" without it, blocking the inline /login flow. Mount it
  // read-write so a successful setup-token write-back persists for the next
  // container.
  const hostClaudeJson = path.join(os.homedir(), ".claude.json");
  try {
    await fs.access(hostClaudeJson);
    dockerArgs.push("-v", `${hostClaudeJson}:/home/agent/.claude.json`);
  } catch { /* host has none yet, skip — setup-token will create one */ }

  for (const [k, v] of Object.entries(env)) {
    dockerArgs.push("-e", `${k}=${v}`);
  }
  dockerArgs.push(IMAGE);

  const { stdout } = await runDocker(dockerArgs);
  const containerId = stdout.trim();

  // Inspect to find the host port docker assigned.
  let hostPort;
  for (let i = 0; i < 50; i++) {
    const info = await dockerInspect(containerId);
    const bind = info?.NetworkSettings?.Ports?.["8080/tcp"]?.[0];
    if (bind?.HostPort) { hostPort = parseInt(bind.HostPort, 10); break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!hostPort) {
    // Best-effort cleanup before bubbling up.
    try { await runDocker(["stop", containerId]); } catch { /* ignore */ }
    throw new Error("docker did not publish a host port");
  }

  const runnerUrl = `http://127.0.0.1:${hostPort}`;
  try {
    await waitForHealthy(runnerUrl, runnerToken);
  } catch (e) {
    try { await runDocker(["stop", containerId]); } catch { /* ignore */ }
    throw e;
  }

  const record = {
    session_id: sessionId,
    container_id: containerId,
    container_name: containerName,
    runner_url: runnerUrl,
    runner_token: runnerToken,
    user: body.user,
    project: body.project ?? null,
    task: body.task ?? null,
    cli: body.cli ?? "claude",
    created_at: new Date().toISOString(),
  };
  sessions.set(sessionId, record);
  return record;
}

async function stopSession(id) {
  const s = sessions.get(id);
  sessions.delete(id);
  if (!s) return;
  try { await runDocker(["stop", "--time", "10", s.container_id]); } catch { /* container may already be gone */ }
}

// Reconcile in-memory sessions against `docker ps`. Drops entries whose
// container is no longer running.
async function reconcile() {
  let stdout;
  try {
    ({ stdout } = await runDocker([
      "ps", "--filter", "label=rowads.runner=1",
      "--format", "{{.ID}}\t{{.Label \"rowads.session\"}}",
    ]));
  } catch (e) {
    console.error("[controller] reconcile failed:", e.message);
    return;
  }
  const live = new Set();
  for (const line of stdout.split("\n")) {
    const [, sessionId] = line.split("\t");
    if (sessionId) live.add(sessionId);
  }
  for (const id of [...sessions.keys()]) {
    if (!live.has(id)) {
      console.log(`[controller] reaping session ${id} (container gone)`);
      sessions.delete(id);
    }
  }
}

const ROUTES = [
  { method: "GET", re: /^\/v1\/health$/, handler: async (_req, res) => {
    let dockerOk = true;
    let dockerErr = null;
    try { await runDocker(["version", "--format", "{{.Server.Version}}"]); }
    catch (e) { dockerOk = false; dockerErr = e.message; }
    json(res, 200, {
      ok: dockerOk,
      docker_error: dockerErr,
      image: IMAGE,
      workspace: WORKSPACE_DIR,
      sessions: sessions.size,
    });
  }},
  { method: "POST", re: /^\/v1\/sessions$/, handler: async (req, res) => {
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: "invalid json" }); }
    try {
      const record = await createSession(body);
      json(res, 200, {
        session_id: record.session_id,
        container_id: record.container_id,
        runner_url: record.runner_url,
        runner_token: record.runner_token,
      });
    } catch (e) {
      console.error("[controller] createSession failed:", e.message);
      json(res, 500, { error: e.message });
    }
  }},
  { method: "GET", re: /^\/v1\/sessions$/, handler: async (_req, res) => {
    json(res, 200, {
      sessions: [...sessions.values()].map((s) => ({
        session_id: s.session_id,
        container_id: s.container_id,
        runner_url: s.runner_url,
        user: s.user,
        project: s.project,
        task: s.task,
        cli: s.cli,
        created_at: s.created_at,
      })),
    });
  }},
  { method: "DELETE", re: /^\/v1\/sessions\/([^/]+)$/, handler: async (_req, res, m) => {
    await stopSession(m[1]);
    res.writeHead(204); res.end();
  }},
];

const server = http.createServer(async (req, res) => {
  if (TOKEN) {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${TOKEN}`) return json(res, 401, { error: "unauthorized" });
  }
  const url = new URL(req.url ?? "/", "http://x");
  for (const r of ROUTES) {
    const m = url.pathname.match(r.re);
    if (m && req.method === r.method) {
      try { return await r.handler(req, res, m); }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[controller] handler error:", msg);
        return json(res, 500, { error: msg });
      }
    }
  }
  json(res, 404, { error: "not found" });
});

// Only bind localhost — this controller is a local-dev daemon, not a public
// service. Production cloud deploy would bind 0.0.0.0 + put auth in front.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[controller] listening on 127.0.0.1:${PORT}`);
  console.log(`[controller] image=${IMAGE} workspace=${WORKSPACE_DIR}`);
});

setInterval(reconcile, 60_000).unref();

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    console.log(`[controller] received ${sig}`);
    server.close();
    // Stop all containers we provisioned so the laptop doesn't accumulate
    // orphaned runners.
    await Promise.all([...sessions.keys()].map((id) => stopSession(id).catch(() => {})));
    process.exit(0);
  });
}
