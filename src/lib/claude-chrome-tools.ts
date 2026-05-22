// Claude-specific static MCP wiring.
//
// Defines buildStaticWorkbenchMcps which wraps static workbench tools
// (comments, session, user-input) as Claude-SDK-compatible MCP servers.

import {
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import path from "node:path";
import { workbenchToolsAsClaudeMcp } from "./runtimes/claude-tool-adapter";
import { buildCommentsTools } from "./workbench-tools/comments";
import { buildSessionTools } from "./workbench-tools/session";
import { buildUserInputTools } from "./workbench-tools/user-input";
import { buildPreviewTools } from "./workbench-tools/preview";
import { MONOREPO_DIR } from "./preview/manager";

// Lazy (not module-load) to avoid a circular-import TDZ on MONOREPO_DIR.
const previewEnabled = () => existsSync(path.join(MONOREPO_DIR, "apps"));

// Build the static workbench-MCP map for a session. Used both at session
// start (in sessions.ts) and inside chrome_connect/disconnect to re-include
// these whenever we call setMcpServers (REPLACE semantics).
export function buildStaticWorkbenchMcps(
  sessionId: string,
  projectSlug: string,
  taskSlug: string,
): Record<string, McpSdkServerConfigWithInstance> {
  return {
    "workbench-comments": workbenchToolsAsClaudeMcp("workbench-comments", buildCommentsTools(projectSlug, taskSlug)),
    "workbench-session": workbenchToolsAsClaudeMcp("workbench-session", buildSessionTools(sessionId, projectSlug, taskSlug)),
    "workbench-user-input": workbenchToolsAsClaudeMcp("workbench-user-input", buildUserInputTools(sessionId)),
    ...(previewEnabled()
      ? { "workbench-preview": workbenchToolsAsClaudeMcp("workbench-preview", buildPreviewTools(sessionId, projectSlug, taskSlug)) }
      : {}),
  };
}

// Name AskUserQuestion is aliased to inside the SDK's toolAliases option.
// Kept here so the aliasing site and the MCP registration agree on the
// concrete `mcp__<server>__<tool>` shape.
export const ASK_USER_QUESTION_ALIAS = "mcp__workbench-user-input__ask_user_question";
