// Workbench tools for session + Chrome-bridge management. These are
// runtime-agnostic — they inspect machine state, manage the chrome
// native-messaging socket, and rename the session. The two Claude-specific
// tools (chrome_connect / chrome_disconnect) that mutate the MCP server map
// live separately in src/lib/claude-chrome-tools.ts.

import { z } from "zod";
import { existsSync } from "fs";
import path from "path";
import { execSync } from "child_process";
import { renameLiveSession, getSessionQuery, getSession, debugSessionRegistry, addPendingCompletion } from "../sessions";
import {
  getChromeSocketDir,
  listChromeSocketFiles,
  findNativeHostPids,
  readChromeLocalState,
  listChromeProfiles,
  openChromeReconnectPage,
  CLAUDE_BIN_PATH,
} from "../chrome-bridge";
import { buildStaticWorkbenchMcps } from "../claude-chrome-tools";
import { defineTool, type WorkbenchTool } from "./types";

export function buildSessionTools(
  sessionId: string,
  _projectSlug: string,
  _taskSlug: string,
): WorkbenchTool[] {
  return [
    defineTool(
      "set_session_title",
      `Override the session title shown in the cowork sidebar. The workbench
auto-titles each session from turn 1, so you usually do nothing — call this
only when you want a different title than the auto-generated one (e.g. the
focus of the session shifted, or the auto-title misses the point).`,
      { title: z.string().min(1).max(60).describe("Short descriptive title (3-6 words)") },
      async ({ title }) => {
        const ok = await renameLiveSession(sessionId, title);
        if (!ok) {
          return {
            content: [{ type: "text", text: "Failed to set session title (session not found)." }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: `Session title set to: "${title}"` }] };
      },
      { alwaysLoad: true },
    ),

    defineTool(
      "open_artifact",
      `Open a file artifact in the user's artifact panel — switches the preview
to the named file so the user sees it right now without clicking. Use after
saving a file you want the user to look at immediately (a freshly-generated
report, a live-view page, a screenshot they should review). Quiet no-op if
the user isn't viewing this session's workspace.`,
      {
        path: z
          .string()
          .min(1)
          .describe(
            `Artifact path relative to the task's files/ directory, e.g. "browser-foo.html" or "reports/summary.md".`,
          ),
      },
      async ({ path: artifactPath }) => {
        const s = getSession(sessionId);
        if (!s) {
          return {
            content: [{ type: "text", text: `Session ${sessionId} not found.` }],
            isError: true,
          };
        }
        s.events.emit("open_artifact", { path: artifactPath });
        return { content: [{ type: "text", text: `Opened "${artifactPath}" in the artifact panel.` }] };
      },
    ),

    defineTool(
      "suggest_session_complete",
      `Suggest that this session is complete and the work is done. The UI surfaces
an Approve / Dismiss card to the human — the tool waits for their decision and
returns either "approved" (session is now marked complete in the workspace) or
"dismissed" (continue working). Call this when you're confident the task is
finished; the human stays in control of the final mark. If the human later
sends another message, the completion is cleared automatically.`,
      {
        reason: z.string().max(200).optional().describe(
          "Optional one-line summary of what was accomplished (shown to the human in the approval card).",
        ),
      },
      async ({ reason }) => {
        const parked = addPendingCompletion(sessionId, reason);
        if (!parked) {
          return {
            content: [{ type: "text", text: "Failed to park completion suggestion (session not found)." }],
            isError: true,
          };
        }
        const approved = await parked.promise;
        return {
          content: [{
            type: "text",
            text: approved
              ? "Session marked complete by the human. Stop here unless they send more work."
              : "Human dismissed the completion suggestion — keep working.",
          }],
        };
      },
      { alwaysLoad: true },
    ),

    defineTool(
      "chrome_debug_session",
      `Debug tool to check if this session is properly registered. Returns session ID, whether it's found in registry, and whether it has a Query object.`,
      {},
      async () => {
        const debug = debugSessionRegistry(sessionId);
        return {
          content: [{
            type: "text",
            text: `Session ID: ${sessionId}\nFound in registry: ${debug.found}\nHas Query object: ${debug.hasQuery}\nAll registered sessions: ${debug.allIds.join(", ") || "none"}`,
          }],
        };
      },
    ),

    defineTool(
      "chrome_list_profiles",
      `List all Chrome profiles on this machine and their Claude extension status.
Use this to see which profiles have the Claude extension installed and can be used for browser automation.
Returns profile ID, display name, email, and whether the extension is installed.`,
      {},
      async () => {
        const profiles = listChromeProfiles();
        if (profiles.length === 0) {
          return { content: [{ type: "text", text: "No Chrome profiles found. Is Google Chrome installed?" }] };
        }
        const lines = profiles.map((p) =>
          `- ${p.id}: ${p.name} (${p.email}) ${p.hasExtension ? "✅ Extension installed" : "❌ No extension"}`,
        );
        return { content: [{ type: "text", text: `Chrome profiles:\n${lines.join("\n")}` }] };
      },
    ),

    defineTool(
      "chrome_reconnect",
      `Open the Claude reconnect URL in whatever Chrome profile is currently
focused (no profile control). The extension auto-handshakes — no click. Use
chrome_open_profile when you need to target a specific profile, which is
almost always; this no-target variant is only useful when there's already
exactly one extension-enabled profile open and you don't care which.`,
      {},
      async () => {
        const opened = openChromeReconnectPage();
        if (!opened) {
          return {
            content: [{ type: "text", text: "Failed to open Chrome reconnect page. Try chrome_open_profile with an explicit profile_id." }],
            isError: true,
          };
        }
        return {
          content: [{
            type: "text",
            text: `Chrome reconnect URL opened in the focused profile. The extension auto-handshakes — wait ~2-3s, then call chrome_status. If the socket is still missing, use chrome_open_profile(profile_id) instead to target a specific profile reliably.`,
          }],
        };
      },
    ),

    defineTool(
      "chrome_open_profile",
      `Open a new Chrome window in a specific profile, pointed at the Claude
reconnect URL. Wakes up the target profile's extension service worker if
it's been dormant. The launched tab flashes open + closes on its own
within ~2-3 seconds; that flash IS the success path.

This does NOT bind the MCP bridge to the requested profile — the bridge's
choice of which extension instance to route to is decided separately. The
canonical flow is:

  1. chrome_connect                  (wire MCP into the session)
  2. list_connected_browsers         (see all signed-in extension instances)
  3. select_browser(deviceId)        (pin the bridge to one)

Use chrome_open_profile only as a fallback when list_connected_browsers
doesn't return the target — i.e., the profile's Chrome window is closed
and its extension has gone dormant. Otherwise skip it.

Implementation: invokes the Chrome binary directly with --profile-directory
+ --new-window so the profile flag is respected even when Chrome is
already running.`,
      {
        profile_id: z.string().describe('The Chrome profile ID (e.g., "Default" or "Profile 1"). Use chrome_list_profiles to see available IDs.'),
      },
      async ({ profile_id }) => {
        const profiles = listChromeProfiles();
        const profile = profiles.find((p) => p.id === profile_id);

        if (!profile) {
          const available = profiles.map((p) => p.id).join(", ");
          return {
            content: [{ type: "text", text: `Profile "${profile_id}" not found. Available profiles: ${available || "none"}` }],
            isError: true,
          };
        }

        if (!profile.hasExtension) {
          return {
            content: [{ type: "text", text: `Profile "${profile_id}" (${profile.name}) does not have the Claude extension installed.\nInstall it from: https://claude.ai/chrome` }],
            isError: true,
          };
        }

        const opened = openChromeReconnectPage(profile_id);
        if (!opened) {
          return {
            content: [{ type: "text", text: `Failed to open Chrome with profile "${profile_id}".` }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text",
            text: `Opened a Chrome window in profile "${profile.name}" (${profile.email}). The extension auto-handshakes silently — the launched tab closes on its own within a few seconds. To actually bind the bridge to this profile's extension, call list_connected_browsers and then select_browser(deviceId) — do not assume this open succeeded in routing.`,
          }],
        };
      },
    ),

    defineTool(
      "chrome_status",
      `Report bridge plumbing state — socket files, native-host processes,
which Chrome profiles have windows open, and whether the MCP is wired into
this session.

This does NOT report which Chrome extension instance the bridge is
currently routing to. That state lives inside the running
claude-in-chrome-mcp process and is not queryable from outside. To see the
truth, call list_connected_browsers (returns deviceId + name for every
connected extension) and then select_browser(deviceId) to pin the bridge
to a specific one.`,
      {},
      async () => {
        const socketDir = getChromeSocketDir();
        const socketFiles = listChromeSocketFiles();
        const socketExists = socketFiles.length > 0;
        const nativeHostPids = findNativeHostPids();
        const localState = readChromeLocalState();
        const profiles = listChromeProfiles();
        const profileById = new Map(profiles.map((p) => [p.id, p]));

        const lines: string[] = [];

        if (socketExists && nativeHostPids.length > 0) {
          lines.push(`Bridge plumbing: ✅ socket present, native-host running`);
        } else {
          lines.push(`Bridge plumbing: ❌ no socket / no native-host`);
          lines.push(`  Open a Chrome window in a profile with the Claude extension, or call chrome_open_profile(profile_id).`);
        }
        lines.push(`  socket dir: ${existsSync(socketDir) ? "present" : "missing"} (${socketDir})`);
        lines.push(`  .sock files: ${socketFiles.length > 0 ? `${socketFiles.length} (${socketFiles.join(", ")})` : "none"}`);
        lines.push(`  native-host PIDs: ${nativeHostPids.length > 0 ? nativeHostPids.join(", ") : "none"}`);

        const fmtProfile = (id: string) => {
          const p = profileById.get(id);
          return p ? `"${p.name}" — ${p.email} (id: ${id})` : id;
        };

        lines.push(``, `Chrome windows (from Chrome's Local State, not the bridge):`);
        if (localState.lastUsed) {
          lines.push(`  last-focused: ${fmtProfile(localState.lastUsed)}`);
        }
        if (localState.lastActive.length > 0) {
          lines.push(`  currently open: ${localState.lastActive.map(fmtProfile).join(", ")}`);
        }

        lines.push(``, `Session MCP:`);
        const q = getSessionQuery(sessionId);
        if (!q) {
          lines.push(`  ⚠ session not found in registry (id: ${sessionId})`);
          return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
        }
        try {
          const statuses = await q.mcpServerStatus();
          const chromeStatus = statuses.find((s) => s.name === "claude-in-chrome");
          if (!chromeStatus) {
            lines.push(`  claude-in-chrome: not wired yet — call chrome_connect`);
          } else {
            const label = ({
              connected: "✅ wired and connected",
              failed: "❌ failed — call chrome_force_reset, then chrome_open_profile",
              "needs-auth": "⏳ handshake in progress — wait ~2s and re-check",
              pending: "⏳ pending",
              disabled: "⏸ disabled",
            } as Record<string, string>)[chromeStatus.status] || chromeStatus.status;
            lines.push(`  claude-in-chrome: ${label}`);
          }
        } catch (e) {
          lines.push(`  error querying MCP status: ${e instanceof Error ? e.message : String(e)}`);
        }

        lines.push(
          ``,
          `To know which Chrome extension instance the bridge is talking to,`,
          `call list_connected_browsers. To pin it, call select_browser(deviceId).`,
        );

        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    ),

    defineTool(
      "chrome_force_reset",
      `SIGTERM every --chrome-native-host process, remove every .sock file in
the bridge directory, and clear all session profile bindings. Disrupts any
concurrent cowork session using Chrome — by design, since the SDK reads all
socks into one pool and a stale sock from a dead profile causes non-tabId
tool calls (notably tabs_create_mcp) to land in the wrong profile.

After this, call chrome_open_profile(profile_id) to spin a fresh handshake,
then chrome_connect.`,
      {},
      async () => {
        const pids = findNativeHostPids();
        const killed: number[] = [];
        for (const pid of pids) {
          try {
            process.kill(pid, "SIGTERM");
            killed.push(pid);
          } catch { /* already gone */ }
        }
        const socketDir = getChromeSocketDir();
        let socketsRemoved = 0;
        try {
          for (const f of listChromeSocketFiles()) {
            execSync(`rm -f "${path.join(socketDir, f)}"`, { stdio: "ignore" });
            socketsRemoved++;
          }
        } catch { /* ignore */ }

        return {
          content: [{
            type: "text",
            text: [
              `Chrome bridge nuked:`,
              `  Killed ${killed.length} native-host process(es): ${killed.join(", ") || "none"}`,
              `  Removed ${socketsRemoved} .sock file(s)`,
              ``,
              `Next: chrome_connect, then list_connected_browsers + select_browser(deviceId).`,
            ].join("\n"),
          }],
        };
      },
    ),

    defineTool(
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
          const baseMcps = await buildStaticWorkbenchMcps(sessionId, _projectSlug, _taskSlug);
          await q.setMcpServers(baseMcps);
          const result = await q.setMcpServers({
            ...baseMcps,
            "claude-in-chrome": {
              type: "stdio" as const,
              command: CLAUDE_BIN_PATH,
              args: ["--claude-in-chrome-mcp"],
            },
          });

          if (result.errors && Object.keys(result.errors).length > 0) {
            const errorMsg = Object.values(result.errors)[0];
            return {
              content: [{ type: "text", text: `Failed to spawn Chrome MCP: ${errorMsg}\\n\\nCheck chrome_status — if socket is missing, call chrome_open_profile first.` }],
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
      }
    ),

    defineTool(
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
          const result = await q.setMcpServers(await buildStaticWorkbenchMcps(sessionId, _projectSlug, _taskSlug));

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
      }
    ),
  ];
}
