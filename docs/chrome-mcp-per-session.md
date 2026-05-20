# Chrome MCP per-session profile isolation

Status: **proposed** — to be implemented as a follow-up.
Owner: TBD.

## The problem

cowork treats Chrome MCP as a per-session capability (each session has its own
`chrome_open_profile` / `chrome_connect` / `chrome_status` / `chrome_force_reset`
tools, threaded through `buildSessionMcp`). Behaviorally it is **not** per-session
— it is per-user-on-the-machine.

The Claude Agent SDK's Chrome bridge in 0.3.x lives at
`/tmp/claude-mcp-browser-bridge-<user>/<pid>.sock` (or `os.tmpdir()` on systems
where `/tmp` is unusable — macOS/Linux pin to `/tmp` because the SDK binary
hardcodes it). It's one directory per UNIX user. Native messaging itself is
per-Chrome-profile (each profile's extension can spawn its own native-host
process), so SDK 0.3 gives us multiple `.sock` files when multiple profiles
each connect. But:

- **The CLI client (`claude --claude-in-chrome-mcp`) picks one `.sock` file
  per invocation.** It doesn't take a socket-selector arg today. The pick is
  not session-aware — multiple cowork sessions invoking the CLI race for
  whichever sock the client decides to grab.
- **Our session-mcp tracker is module-global.** `lastBoundProfile` in
  `src/lib/session-mcp.ts` is a single variable shared by every session in the
  process. The last `chrome_open_profile` call from any session overwrites it.
- **`chrome_status` reports `lastBoundProfile`** as if it were this session's
  binding — but it's actually whichever session most recently called
  `chrome_open_profile`. A session that bound Profile 6 will see
  "CONNECTED to Default" after another session binds Default.
- **`chrome_force_reset` is nuclear.** It SIGKILLs every `--chrome-native-host`
  process on the box and `rm -rf`s the socket directory. Any concurrent session
  using Chrome MCP loses its bridge mid-tool-call.

The on-disk evidence right after a clean `chrome_force_reset` + single
`chrome_open_profile("Profile 6")` looks healthy — one .sock file, one
native-host PID — but `tabs_context_mcp` can still return tabs from a different
profile, because the bridge connects to whichever extension responded first /
whose extension has the active service worker, not necessarily the one we
just launched a window for.

## Symptoms observed

1. Session A binds `Profile 6` (corp@). Session B binds `Default` (marco@).
   Both sessions' `chrome_status` reports `Default` as `lastBoundProfile`.
2. Session A calls `chrome_force_reset` to clean up — session B's in-flight
   `navigate` call dies with "Connection failed". Session B never sees a
   warning that anything was disturbed.
3. Single-session test: `chrome_open_profile("Profile 6")` succeeds,
   `chrome_status` reports "CONNECTED to Profile 6", but `tabs_context_mcp`
   returns Default's tabs. The bridge bound to the wrong profile's extension
   despite the chrome window opening in the right one.

## Proposed fix

Four pieces. Roughly increasing cost.

### 1. Document the limit + warn on collision (cheap)

- `src/lib/session-mcp.ts`: when a session calls `chrome_open_profile(X)` and
  another session is currently bound to `Y ≠ X`, return an error/warning in
  the tool result body explaining that switching profiles will disturb the
  other session. Make it explicit, not silent.
- `chrome_status` text adds a "global bridge state" section listing all sock
  files and which session(s) last touched each one — so users can tell their
  view is shared.
- CLAUDE.md (template) gets a short note: "Chrome MCP is a per-user resource;
  serialize Chrome work across sessions, don't parallelize."

### 2. Per-session profile binding (real fix, medium)

- Replace the module-global `lastBoundProfile` with a `Map<sessionId, BoundProfile>`.
- `chrome_open_profile` writes into `bindings.set(sessionId, profile)`. Other
  sessions' bindings untouched.
- `chrome_status` reads `bindings.get(thisSessionId)`. If not set, says
  "no profile bound for this session".
- Concurrency guard: if `bindings` already has two distinct profiles in
  flight, log a warning. Don't fail — we may legitimately have two sessions
  doing read-only work that happen to land on the same profile.

This alone does not solve the **CLI picks the wrong sock** problem (see #3),
but it stops the tracker from lying and stops cross-session state pollution.

### 3. Socket-selector arg for `claude --claude-in-chrome-mcp` (hard — depends on SDK)

Investigate whether the 0.3.x SDK CLI supports passing an explicit socket path
(e.g. `--bridge-sock /tmp/.../<pid>.sock`). If yes:

- `chrome_connect` spawns the CLI with the sock matching this session's bound
  profile. Need a profile → sock mapping; walk parent-Chrome-process tree
  (the native-host's PPID is the Chrome process, which has the profile
  directory in its argv/cwd) to figure out which sock belongs to which
  profile.

If the SDK CLI does not support a sock arg, file an SDK request and document
that per-session-different-profiles is unsupported until then. Without this,
#2 prevents the *tracker* from lying but the *actual* tool calls still race.

### 4. Per-session `chrome_force_reset` scoping (medium)

- Default: only kill the native-host that this session's binding currently
  uses. Don't touch other sessions' sock files.
- New `chrome_force_reset_global` (or `chrome_force_reset --global`) for the
  nuclear option, only used when the user explicitly wants it.
- The reset tool's doc says clearly which scope it operates on.

## Files involved

- `src/lib/session-mcp.ts` — `lastBoundProfile`, `getChromeSocketDir()`,
  `listChromeSocketFiles()`, `isChromeExtensionConnected()`,
  `chrome_open_profile`, `chrome_connect`, `chrome_disconnect`,
  `chrome_status`, `chrome_force_reset`.
- `src/lib/sessions.ts` — passes `sessionId` into `buildSessionMcp`; would
  need to thread it through to the per-tool handlers so bindings are
  session-scoped.

## Out of scope

- Multi-USER Chrome MCP. The socket dir is per OS user, so two OS users on the
  same box already get isolated bridges for free.
- Sandboxing Chrome instances per session via separate `--user-data-dir`s.
  Possible but a much bigger architectural shift; users want the *familiar*
  Chrome profile (with bookmarks, sessions, passkeys) attached to each
  session, not a fresh sandbox.

## Acceptance criteria

- Two concurrent cowork sessions each calling `chrome_status` see their own
  bound profile, not each other's.
- Session A's `chrome_force_reset` (default scope) leaves session B's bridge
  intact.
- `chrome_open_profile("Profile 6")` from session A then `tabs_context_mcp`
  from session A returns Profile 6's tabs, even if session B is bound to a
  different profile. (Requires #3 — or a documented workaround.)
- CLAUDE.md updated with the per-user limit if #3 isn't shippable.
