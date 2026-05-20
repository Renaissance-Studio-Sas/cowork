// Claude-specific static MCP wiring.
//
// Defines buildStaticWorkbenchMcps which wraps static workbench tools
// (comments and session) as Claude-SDK-compatible MCP servers.

import {
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { workbenchToolsAsClaudeMcp } from "./runtimes/claude-tool-adapter";
import { buildCommentsTools } from "./workbench-tools/comments";
import { buildSessionTools } from "./workbench-tools/session";

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
  };
}
