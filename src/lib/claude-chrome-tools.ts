// Claude-specific static MCP wiring.
//
// Defines buildStaticWorkbenchMcps which wraps static workbench tools
// (comments, session, user-input) as Claude-SDK-compatible MCP servers,
// plus the cloud-browser MCP (Chromium-in-Docker per profile).
//
// cloud-browser runs as a local HTTP daemon (Streamable HTTP) on 127.0.0.1:7400
// by default. One daemon per machine, owned by no single cowork session — this
// lets profile state survive cowork restarts and prevents two parallel agents
// from each spawning their own Chrome container for the same profile.

import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import {
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { workbenchToolsAsClaudeMcp } from "./runtimes/claude-tool-adapter";
import { buildCommentsTools } from "./workbench-tools/comments";
import { buildSessionTools } from "./workbench-tools/session";
import { buildUserInputTools } from "./workbench-tools/user-input";

const CLOUD_BROWSER_HOST = process.env.CLOUD_BROWSER_HTTP_HOST ?? "127.0.0.1";
const CLOUD_BROWSER_PORT = Number(process.env.CLOUD_BROWSER_HTTP_PORT ?? "7400");
const CLOUD_BROWSER_URL = `http://${CLOUD_BROWSER_HOST}:${CLOUD_BROWSER_PORT}/mcp`;
const CLOUD_BROWSER_HEALTH = `http://${CLOUD_BROWSER_HOST}:${CLOUD_BROWSER_PORT}/health`;

// cloud-browser lives inside this repo at <repo>/cloud-browser/. We auto-spawn
// it the first time a session starts if no daemon is responding. Prefer the
// tsx + src/index.ts launcher when available (dev mode — edits land without
// `npm run build`); fall back to the compiled dist/index.js for deploys.
const CLOUD_BROWSER_DIR = path.join(process.cwd(), "cloud-browser");
const CLOUD_BROWSER_TSX = path.join(CLOUD_BROWSER_DIR, "node_modules", ".bin", "tsx");
const CLOUD_BROWSER_SRC = path.join(CLOUD_BROWSER_DIR, "src", "index.ts");
const CLOUD_BROWSER_BIN = path.join(CLOUD_BROWSER_DIR, "dist", "index.js");

function resolveCloudBrowserLaunch():
  | { command: string; args: string[] }
  | null {
  if (existsSync(CLOUD_BROWSER_TSX) && existsSync(CLOUD_BROWSER_SRC)) {
    return { command: CLOUD_BROWSER_TSX, args: [CLOUD_BROWSER_SRC] };
  }
  if (existsSync(CLOUD_BROWSER_BIN)) {
    return { command: process.execPath, args: [CLOUD_BROWSER_BIN] };
  }
  return null;
}

async function isDaemonUp(): Promise<boolean> {
  try {
    const res = await fetch(CLOUD_BROWSER_HEALTH, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Best-effort: if the daemon isn't responding, spawn it detached so it
// survives this cowork process exiting. Poll /health for up to ~3s.
// On failure we return without throwing — the Claude SDK will surface the
// connect error to the user, and a follow-up session can retry.
let spawnAttempted = false;
async function ensureDaemon(): Promise<void> {
  if (await isDaemonUp()) return;
  if (spawnAttempted) return;
  spawnAttempted = true;

  const launch = resolveCloudBrowserLaunch();
  if (!launch) {
    console.warn(`[cloud-browser] daemon not running and no launcher found at ${CLOUD_BROWSER_DIR}`);
    return;
  }

  console.log(`[cloud-browser] auto-spawning daemon: ${launch.command} ${launch.args.join(" ")}`);
  const child = spawn(launch.command, launch.args, {
    cwd: CLOUD_BROWSER_DIR,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      SKIP_R2: process.env.R2_BUCKET ? "false" : "true",
    },
  });
  child.unref();
  if (child.pid != null) {
    console.log(`[cloud-browser] daemon pid: ${child.pid}`);
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await isDaemonUp()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.warn("[cloud-browser] daemon did not respond on /health within 5s; continuing anyway");
}

// Build the static workbench-MCP map for a session. Used both at session
// start (in sessions.ts) and inside chrome_connect/disconnect to re-include
// these whenever we call setMcpServers (REPLACE semantics).
export async function buildStaticWorkbenchMcps(
  sessionId: string,
  projectSlug: string,
  taskSlug: string,
): Promise<Record<string, McpServerConfig>> {
  const base: Record<string, McpServerConfig> = {
    "workbench-comments": workbenchToolsAsClaudeMcp("workbench-comments", buildCommentsTools(projectSlug, taskSlug)),
    "workbench-session": workbenchToolsAsClaudeMcp("workbench-session", buildSessionTools(sessionId, projectSlug, taskSlug)),
    "workbench-user-input": workbenchToolsAsClaudeMcp("workbench-user-input", buildUserInputTools(sessionId)),
  };

  // Auto-spawn the cloud-browser daemon if it's not already running, then
  // hand the Claude SDK an HTTP MCP config pointing at it.
  await ensureDaemon();
  base["cloud-browser"] = {
    type: "http",
    url: CLOUD_BROWSER_URL,
  };

  return base;
}

// Name AskUserQuestion is aliased to inside the SDK's toolAliases option.
// Kept here so the aliasing site and the MCP registration agree on the
// concrete `mcp__<server>__<tool>` shape.
export const ASK_USER_QUESTION_ALIAS = "mcp__workbench-user-input__ask_user_question";
