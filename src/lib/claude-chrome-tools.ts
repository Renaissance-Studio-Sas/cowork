// Claude-specific static MCP wiring.
//
// Defines buildStaticWorkbenchMcps which wraps static workbench tools
// (comments, session, user-input) as Claude-SDK-compatible MCP servers,
// plus the stdio cloud-browser MCP (Chromium-in-Docker per profile).

import path from "path";
import { existsSync } from "fs";
import {
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { workbenchToolsAsClaudeMcp } from "./runtimes/claude-tool-adapter";
import { buildCommentsTools } from "./workbench-tools/comments";
import { buildSessionTools } from "./workbench-tools/session";
import { buildUserInputTools } from "./workbench-tools/user-input";

// cloud-browser lives inside this repo at <repo>/cloud-browser/. Resolve from
// cwd so this works in dev and in any deploy where cowork is invoked from its
// repo root.
//
// Launcher prefers tsx + src/index.ts when both are available (dev mode): each
// new session spawns an MCP server reading current source, so edits land
// without `npm run build`. Falls back to the compiled dist/index.js when src
// or tsx aren't there (deploys with only the build artifact).
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

// Build the static workbench-MCP map for a session. Used both at session
// start (in sessions.ts) and inside chrome_connect/disconnect to re-include
// these whenever we call setMcpServers (REPLACE semantics).
export function buildStaticWorkbenchMcps(
  sessionId: string,
  projectSlug: string,
  taskSlug: string,
): Record<string, McpServerConfig> {
  const base: Record<string, McpServerConfig> = {
    "workbench-comments": workbenchToolsAsClaudeMcp("workbench-comments", buildCommentsTools(projectSlug, taskSlug)),
    "workbench-session": workbenchToolsAsClaudeMcp("workbench-session", buildSessionTools(sessionId, projectSlug, taskSlug)),
    "workbench-user-input": workbenchToolsAsClaudeMcp("workbench-user-input", buildUserInputTools(sessionId)),
  };

  // Wire cloud-browser only if a launcher is resolvable (src+tsx in dev, or
  // built dist in deploy). Skipping when missing keeps session startup working
  // in environments where neither is present yet.
  const launch = resolveCloudBrowserLaunch();
  if (launch) {
    base["cloud-browser"] = {
      type: "stdio" as const,
      command: launch.command,
      args: launch.args,
      env: {
        ...process.env,
        // Default to SKIP_R2=true unless the operator set R2 creds. Per-task
        // overrides go via cowork's own env when set.
        SKIP_R2: process.env.R2_BUCKET ? "false" : "true",
      } as Record<string, string>,
    };
  }

  return base;
}

// Name AskUserQuestion is aliased to inside the SDK's toolAliases option.
// Kept here so the aliasing site and the MCP registration agree on the
// concrete `mcp__<server>__<tool>` shape.
export const ASK_USER_QUESTION_ALIAS = "mcp__workbench-user-input__ask_user_question";
