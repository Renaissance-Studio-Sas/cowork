// In-process MCP server that lets the agent manage its own session.
// Provides tools for the agent to set a descriptive session name.

import { tool, createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { renameLiveSession } from "./sessions";

export function buildSessionMcp(sessionId: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "workbench-session",
    version: "0.1.0",
    tools: [
      tool(
        "set_session_title",
        `Set a short, descriptive title for this session that summarizes what was accomplished.
Call this ONCE at the START of your work, in your first response to the user's request.
The title should be 3-6 words that capture the main outcome, like:
- "Added dark mode toggle"
- "Fixed login validation bug"
- "Refactored auth middleware"
- "Created user settings page"
Do NOT include filler words like "Implemented", "Updated", "Changed" unless necessary for clarity.`,
        { title: z.string().min(1).max(60).describe("Short descriptive title (3-6 words)") },
        async ({ title }) => {
          const ok = await renameLiveSession(sessionId, title);
          if (!ok) {
            return {
              content: [{ type: "text", text: "Failed to set session title (session not found)." }],
              isError: true,
            };
          }
          return {
            content: [{ type: "text", text: `Session title set to: "${title}"` }],
          };
        },
      ),
    ],
  });
}
