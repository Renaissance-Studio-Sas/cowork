// Claude-specific Chrome MCP wiring tools. chrome_connect and
// chrome_disconnect mutate the session's MCP server map via the
// AgentQuery's setMcpServers — that semantic is Claude SDK's
// "replace-the-whole-set" model. Gemini sessions don't get these (chrome
// support in gemini-cli-core is its own integration; see
// docs/gemini-runtime-parity.md).
//
// Registered ONLY when wrapping for Claude. Bundled into a regular MCP
// server (workbench-chrome) so they appear alongside the other workbench
// tools to the agent. Internally they re-include the static workbench MCPs
// in every setMcpServers call because Claude SDK's setMcpServers REPLACES
// the entire MCP map — if we passed only {"claude-in-chrome": ...} we'd
// silently unregister this very tool plus comments/email/session.

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { getSessionQuery } from "./sessions";
import {
  CLAUDE_BIN_PATH,
  getChromeSocketDir,
  listChromeSocketFiles,
  expectedProfileBySession,
} from "./chrome-bridge";
import { workbenchToolsAsClaudeMcp } from "./runtimes/claude-tool-adapter";
import { buildCommentsTools } from "./workbench-tools/comments";
import { buildEmailTools } from "./workbench-tools/email";
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
    "workbench-email": workbenchToolsAsClaudeMcp("workbench-email", buildEmailTools(sessionId)),
    "workbench-chrome": buildClaudeChromeMcp(sessionId, projectSlug, taskSlug),
  };
}

export function buildClaudeChromeMcp(
  sessionId: string,
  projectSlug: string,
  taskSlug: string,
): McpSdkServerConfigWithInstance {
  // We deliberately don't reuse buildStaticWorkbenchMcps for the inner
  // setMcpServers rebuild — that would create infinite recursion. Inline a
  // local builder that constructs everything EXCEPT this very MCP, then
  // re-adds it as a literal so the agent doesn't lose access to
  // chrome_connect/disconnect after they run.
  const baseStaticMcps = (): Record<string, McpSdkServerConfigWithInstance> => {
    const map = {
      "workbench-comments": workbenchToolsAsClaudeMcp("workbench-comments", buildCommentsTools(projectSlug, taskSlug)),
      "workbench-session": workbenchToolsAsClaudeMcp("workbench-session", buildSessionTools(sessionId, projectSlug, taskSlug)),
      "workbench-email": workbenchToolsAsClaudeMcp("workbench-email", buildEmailTools(sessionId)),
      "workbench-chrome": buildClaudeChromeMcp(sessionId, projectSlug, taskSlug),
    };
    return map;
  };

  return createSdkMcpServer({
    name: "workbench-chrome",
    version: "0.1.0",
    tools: [
      tool(
        "chrome_connect",
        `Wire the running Claude-in-Chrome bridge into THIS session's MCP map so
the agent can use the 17 Chrome MCP tools (navigate, tabs_context_mcp,
read_page, find, form_input, etc.). After this returns success the Chrome
tools (\`mcp__claude-in-chrome__*\`) are immediately callable in the same
turn — no need to end the turn first.

PREREQUISITE: a Chrome native-messaging socket must already be live. The
Claude extension auto-handshakes — no user click is needed — but the socket
only exists after Chrome has been opened to the reconnect URL in a profile
with the extension installed. Call chrome_open_profile first (it does that
launch + handshake under the hood). chrome_status will show whether the
socket is up.

If chrome_connect returns "Not connected" or "failed", the bridge isn't live
yet — call chrome_open_profile to spin one up, then retry. Do NOT instruct
the user to click anything; the handshake is automatic.`,
        {},
        async () => {
          const socketDir = getChromeSocketDir();
          const socketFiles = listChromeSocketFiles();
          if (socketFiles.length === 0) {
            return {
              content: [{
                type: "text",
                text: `Chrome native-messaging socket missing (no *.sock files in ${socketDir}). Spin one up by calling chrome_open_profile with the target profile_id — Chrome will launch a new window in that profile and the extension auto-handshakes (no user click). Wait ~2-3s, then call chrome_connect again. Do not instruct the user to click Connect; the extension claims the socket on its own.`,
              }],
              isError: true,
            };
          }

          const q = getSessionQuery(sessionId);
          if (!q) {
            return {
              content: [{ type: "text", text: `Session not found (id: ${sessionId}). The session may not be fully initialized yet.` }],
              isError: true,
            };
          }

          try {
            // Force a fresh MCP spawn: remove first (re-set with static-only)
            // then add (static + claude-in-chrome). A single setMcpServers
            // with the same config is a no-op — the SDK doesn't retry the
            // spawn — so we need this two-step.
            await q.setMcpServers(baseStaticMcps());
            const result = await q.setMcpServers({
              ...baseStaticMcps(),
              "claude-in-chrome": {
                type: "stdio" as const,
                command: CLAUDE_BIN_PATH,
                args: ["--claude-in-chrome-mcp"],
              },
            });

            if (result.errors && Object.keys(result.errors).length > 0) {
              const errorMsg = Object.values(result.errors)[0];
              return {
                content: [{ type: "text", text: `Failed to spawn Chrome MCP: ${errorMsg}\n\nCheck chrome_status — if socket is missing, call chrome_open_profile first.` }],
                isError: true,
              };
            }

            const statuses = await q.mcpServerStatus();
            const cic = statuses.find((s) => s.name === "claude-in-chrome");
            if (cic && cic.status === "connected") {
              return {
                content: [{ type: "text", text: `Chrome MCP wired (status: connected). Browser automation tools (navigate, tabs_context_mcp, read_page, …) are now available.` }],
              };
            }
            if (cic && cic.status === "failed") {
              return {
                content: [{ type: "text", text: `Chrome MCP added but failed to connect to the bridge. Run chrome_force_reset, then chrome_open_profile(profile_id), then chrome_connect again.` }],
                isError: true,
              };
            }
            return {
              content: [{ type: "text", text: `Chrome MCP wired (status: ${cic ? cic.status : "unknown"}). Wait briefly and call chrome_status to verify it reaches "connected".` }],
            };
          } catch (e) {
            return {
              content: [{ type: "text", text: `Error connecting Chrome MCP: ${e instanceof Error ? e.message : String(e)}` }],
              isError: true,
            };
          }
        },
      ),

      tool(
        "chrome_disconnect",
        `Disconnect Chrome browser automation from this session.
Use this to release the Chrome connection, for example before switching to a different Chrome profile.`,
        {},
        async () => {
          const q = getSessionQuery(sessionId);
          if (!q) {
            return {
              content: [{ type: "text", text: "Session not found." }],
              isError: true,
            };
          }

          try {
            const result = await q.setMcpServers(baseStaticMcps());
            expectedProfileBySession.delete(sessionId);

            if (result.removed.includes("claude-in-chrome")) {
              return { content: [{ type: "text", text: "Chrome MCP disconnected." }] };
            }
            return { content: [{ type: "text", text: "Chrome MCP was not connected." }] };
          } catch (e) {
            return {
              content: [{ type: "text", text: `Error disconnecting Chrome MCP: ${e instanceof Error ? e.message : String(e)}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
