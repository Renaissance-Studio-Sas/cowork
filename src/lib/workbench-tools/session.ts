// Workbench tools for session + Chrome-bridge management. These are
// runtime-agnostic — they inspect machine state, manage the chrome
// native-messaging socket, and rename the session. The two Claude-specific
// tools (chrome_connect / chrome_disconnect) that mutate the MCP server map
// live separately in src/lib/claude-chrome-tools.ts.

import { z } from "zod";
import { existsSync } from "fs";
import path from "path";
import { execSync } from "child_process";
import { renameLiveSession, getSessionQuery, debugSessionRegistry } from "../sessions";
import {
  getChromeSocketDir,
  listChromeSocketFiles,
  findNativeHostPids,
  readChromeLocalState,
  listChromeProfiles,
  openChromeReconnectPage,
  expectedProfileBySession,
  lastBoundProfile,
  setLastBoundProfile,
} from "../chrome-bridge";
import { defineTool, type WorkbenchTool } from "./types";

export function buildSessionTools(
  sessionId: string,
  _projectSlug: string,
  _taskSlug: string,
): WorkbenchTool[] {
  return [
    defineTool(
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
        return { content: [{ type: "text", text: `Session title set to: "${title}"` }] };
      },
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
reconnect URL. The extension in that profile auto-handshakes silently — there
is no Connect button and the user does not need to click anything. The
launched tab will flash open and close on its own within ~2-3 seconds; that
flash IS the success path.

Implementation note: this invokes the Chrome binary directly with
--profile-directory + --new-window so the profile flag is respected even
when Chrome is already running (macOS \`open -a\` silently routes the URL
to whatever window is focused).

After calling this, wait briefly then call chrome_connect to wire the
freshly-established bridge into this session's MCP map. Use chrome_status
to verify the socket appeared.`,
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

        // Track for this session + globally (the socket is single across all
        // sessions; last opened profile owns it). See
        // docs/chrome-mcp-per-session.md for the per-session isolation gap.
        expectedProfileBySession.set(sessionId, { id: profile_id, email: profile.email });
        setLastBoundProfile({ id: profile_id, name: profile.name, email: profile.email, boundAt: new Date() });

        return {
          content: [{
            type: "text",
            text: `Opened a new Chrome window in profile "${profile.name}" (${profile.email}). The extension auto-handshakes silently — the launched tab will close on its own within a few seconds; that is success, not failure. Wait ~3s, then call chrome_status to confirm the socket appeared, then chrome_connect.`,
          }],
        };
      },
    ),

    defineTool(
      "chrome_status",
      `Check Chrome MCP state. Reports, in order:
1. Connection: connected / not connected, and to WHICH Chrome profile (email).
2. Bridge plumbing: native-messaging socket present, native-host PID count.
3. Chrome window state: which profiles are currently open in Chrome.
4. Per-session MCP status (claude-in-chrome wired into this session?).

Use this before any browser tool call to confirm the right account is in
control. If "Connection: not connected", call chrome_open_profile.`,
      {},
      async () => {
        const socketDir = getChromeSocketDir();
        const socketFiles = listChromeSocketFiles();
        const socketExists = socketFiles.length > 0;
        const nativeHostPids = findNativeHostPids();
        const localState = readChromeLocalState();
        const expected = expectedProfileBySession.get(sessionId) ?? null;
        const profiles = listChromeProfiles();
        const profileById = new Map(profiles.map((p) => [p.id, p]));

        const lines: string[] = [];

        const connected = socketExists && nativeHostPids.length > 0;
        if (connected && lastBoundProfile) {
          lines.push(`Connection: ✅ CONNECTED to ${lastBoundProfile.id} (${lastBoundProfile.email})`);
        } else if (connected) {
          const guess = localState.lastUsed ? profileById.get(localState.lastUsed) : null;
          lines.push(
            `Connection: ✅ connected, but profile unknown to cowork`
              + (guess ? ` (likely ${localState.lastUsed} / ${guess.email} — Chrome's last-focused)` : "")
              + `. To attribute reliably, call chrome_open_profile next time.`,
          );
        } else {
          lines.push(`Connection: ❌ NOT CONNECTED — call chrome_open_profile(profile_id) to bind one.`);
        }

        lines.push(``, `Bridge:`);
        lines.push(`  socket dir: ${existsSync(socketDir) ? "present" : "missing"} (${socketDir})`);
        lines.push(`  .sock files: ${socketFiles.length > 0 ? `${socketFiles.length} (${socketFiles.join(", ")})` : "none"}`);
        lines.push(
          `  native-host PIDs: ${nativeHostPids.length > 0 ? nativeHostPids.join(", ") : "none"}`
            + (nativeHostPids.length > 1 ? "  ⚠ multiple — chrome_force_reset recommended" : ""),
        );

        lines.push(``, `Chrome windows:`);
        if (localState.lastUsed) {
          const lu = profileById.get(localState.lastUsed);
          lines.push(`  last-focused: ${localState.lastUsed}${lu ? ` (${lu.email})` : ""}`);
        }
        if (localState.lastActive.length > 0) {
          const labels = localState.lastActive.map((id) => {
            const p = profileById.get(id);
            return p ? `${id} (${p.email})` : id;
          });
          lines.push(`  currently open: ${labels.join(", ")}`);
        }
        if (expected) {
          lines.push(`  this session previously asked for: ${expected.id} (${expected.email})`);
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

        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    ),

    defineTool(
      "chrome_force_reset",
      `Hard-reset the Chrome MCP plumbing for this machine. Kills every
running --chrome-native-host process, removes the socket file, and forgets
which profile was last bound. Use when chrome_status shows multiple
native-host PIDs, or chrome_connect keeps returning "failed".

After running this, call chrome_open_profile(profile_id) to spin a fresh
auto-handshake (no user click needed), then chrome_connect.`,
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
        expectedProfileBySession.delete(sessionId);
        setLastBoundProfile(null);

        const lines = [
          `Killed ${killed.length} native-host process(es): ${killed.join(", ") || "none"}`,
          `Stale .sock files removed: ${socketsRemoved}`,
          `Last-bound profile: cleared`,
          ``,
          `Next: call chrome_open_profile(profile_id) — Chrome auto-handshakes, no user click — then chrome_connect.`,
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    ),
  ];
}
