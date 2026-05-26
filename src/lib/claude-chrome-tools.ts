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

// cloud-browser lives inside this repo at <repo>/cloud-browser/. Built artifact
// is dist/index.js (npm run build in cloud-browser/). Resolve from cwd so this
// works in dev and in any deploy where cowork is invoked from its repo root.
const CLOUD_BROWSER_BIN = path.join(process.cwd(), "cloud-browser", "dist", "index.js");

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

  // Wire cloud-browser only if it's been built. Skipping when missing keeps
  // session startup working in environments where the operator hasn't run
  // `npm --prefix cloud-browser run build` yet.
  if (existsSync(CLOUD_BROWSER_BIN)) {
    base["cloud-browser"] = {
      type: "stdio" as const,
      command: process.execPath, // current node binary
      args: [CLOUD_BROWSER_BIN],
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
