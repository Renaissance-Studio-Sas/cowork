// Chrome native-messaging bridge helpers. Used by:
//   - workbench-tools/session.ts — the runtime-agnostic chrome inspection
//     tools (status, list_profiles, open_profile, reconnect, force_reset)
//   - claude-chrome-tools.ts — the Claude-only chrome_connect /
//     chrome_disconnect tools that mutate the MCP server map
//
// Knows about: the .sock-files directory layout (changed in claude-agent-sdk
// 0.3.x), Chrome's per-profile Preferences for email/extension detection,
// and the cross-process state we have to track because the native-messaging
// socket is per-user (not per-profile) so cowork can't tell from the socket
// alone which profile owns it.

import { execSync } from "child_process";
import { readFileSync, readdirSync, existsSync } from "fs";
import path from "path";
import os from "os";

// SDK 0.3.x no longer ships cli.js — it extracts a native `claude` binary at
// runtime. Spawn the user-installed global binary instead. Falls back to the
// PATH lookup if the well-known location isn't there.
export const CLAUDE_BIN_PATH: string = existsSync("/Users/mfucci/.local/bin/claude")
  ? "/Users/mfucci/.local/bin/claude"
  : "claude";

export const CLAUDE_EXTENSION_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";

export interface ChromeProfile {
  id: string;       // e.g., "Default", "Profile 1"
  name: string;     // Display name from Preferences
  email: string;    // Google account email
  hasExtension: boolean;
}

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
export function getChromeSocketDir(): string {
  const username = os.userInfo().username;
  const base = process.platform === "win32" ? os.tmpdir() : "/tmp";
  return path.join(base, `claude-mcp-browser-bridge-${username}`);
}

export function listChromeSocketFiles(): string[] {
  const dir = getChromeSocketDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".sock"));
  } catch {
    return [];
  }
}

export function isChromeExtensionConnected(): boolean {
  return listChromeSocketFiles().length > 0;
}

// Read Chrome's "Local State" file for cross-profile metadata: which profile
// was last focused and which profiles are currently open. The Claude extension
// can only connect from a profile that's currently active, so this narrows
// down which profile likely owns the native-messaging socket.
export interface ChromeLocalState {
  lastUsed: string | null;
  lastActive: string[];
}

export function readChromeLocalState(): ChromeLocalState {
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
export function findNativeHostPids(): number[] {
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
// See docs/chrome-mcp-per-session.md for the broader limitation.
export const expectedProfileBySession = new Map<string, { id: string; email: string }>();

// The Chrome native-messaging socket is per-user (not per-profile) so only
// ONE profile can own it at a time across all sessions. We can't read the
// profile from the socket or native-host process itself, so we track the
// last profile that launched a successful handshake via chrome_open_profile.
// chrome_force_reset clears this. chrome_status surfaces it as
// "Connected profile (last bound)".
export let lastBoundProfile: { id: string; name: string; email: string; boundAt: Date } | null = null;

export function setLastBoundProfile(p: typeof lastBoundProfile): void {
  lastBoundProfile = p;
}

export function getChromeUserDataDir(): string | null {
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

export function listChromeProfiles(): ChromeProfile[] {
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

      profiles.push({ id: entry.name, name, email, hasExtension });
    } catch {
      // Skip profiles we can't read
    }
  }

  return profiles;
}

export function openChromeReconnectPage(profileId?: string): boolean {
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
