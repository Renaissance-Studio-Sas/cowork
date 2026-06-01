// Claude-specific static MCP wiring.
//
// Defines buildStaticWorkbenchMcps which wraps static workbench tools
// (comments, session, user-input) as Claude-SDK-compatible MCP servers, plus
// the cloud-browser MCP — now served by the platform's cloud-browser worker
// at https://app.rowads.studio/api/browser/mcp.
//
// Auth: the cloud-browser MCP endpoint is gated by the platform gateway.
// Locally we pass the same __gateway_session cookie that `rw auth login`
// drops into ~/.rw/credentials.json; for cloud-run cowork agents that
// receive an X-Platform-Token via env, we use that instead.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { workbenchToolsAsClaudeMcp } from "./runtimes/claude-tool-adapter";
import { buildCommentsTools } from "./workbench-tools/comments";
import { buildSessionTools } from "./workbench-tools/session";
import { buildUserInputTools } from "./workbench-tools/user-input";

const DEFAULT_GATEWAY = "https://app.rowads.studio";
const RW_CREDS_FILE = process.env.RW_CREDS_FILE ?? path.join(os.homedir(), ".rw", "credentials.json");
const RW_ENV = process.env.RW_ENV ?? "production";

interface RwCredentials {
  envs?: Record<string, { gateway?: string; cookie?: string; email?: string }>;
}

function resolveCloudBrowserUrl(): string {
  // Allow overrides for staging / local-dev hits against a different gateway.
  if (process.env.CLOUD_BROWSER_URL) return process.env.CLOUD_BROWSER_URL;
  const gateway = readRwEnv()?.gateway ?? DEFAULT_GATEWAY;
  return `${gateway.replace(/\/+$/, "")}/api/browser/mcp`;
}

function readRwEnv(): { gateway?: string; cookie?: string; email?: string } | null {
  try {
    const raw = fs.readFileSync(RW_CREDS_FILE, "utf8");
    const parsed = JSON.parse(raw) as RwCredentials;
    return parsed.envs?.[RW_ENV] ?? null;
  } catch {
    return null;
  }
}

function resolveCloudBrowserHeaders(): Record<string, string> {
  // Cloud-run cowork agents inject a platform token via env. Use it
  // verbatim — same header the gateway accepts from any internal caller.
  if (process.env.RW_PLATFORM_TOKEN) {
    return { "X-Platform-Token": process.env.RW_PLATFORM_TOKEN };
  }
  // Local cowork: read the cookie the rw CLI persisted at login.
  const env = readRwEnv();
  if (env?.cookie) {
    return { Cookie: `__gateway_session=${env.cookie}` };
  }
  // We deliberately don't throw — the Claude SDK will report the auth
  // error from the gateway when the agent first invokes a browser tool,
  // which is a clearer place to surface "run `rw auth login`" than a
  // session-start crash that masks the real problem.
  return {};
}

// Build the static workbench-MCP map for a session. Used both at session
// start (in sessions.ts) and inside chrome_connect/disconnect to re-include
// these whenever we call setMcpServers (REPLACE semantics).
export async function buildStaticWorkbenchMcps(
  sessionId: string,
  workspacePath: string[],
): Promise<Record<string, McpServerConfig>> {
  const base: Record<string, McpServerConfig> = {
    "workbench-comments": workbenchToolsAsClaudeMcp("workbench-comments", buildCommentsTools(workspacePath)),
    "workbench-session": workbenchToolsAsClaudeMcp("workbench-session", buildSessionTools(sessionId, workspacePath)),
    "workbench-user-input": workbenchToolsAsClaudeMcp("workbench-user-input", buildUserInputTools(sessionId)),
  };

  base["cloud-browser"] = {
    type: "http",
    url: resolveCloudBrowserUrl(),
    headers: resolveCloudBrowserHeaders(),
  };

  return base;
}

// Name AskUserQuestion is aliased to inside the SDK's toolAliases option.
// Kept here so the aliasing site and the MCP registration agree on the
// concrete `mcp__<server>__<tool>` shape.
export const ASK_USER_QUESTION_ALIAS = "mcp__workbench-user-input__ask_user_question";
