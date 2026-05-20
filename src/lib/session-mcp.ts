// In-process MCP server that lets the agent manage its own session.
// Provides tools for the agent to set a descriptive session name and manage Chrome MCP.

import { tool, createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { renameLiveSession, getSessionQuery, debugSessionRegistry, getSessionDir } from "./sessions";
import { createEmailPreview, getEmailPreview, listPendingEmails, type EmailMessage } from "./email-store";
import { buildCommentsMcp } from "./comments-mcp";
import { buildEmailMcp } from "./email-mcp";
import { execSync } from "child_process";
import { readFileSync, readdirSync, existsSync } from "fs";
import path from "path";
import os from "os";

// SDK 0.3.x no longer ships cli.js — it extracts a native `claude` binary at
// runtime. Spawn the user-installed global binary instead. Falls back to the
// PATH lookup if the well-known location isn't there.
const CLAUDE_BIN_PATH: string = existsSync("/Users/mfucci/.local/bin/claude")
  ? "/Users/mfucci/.local/bin/claude"
  : "claude";
console.error(`[session-mcp] CLAUDE_BIN_PATH resolved to: ${CLAUDE_BIN_PATH}`);

// Chrome profile detection utilities
interface ChromeProfile {
  id: string;       // e.g., "Default", "Profile 1"
  name: string;     // Display name from Preferences
  email: string;    // Google account email
  hasExtension: boolean;
}

const CLAUDE_EXTENSION_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";

// The native-messaging bridge directory. SDK 0.3.x switched from a single
// socket file to a directory containing one <pid>.sock file per running
// native-host instance — this lets multiple Chrome profiles coexist.
//
// IMPORTANT: the new `claude` binary hardcodes `/tmp` on darwin/linux for
// this directory, NOT `os.tmpdir()`. On macOS `os.tmpdir()` returns the
// per-user `$TMPDIR` (e.g. `/var/folders/.../T/`), so checking there would
// always come up empty even when the bridge is live in `/tmp`. Pin to `/tmp`
// on POSIX; fall back to `os.tmpdir()` only on Windows where the binary
// uses the platform temp dir.
function getChromeSocketDir(): string {
  const username = os.userInfo().username;
  const base = process.platform === "win32" ? os.tmpdir() : "/tmp";
  return path.join(base, `claude-mcp-browser-bridge-${username}`);
}

function listChromeSocketFiles(): string[] {
  const dir = getChromeSocketDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".sock"));
  } catch {
    return [];
  }
}

function isChromeExtensionConnected(): boolean {
  return listChromeSocketFiles().length > 0;
}

// Read Chrome's "Local State" file for cross-profile metadata: which profile
// was last focused and which profiles are currently open. The Claude extension
// can only connect from a profile that's currently active, so this narrows
// down which profile likely owns the native-messaging socket.
interface ChromeLocalState {
  lastUsed: string | null;
  lastActive: string[];
}
function readChromeLocalState(): ChromeLocalState {
  const userDataDir = getChromeUserDataDir();
  if (!userDataDir) return { lastUsed: null, lastActive: [] };
  try {
    const raw = readFileSync(path.join(userDataDir, "Local State"), "utf8");
    const ls = JSON.parse(raw) as { profile?: { last_used?: string; last_active_profiles?: string[] } };
    return {
      lastUsed: ls.profile?.last_used ?? null,
      lastActive: ls.profile?.last_active_profiles ?? [],
    };
  } catch {
    return { lastUsed: null, lastActive: [] };
  }
}

// List PIDs of currently-running --chrome-native-host processes. After the
// Chrome extension disconnects (socket file removed) some of these can linger
// holding stale FDs — they need to be killed before a fresh connect works.
function findNativeHostPids(): number[] {
  try {
    const out = execSync(
      "ps -axo pid,command 2>/dev/null | grep -- '--chrome-native-host' | grep -v grep",
      { encoding: "utf8" },
    );
    return out
      .split("\n")
      .map((line) => parseInt(line.trim().split(/\s+/)[0], 10))
      .filter((pid) => Number.isFinite(pid));
  } catch {
    return [];
  }
}

// Per-session "expected" Chrome profile — set by chrome_open_profile so we
// can later tell the user which profile they asked for, even though we can't
// directly inspect which profile owns the native-messaging socket. Survives
// session lifecycle because it's keyed by sessionId in this module's scope.
const expectedProfileBySession = new Map<string, { id: string; email: string }>();

// The Chrome native-messaging socket is per-user (not per-profile) so only
// ONE profile can own it at a time across all sessions. We can't read the
// profile from the socket or native-host process itself, so we track the
// last profile that launched a successful handshake via chrome_open_profile.
// chrome_force_reset clears this. chrome_status surfaces it as
// "Connected profile (last bound)".
let lastBoundProfile: { id: string; name: string; email: string; boundAt: Date } | null = null;

function getChromeUserDataDir(): string | null {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Google", "Chrome");
    case "linux":
      return path.join(home, ".config", "google-chrome");
    case "win32":
      return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Google", "Chrome", "User Data");
    default:
      return null;
  }
}

function listChromeProfiles(): ChromeProfile[] {
  const userDataDir = getChromeUserDataDir();
  if (!userDataDir || !existsSync(userDataDir)) return [];

  const profiles: ChromeProfile[] = [];
  const entries = readdirSync(userDataDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Chrome profiles are "Default" or "Profile N"
    if (entry.name !== "Default" && !entry.name.startsWith("Profile ")) continue;

    const profilePath = path.join(userDataDir, entry.name);
    const prefsPath = path.join(profilePath, "Preferences");

    if (!existsSync(prefsPath)) continue;

    try {
      const prefs = JSON.parse(readFileSync(prefsPath, "utf8"));
      const name = prefs?.profile?.name || entry.name;
      const email = prefs?.account_info?.[0]?.email || "unknown";
      const extensionPath = path.join(profilePath, "Extensions", CLAUDE_EXTENSION_ID);
      const hasExtension = existsSync(extensionPath);

      profiles.push({
        id: entry.name,
        name,
        email,
        hasExtension,
      });
    } catch {
      // Skip profiles we can't read
    }
  }

  return profiles;
}

function openChromeReconnectPage(profileId?: string): boolean {
  try {
    const reconnectUrl = "https://clau.de/chrome/reconnect";

    switch (process.platform) {
      case "darwin": {
        if (profileId) {
          // CRITICAL: when Chrome is already running, `open -a "Google Chrome"`
          // hands the URL to the running process, which opens it in the
          // currently-focused window — IGNORING --profile-directory in --args.
          // Invoking the Chrome binary directly with --new-window + the profile
          // flag does respect the requested profile, even with Chrome running.
          const chromeBin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
          // Spawn detached so execSync doesn't block on Chrome staying alive
          execSync(
            `"${chromeBin}" --profile-directory="${profileId}" --new-window "${reconnectUrl}" >/dev/null 2>&1 &`,
            { stdio: "ignore", shell: "/bin/bash" },
          );
        } else {
          execSync(`open -a "Google Chrome" "${reconnectUrl}"`, { stdio: "ignore" });
        }
        return true;
      }
      case "linux":
        if (profileId) {
          execSync(`google-chrome --profile-directory="${profileId}" --new-window "${reconnectUrl}"`, { stdio: "ignore" });
        } else {
          execSync(`xdg-open "${reconnectUrl}"`, { stdio: "ignore" });
        }
        return true;
      case "win32":
        if (profileId) {
          execSync(`start chrome --profile-directory="${profileId}" --new-window "${reconnectUrl}"`, { stdio: "ignore", shell: "cmd.exe" });
        } else {
          execSync(`start chrome "${reconnectUrl}"`, { stdio: "ignore", shell: "cmd.exe" });
        }
        return true;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

export function buildSessionMcp(
  sessionId: string,
  projectSlug: string,
  taskSlug: string,
): McpSdkServerConfigWithInstance {
  // chrome_connect / chrome_disconnect call q.setMcpServers(...) which
  // REPLACES the entire MCP server map — not "adds to it". If we passed only
  // {"claude-in-chrome": ...}, the SDK would silently unregister this very
  // workbench-session MCP (and workbench-comments), and the session would
  // lose access to all its tools mid-conversation. So we always re-include
  // the static MCPs in any setMcpServers call.
  const baseStaticMcps = (): Record<string, McpSdkServerConfigWithInstance> => ({
    "workbench-comments": buildCommentsMcp(projectSlug, taskSlug),
    "workbench-session": buildSessionMcp(sessionId, projectSlug, taskSlug),
    "workbench-email": buildEmailMcp(sessionId),
  });

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

      // Debug tool to check session registry
      tool(
        "chrome_debug_session",
        `Debug tool to check if this session is properly registered. Returns session ID, whether it's found in registry, and whether it has a Query object.`,
        {},
        async () => {
          const debug = debugSessionRegistry(sessionId);
          return {
            content: [{
              type: "text",
              text: `Session ID: ${sessionId}\nFound in registry: ${debug.found}\nHas Query object: ${debug.hasQuery}\nAll registered sessions: ${debug.allIds.join(", ") || "none"}`
            }],
          };
        },
      ),

      // Chrome MCP management tools
      tool(
        "chrome_list_profiles",
        `List all Chrome profiles on this machine and their Claude extension status.
Use this to see which profiles have the Claude extension installed and can be used for browser automation.
Returns profile ID, display name, email, and whether the extension is installed.`,
        {},
        async () => {
          const profiles = listChromeProfiles();
          if (profiles.length === 0) {
            return {
              content: [{ type: "text", text: "No Chrome profiles found. Is Google Chrome installed?" }],
            };
          }

          const lines = profiles.map(p =>
            `- ${p.id}: ${p.name} (${p.email}) ${p.hasExtension ? "✅ Extension installed" : "❌ No extension"}`
          );

          return {
            content: [{ type: "text", text: `Chrome profiles:\n${lines.join("\n")}` }],
          };
        },
      ),

      tool(
        "chrome_connect",
        `Wire the running Claude-in-Chrome bridge into THIS session's MCP map so
the agent can use the 17 Chrome MCP tools (navigate, tabs_context_mcp,
read_page, find, form_input, etc.).

⚠ CRITICAL: tool list refresh. After chrome_connect succeeds, the
mcp__claude-in-chrome__* tools are NOT visible in your current turn — the
SDK adds them mid-turn but the tool definitions sent to the LLM are locked
in at turn start. If you call e.g. mcp__claude-in-chrome__navigate in the
SAME turn as chrome_connect, you will get "No such tool available". You must
END YOUR TURN after chrome_connect, then the next user message will start a
new turn with the Chrome tools visible. Strategy:

  Turn N (now)  : chrome_status → chrome_open_profile(id) → chrome_connect.
                  End with a short message like "Chrome wired to <profile>.
                  Send a follow-up and I'll proceed." Do NOT try to use any
                  mcp__claude-in-chrome__* tool yet.
  Turn N+1      : Chrome tools are now visible. Use tabs_context_mcp,
                  navigate, read_page, etc.

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
          console.error(`[session-mcp] chrome_connect called for sessionId: ${sessionId}`);

          // First check if the Chrome extension socket exists
          const socketDir = getChromeSocketDir();
          const socketFiles = listChromeSocketFiles();
          const socketExists = socketFiles.length > 0;
          console.error(`[session-mcp] Chrome socket dir: ${socketDir}, sockets: ${socketFiles.join(", ") || "none"}`);

          if (!socketExists) {
            return {
              content: [{
                type: "text",
                text: `Chrome native-messaging socket missing (no *.sock files in ${socketDir}). Spin one up by calling chrome_open_profile with the target profile_id — Chrome will launch a new window in that profile and the extension auto-handshakes (no user click). Wait ~2-3s, then call chrome_connect again. Do not instruct the user to click Connect; the extension claims the socket on its own.`
              }],
              isError: true,
            };
          }

          const q = getSessionQuery(sessionId);
          console.error(`[session-mcp] getSessionQuery returned: ${q ? "Query object" : "null"}`);
          if (!q) {
            return {
              content: [{ type: "text", text: `Session not found (id: ${sessionId}). The session may not be fully initialized yet.` }],
              isError: true,
            };
          }

          try {
            // Force a fresh MCP spawn. If claude-in-chrome is already in the
            // SDK map (e.g. from a prior attempt that ended in status=failed),
            // a single setMcpServers with the same config is a no-op — the SDK
            // does not retry the spawn. So we always remove first, then add.
            // baseStaticMcps() preserves workbench-session and workbench-comments
            // through both calls so this tool doesn't unregister itself.
            await q.setMcpServers(baseStaticMcps());
            // Match the SDK's internal spawn pattern: invoke cli.js directly
            // (the file has a `#!/usr/bin/env node` shebang and is executable)
            // rather than `node cli.js`. The bundled SDK uses this exact shape
            // for its own dynamic Chrome MCP registration, and it appears the
            // node-prefix shape can fail with "Connection failed" under
            // Turbopack/dev-server.
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
                content: [{
                  type: "text",
                  text: `Failed to spawn Chrome MCP: ${errorMsg}\n\nCheck chrome_status — if socket is missing, call chrome_open_profile first.`,
                }],
                isError: true,
              };
            }

            // Confirm the SDK reports it as connected, not just "added".
            // The MCP may add successfully but then fail to connect to the
            // bridge — we want to surface that distinction.
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
            // Keep the static workbench MCPs and drop claude-in-chrome — an
            // empty object here would unregister this tool itself.
            const result = await q.setMcpServers(baseStaticMcps());
            expectedProfileBySession.delete(sessionId);

            if (result.removed.includes("claude-in-chrome")) {
              return {
                content: [{ type: "text", text: "Chrome MCP disconnected." }],
              };
            }

            return {
              content: [{ type: "text", text: "Chrome MCP was not connected." }],
            };
          } catch (e) {
            return {
              content: [{ type: "text", text: `Error disconnecting Chrome MCP: ${e instanceof Error ? e.message : String(e)}` }],
              isError: true,
            };
          }
        },
      ),

      tool(
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

      tool(
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
          // Verify the profile exists and has the extension
          const profiles = listChromeProfiles();
          const profile = profiles.find(p => p.id === profile_id);

          if (!profile) {
            const available = profiles.map(p => p.id).join(", ");
            return {
              content: [{
                type: "text",
                text: `Profile "${profile_id}" not found. Available profiles: ${available || "none"}`
              }],
              isError: true,
            };
          }

          if (!profile.hasExtension) {
            return {
              content: [{
                type: "text",
                text: `Profile "${profile_id}" (${profile.name}) does not have the Claude extension installed.\nInstall it from: https://claude.ai/chrome`
              }],
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

          // Track the connection both per-session (for the session's own
          // "what did I ask for" memory) and globally (since the socket itself
          // is single, the last opened profile owns it across all sessions).
          expectedProfileBySession.set(sessionId, { id: profile_id, email: profile.email });
          lastBoundProfile = { id: profile_id, name: profile.name, email: profile.email, boundAt: new Date() };

          return {
            content: [{
              type: "text",
              text: `Opened a new Chrome window in profile "${profile.name}" (${profile.email}). The extension auto-handshakes silently — the launched tab will close on its own within a few seconds; that is success, not failure. Wait ~3s, then call chrome_status to confirm the socket appeared, then chrome_connect.`
            }],
          };
        },
      ),


      tool(
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

          // 1. Connection summary — the headline answer
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

          // 2. Bridge plumbing
          lines.push(``, `Bridge:`);
          lines.push(
            `  socket dir: ${existsSync(socketDir) ? "present" : "missing"} (${socketDir})`,
          );
          lines.push(
            `  .sock files: ${socketFiles.length > 0 ? `${socketFiles.length} (${socketFiles.join(", ")})` : "none"}`,
          );
          lines.push(
            `  native-host PIDs: ${nativeHostPids.length > 0 ? nativeHostPids.join(", ") : "none"}`
              + (nativeHostPids.length > 1 ? "  ⚠ multiple — chrome_force_reset recommended" : ""),
          );

          // 3. Chrome window state
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

          // 4. Per-session MCP wiring
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
              const label = {
                connected: "✅ wired and connected",
                failed: "❌ failed — call chrome_force_reset, then chrome_open_profile",
                "needs-auth": "⏳ handshake in progress — wait ~2s and re-check",
                pending: "⏳ pending",
                disabled: "⏸ disabled",
              }[chromeStatus.status] || chromeStatus.status;
              lines.push(`  claude-in-chrome: ${label}`);
            }
          } catch (e) {
            lines.push(`  error querying MCP status: ${e instanceof Error ? e.message : String(e)}`);
          }

          return { content: [{ type: "text", text: lines.join("\n") }] };
        },
      ),

      tool(
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
          // Best-effort remove stale .sock files if any linger. Native hosts
          // normally clean up on SIGTERM, but kill -9 / crashes can leave
          // stragglers in the directory.
          const socketDir = getChromeSocketDir();
          let socketsRemoved = 0;
          try {
            for (const f of listChromeSocketFiles()) {
              execSync(`rm -f "${path.join(socketDir, f)}"`, { stdio: "ignore" });
              socketsRemoved++;
            }
          } catch { /* ignore */ }
          // Forget which profile cowork thought was bound — nothing is now
          expectedProfileBySession.delete(sessionId);
          lastBoundProfile = null;

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

      // Email tools - also available in workbench-email MCP, duplicated here for convenience
      tool(
        "request_send_email",
        `Request to send an email. The email will be displayed in the chat for the user
to review. They must click "Approve & Send" before the email is actually sent.

IMPORTANT: This does NOT send the email immediately. The user must approve it first.
After approval, call check_email_status to get the approval token, then execute
the rowads CLI to actually send the email.

For replies, set isReply=true and include the threadId.
For forwards, set isForward=true.`,
        {
          to: z.string().describe("Recipient email address(es), comma-separated for multiple"),
          cc: z.string().optional().describe("CC email address(es), comma-separated"),
          subject: z.string().describe("Email subject line"),
          body: z.string().describe("Email body in HTML format"),
          threadId: z.string().optional().describe("Gmail thread ID for replies"),
          isReply: z.boolean().optional().describe("True if this is a reply"),
          isForward: z.boolean().optional().describe("True if this is a forward"),
        },
        async (input) => {
          const sessionDir = getSessionDir(sessionId);
          if (!sessionDir) {
            return {
              content: [{ type: "text", text: `Session not found (id: ${sessionId}). Cannot create email preview.` }],
              isError: true,
            };
          }

          const preview = await createEmailPreview(sessionDir, {
            to: input.to,
            cc: input.cc,
            subject: input.subject,
            body: input.body,
            threadId: input.threadId,
            isReply: input.isReply,
            isForward: input.isForward,
          });

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                previewId: preview.id,
                sessionId: sessionId,
                status: "pending",
                message: "Email preview created. Waiting for user approval in the UI. " +
                  "The user will see the email in the chat and can click 'Approve & Send'. " +
                  "Call check_email_status with the previewId to check if they approved.",
              }, null, 2),
            }],
          };
        },
      ),

      tool(
        "check_email_status",
        `Check the approval status of a pending email request.

Returns the status and, if approved, the approval token needed to send the email.`,
        {
          previewId: z.string().describe("The email preview ID returned by request_send_email"),
        },
        async ({ previewId }) => {
          const sessionDir = getSessionDir(sessionId);
          if (!sessionDir) {
            return {
              content: [{ type: "text", text: `Session not found (id: ${sessionId}).` }],
              isError: true,
            };
          }

          const preview = await getEmailPreview(sessionDir, previewId);
          if (!preview) {
            return {
              content: [{ type: "text", text: `Email preview not found (id: ${previewId}).` }],
              isError: true,
            };
          }

          const response: {
            previewId: string;
            sessionId: string;
            status: string;
            approvalToken?: string;
            to: string;
            subject: string;
            body: string;
            cc?: string;
            threadId?: string;
            message: string;
          } = {
            previewId: preview.id,
            sessionId: sessionId,
            status: preview.status,
            to: preview.to,
            subject: preview.subject,
            body: preview.body,
            cc: preview.cc,
            threadId: preview.threadId,
            message: "",
          };

          switch (preview.status) {
            case "pending":
              response.message = "Still waiting for user approval. The user needs to click 'Approve & Send' in the chat UI.";
              break;
            case "approved":
              response.approvalToken = preview.approvalHash;
              response.message = "Email approved and being sent by the UI. Check again shortly for 'sent' status.";
              break;
            case "rejected":
              response.message = "User rejected this email. Compose a new version if needed.";
              break;
            case "sent":
              response.message = "Email has already been sent.";
              break;
          }

          return {
            content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
          };
        },
      ),
    ],
  });
}
