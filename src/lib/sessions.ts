import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { createWriteStream, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
// SDKMessage / SDKUserMessage / CanUseTool / PermissionResult are still
// imported from the Claude SDK because the AgentRuntime interface (see
// agent-runtime.ts) defines AgentEvent / AgentUserMessage / AgentCanUseTool
// / AgentPermissionResult as aliases for those today — the UI and
// pumpEvents already speak that shape. Sessions code imports the AgentXxx
// aliases so the runtime boundary is the only place tied to Claude SDK
// types.
import type {
  AgentEvent as SDKMessage,
  AgentUserMessage as SDKUserMessage,
  AgentCanUseTool as CanUseTool,
  AgentPermissionResult as PermissionResult,
  AgentQuery,
  AgentQueryOptions,
} from "./agent-runtime";
import { getRuntime } from "./runtimes";

import { InputChannel, makeUserMessage, makeUserMessageWithImages, type ImageContent } from "./input-channel";
import {
  appendEvent,
  flushEvents,
  forgetSession,
  readSessionEvents,
  registerSessionLog,
} from "./cloud-events";
import { getWorkspace, workspaceDir, WORKSPACE_ROOT, SESSIONS_ROOT, sessionDir, reconcileSessionsOnDisk } from "./fs";
import { buildContextSystemPrompt, generateSessionLabel } from "./sessions/prompts";
import { extractTodosFromMessages } from "./todos";
import {
  updateMeta,
  persistSdkSessionId,
  persistSessionState,
  persistPendingPromptFlag,
  persistOwnerPid,
  readMetaRaw,
} from "./sessions/meta";
import {
  buildWorkspacePlanningTools,
  buildWorkspacePlanningSystemPrompt,
} from "./workbench-tools/planning";
import { buildCommentsTools } from "./workbench-tools/comments";
import { buildSessionTools } from "./workbench-tools/session";
import { buildUserInputTools } from "./workbench-tools/user-input";
import { workbenchToolsAsClaudeMcp } from "./runtimes/claude-tool-adapter";
import { buildStaticWorkbenchMcps, ASK_USER_QUESTION_ALIAS } from "./claude-chrome-tools";
import type { WorkbenchTool } from "./workbench-tools/types";

// Build the runtime-agnostic workbench tool groups for a session. Used by
// the Gemini runtime to register into gemini-cli-core's ToolRegistry; the
// Claude runtime continues to read the Claude-wrapped versions from
// `mcpServers` (built via buildStaticWorkbenchMcps). Both paths source
// from the same underlying tool definitions.
function buildStaticWorkbenchToolGroups(
  sessionId: string,
  workspacePath: string[],
): Array<{ name: string; tools: WorkbenchTool[] }> {
  return [
    { name: "workbench-comments", tools: buildCommentsTools(workspacePath) },
    { name: "workbench-session", tools: buildSessionTools(sessionId, workspacePath) },
    { name: "workbench-user-input", tools: buildUserInputTools(sessionId) },
  ];
}

// Redirects the built-in AskUserQuestion tool the claude_code preset
// advertises to our workbench-user-input handler. Without this, the model
// emits AskUserQuestion and the SDK returns "tool not implemented" because
// only the type exists.
const STATIC_TOOL_ALIASES: Record<string, string> = {
  AskUserQuestion: ASK_USER_QUESTION_ALIAS,
};
import {
  type SessionState,
  isValidTransition,
  isTerminalState,
  shouldPersistState,
  canOverwriteWithStopped,
  stateAfterResult,
} from "./session-state-machine";

// Re-export SessionState for consumers who import from sessions.ts
export type { SessionState } from "./session-state-machine";

// Re-export session-related types so consumers that `import { ... } from
// "./sessions"` keep working. New code should prefer importing directly
// from ./sessions/types.
export type {
  SessionRuntime,
  EffortLevel,
  RuntimeSession,
  PendingPermission,
  PendingQuestion,
  PendingCompletion,
  SessionSummary,
} from "./sessions/types";

import type {
  SessionRuntime,
  EffortLevel,
  RuntimeSession,
  PendingPermission,
  PendingQuestion,
  PendingCompletion,
  SessionSummary,
} from "./sessions/types";

const REGISTRY = new Map<string, RuntimeSession>();

// In dev mode Next hot-reloads modules; survive that with a globalThis cache.
declare global {
  // `var` (not let/const) is required for global augmentation here.
  var __wb_session_registry: Map<string, RuntimeSession> | undefined;
  var __wb_watchdog_interval: ReturnType<typeof setInterval> | undefined;
  var __wb_session_registry_events: EventEmitter | undefined;
  var __wb_reconciled: boolean | undefined;
  var __wb_restore_inflight: Map<string, Promise<RuntimeSession | null>> | undefined;
  var __wb_resume_inflight: Map<string, Promise<boolean>> | undefined;
}
const registry: Map<string, RuntimeSession> =
  globalThis.__wb_session_registry ?? (globalThis.__wb_session_registry = REGISTRY);

// Per-id locks for the two state-spawning entry points. Both share registry
// state, both can spawn an SDK subprocess, and both used to race against each
// other (and against concurrent callers of themselves) — producing duplicate
// claude-agent-sdk children that wrote to the same transcript and re-ran the
// user's last request. Coalesce concurrent calls through these maps so every
// caller for a given id awaits the same in-flight promise.
const restoreInFlight: Map<string, Promise<RuntimeSession | null>> =
  globalThis.__wb_restore_inflight ?? (globalThis.__wb_restore_inflight = new Map());
const resumeInFlight: Map<string, Promise<boolean>> =
  globalThis.__wb_resume_inflight ?? (globalThis.__wb_resume_inflight = new Map());

// Session ownership across Next.js dev worker processes is authoritatively
// recorded in meta.json's `ownerPid` — the worker PID that spawned the
// in-process AgentQuery. Read meta to decide:
//
//   ownerPid alive AND != us  → another worker owns the session. We can't
//                                reach into its InputChannel from here, so
//                                spawning a fresh SDK would race two
//                                subprocesses against the same on-disk
//                                transcript. Bail.
//   ownerPid alive AND == us  → we own it. (Caller already has the
//                                AgentQuery in registry.)
//   ownerPid dead / missing   → no live owner. Reclaim: kill any leftover
//                                SDK subprocesses for this sdkSessionId,
//                                then spawn a fresh one.
//
// ps is used only for orphan reclamation when claiming an unowned session
// (the prior owner's SDK subprocess may still be alive, writing to the
// transcript file). Posix-only — Windows skips reclamation and trusts the
// in-process AgentQuery.

interface SdkProc { pid: number; }

// Find live `claude-agent-sdk --resume <sdkSessionId>` subprocesses. Used
// after we've decided we're the new owner of a session (meta.ownerPid was
// dead/missing) to kill leftover SDKs from the previous owner before
// spawning a replacement.
//
// Caveat: a session that has NEVER been resumed has no `--resume` in its
// args, so its SDK isn't matched here. That's fine because the previous
// owner's process death also closed the SDK's stdin pipe, and the SDK exits
// on EOF.
async function findResumedSdkSubprocesses(sdkSessionId: string): Promise<SdkProc[]> {
  if (!sdkSessionId || process.platform === "win32") return [];
  try {
    const { stdout } = await execAsync("ps -eo pid,args", { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    const marker = `--resume ${sdkSessionId}`;
    const out: SdkProc[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.includes("claude-agent-sdk") || !line.includes(marker)) continue;
      const m = line.trim().match(/^(\d+)\s/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      if (Number.isFinite(pid) && pid !== process.pid) out.push({ pid });
    }
    return out;
  } catch (err) {
    console.warn(`[sessions] ps for ${sdkSessionId.slice(0, 8)}… failed:`, (err as Error).message);
    return [];
  }
}

// Inspect ownership of a session, returning either "owned by another live
// worker" (caller should bail) or a list of reclaimable SDKs (caller should
// SIGKILL them, then spawn a fresh SDK).
async function inspectOwnership(
  workspacePath: string[],
  sessionId: string,
  sdkSessionId: string | null,
): Promise<{ ownedByOther: boolean; reclaimable: SdkProc[] }> {
  const meta = await readMetaRaw(workspacePath, sessionId);
  const ownerPid = typeof meta?.ownerPid === "number" ? meta.ownerPid : null;
  if (ownerPid && ownerPid !== process.pid && isPidAlive(ownerPid)) {
    return { ownedByOther: true, reclaimable: [] };
  }
  // We're free to claim. Find leftover SDKs (best effort) so we don't end
  // up with two SDKs writing to the same transcript.
  const reclaimable = sdkSessionId ? await findResumedSdkSubprocesses(sdkSessionId) : [];
  return { ownedByOther: false, reclaimable };
}

async function killReclaimableSdks(procs: SdkProc[], reason: string): Promise<void> {
  if (procs.length === 0) return;
  let killed = 0;
  for (const p of procs) {
    try { process.kill(p.pid, "SIGKILL"); killed++; }
    catch { /* already gone */ }
  }
  if (killed > 0) console.log(`[sessions] reclaimed ${killed} SDK subprocess(es) (${reason})`);
}

// Backfill fields added to RuntimeSession after the registry was first
// populated. In Next.js dev, the registry is preserved across HMR via
// globalThis, but the session objects inside it keep the shape they had
// at insertion time. When a required field is added to RuntimeSession
// (e.g. `pendingQuestions` for AskUserQuestion), any session that predates
// the schema change still has `undefined` there — and code paths that read
// it (the SSE stream route iterating `s.pendingQuestions`) throw a TypeError
// and return HTTP 500, which leaves the UI unable to attach to the session
// or send messages. Backfill so existing sessions stay usable.
for (const s of registry.values()) {
  if (!s.pendingQuestions) {
    (s as RuntimeSession).pendingQuestions = new Map();
  }
  if (!s.pendingCompletions) {
    (s as RuntimeSession).pendingCompletions = new Map();
  }
  if (typeof s.completed !== "boolean") {
    (s as RuntimeSession).completed = false;
  }
  if (typeof s.streamingText !== "string") {
    (s as RuntimeSession).streamingText = "";
  }
}

// Fires "added" with the new RuntimeSession when a session is added to the
// registry. Lets multiplexed SSE endpoints attach listeners to sessions that
// appear after the client connected.
const sessionRegistryEvents: EventEmitter =
  globalThis.__wb_session_registry_events ??
  (globalThis.__wb_session_registry_events = (() => {
    const ee = new EventEmitter();
    ee.setMaxListeners(0);
    return ee;
  })());

function registerSession(s: RuntimeSession): void {
  registry.set(s.id, s);
  sessionRegistryEvents.emit("added", s);
}

// Compare two workspace paths for equality.
function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

// Subscribe to file_changed events from every live session in the given
// workspace, including sessions added after this call. Returns an unsubscribe
// function. Used by the multiplexed /api/file-events/stream endpoint so one
// browser connection covers all sessions on a workspace.
export function subscribeFileChanges(
  workspacePath: string[],
  listener: (data: { path: string; sessionId: string }) => void,
): () => void {
  const attached = new Map<string, (data: { path: string }) => void>();
  const attach = (s: RuntimeSession) => {
    if (!samePath(s.workspacePath, workspacePath)) return;
    if (attached.has(s.id)) return;
    const wrapper = (data: { path: string }) =>
      listener({ ...data, sessionId: s.id });
    s.events.on("file_changed", wrapper);
    attached.set(s.id, wrapper);
  };
  for (const s of registry.values()) attach(s);
  const onAdded = (s: RuntimeSession) => attach(s);
  sessionRegistryEvents.on("added", onAdded);
  return () => {
    sessionRegistryEvents.off("added", onAdded);
    for (const [id, wrapper] of attached) {
      const s = registry.get(id);
      if (s) s.events.off("file_changed", wrapper);
    }
    attached.clear();
  };
}

// Subscribe to open_artifact events from every live session in the given
// workspace, including sessions added after this call. These are emitted by
// the workbench-session.open_artifact tool so an agent can push a
// freshly-saved artifact into the user's artifact panel. Returns an unsubscribe
// function. Multiplexed by /api/file-events/stream alongside file_changed.
export function subscribeOpenArtifact(
  workspacePath: string[],
  listener: (data: { path: string; sessionId: string }) => void,
): () => void {
  const attached = new Map<string, (data: { path: string }) => void>();
  const attach = (s: RuntimeSession) => {
    if (!samePath(s.workspacePath, workspacePath)) return;
    if (attached.has(s.id)) return;
    const wrapper = (data: { path: string }) =>
      listener({ ...data, sessionId: s.id });
    s.events.on("open_artifact", wrapper);
    attached.set(s.id, wrapper);
  };
  for (const s of registry.values()) attach(s);
  const onAdded = (s: RuntimeSession) => attach(s);
  sessionRegistryEvents.on("added", onAdded);
  return () => {
    sessionRegistryEvents.off("added", onAdded);
    for (const [id, wrapper] of attached) {
      const s = registry.get(id);
      if (s) s.events.off("open_artifact", wrapper);
    }
    attached.clear();
  };
}

// "Running" with no recent events isn't enough to call a session stuck —
// a single Claude turn with extended thinking + web search + multi-step
// tools can easily go 15 minutes without emitting a visible event. The
// watchdog only fires the stale check this often; the *decision* to stop
// also requires a liveness probe (see runWatchdog).
const STALE_THRESHOLD_MS = 15 * 60 * 1000;
const IDLE_EVICT_MS = 5 * 60 * 1000;      // idle this long → close streams + transition to stopped
const WATCHDOG_INTERVAL_MS = 60 * 1000;   // check every minute

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't deliver anything — it just probes whether the process
    // exists and we have permission to signal it. ESRCH means dead; EPERM
    // means it's alive but ours-to-signal-it permission is denied.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Decide whether this VM context should run the boot auto-resume pass.
//
// Auto-resume's job is to revive sessions whose meta.json says
// finalState="running" — but spamming it on every Next.js dev churn would
// push a "[Server restarted…]" prompt into every live session, repeatedly.
// So we gate it with a sidecar PID file:
//
//   prior PID == ours              HMR re-eval inside the same Next.js
//                                   worker — the prior VM context already
//                                   ran (or skipped) auto-resume; running
//                                   again would reclaim our own live SDKs.
//   prior PID is a different live
//     process                      another worker on this workspace is
//                                   handling boot. Stand down.
//   prior PID dead / no file       genuine cold start (or all workers
//                                   crashed) — run auto-resume.
//
// The per-session ownership check inside autoResume (via inspectSdk) is
// what makes any of this *correct*; this gate is just to avoid wasted scans
// + duplicate "Server restarted" prompts.
const PID_FILE = path.join(
  os.tmpdir(),
  `cowork-server-${createHash("sha1").update(process.cwd()).digest("hex").slice(0, 8)}.pid`,
);

function shouldRunBootAutoResume(): boolean {
  let priorPid: number | null = null;
  let reason = "no prior PID file";
  let run = true;
  try {
    priorPid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (Number.isFinite(priorPid)) {
      if (priorPid === process.pid) { run = false; reason = "HMR re-eval (same PID)"; }
      else if (isPidAlive(priorPid)) { run = false; reason = `prior PID ${priorPid} still alive`; }
      else { reason = `prior PID ${priorPid} dead`; }
    }
  } catch { /* missing/unreadable → cold start */ }
  console.log(`[boot] auto-resume ${run ? "running" : "skipped"} (pid=${process.pid}, prior=${priorPid}, reason=${reason})`);
  if (run) {
    try { writeFileSync(PID_FILE, String(process.pid)); } catch { /* best effort */ }
  }
  return run;
}

// Runtime contract: any session whose streams have been closed MUST be in
// state "stopped". sendInput dispatches by state — "running"/"idle" goes to
// the live-write path that pushes into the InputChannel; if streams are
// closed but state says "idle"/"running", the write silently no-ops and the
// agent never sees the message. So the watchdog closes streams AND
// transitions state together.
//
// Stale-running is a LIVENESS check, not a time check: a Claude turn with
// extended thinking + web research can legitimately go 15 min without
// emitting an event. We only kill if `ps` confirms the SDK subprocess is
// gone. Otherwise we refresh lastActivity and let it keep working.
async function runWatchdog() {
  const now = Date.now();
  for (const s of registry.values()) {
    // A session blocked on a user decision (ExitPlanMode approval or an
    // AskUserQuestion) is "running" only because the SDK turn is parked
    // awaiting the user — no events flow, so lastActivity goes stale even
    // though nothing is wrong. Don't probe under a pending card.
    if (
      s.pendingPermissions.size > 0
      || (s.pendingQuestions?.size ?? 0) > 0
      || (s.pendingCompletions?.size ?? 0) > 0
    ) continue;
    const sinceActivity = now - s.lastActivity.getTime();

    if (s.state === "running" && sinceActivity > STALE_THRESHOLD_MS) {
      // Probe the SDK subprocess. Fresh sessions (no sdkSessionId yet) and
      // sessions whose SDK was spawned without `--resume <sid>` in its CLI
      // args aren't ps-matchable; we conservatively treat those as alive
      // and let the next watchdog tick re-check.
      const sdkLikelyAlive = !s.sdkSessionId
        || (await findResumedSdkSubprocesses(s.sdkSessionId)).length > 0;
      if (sdkLikelyAlive) {
        // Refresh activity so we don't reprobe every tick while a long turn runs.
        s.lastActivity = new Date();
        continue;
      }
      console.warn(`[watchdog] Session ${s.id} SDK subprocess dead — auto-stopping`);
      try {
        const timeoutMsg = {
          type: "system",
          subtype: "error",
          message: "Session lost its agent subprocess — please send a message to resume.",
        } as unknown as SDKMessage;
        s.history.push(timeoutMsg);
        appendEvent(s.id, s.seq++, timeoutMsg);
        s.events.emit("event", timeoutMsg);
        s.interrupted = true;
        s.input.close();
        void flushEvents(s.id);
        s.inputLog.end();
        setState(s, "stopped");
      } catch { /* best effort */ }
    } else if (s.state === "idle" && sinceActivity > IDLE_EVICT_MS) {
      console.log(`[watchdog] Session ${s.id} idle for ${Math.round(sinceActivity / 1000)}s — closing (resumable on next message)`);
      try {
        s.input.close();
        void flushEvents(s.id);
        s.inputLog.end();
        setState(s, "stopped");
      } catch { /* best effort */ }
    }
  }
}

// Start watchdog if not already running
if (!globalThis.__wb_watchdog_interval) {
  globalThis.__wb_watchdog_interval = setInterval(() => { void runWatchdog(); }, WATCHDOG_INTERVAL_MS);
  // Don't prevent process exit
  if (globalThis.__wb_watchdog_interval.unref) {
    globalThis.__wb_watchdog_interval.unref();
  }
}

// At module load: reconcile session meta (idempotent + cheap) and — only on
// a real cold start — resume sessions that were mid-turn when the prior
// server died. Deferred via setImmediate because sessions.ts ↔ fs.ts is a
// circular import; calling reconcileSessionsOnDisk synchronously here can
// TDZ-trip on SESSIONS_ROOT depending on which module the loader entered first.
//
// Two guards:
//   - globalThis.__wb_reconciled — per-VM-context dedupe (cheap)
//   - shouldRunBootAutoResume() — PID-file dedupe across VM contexts in the
//     same OS process (HMR) and across other live workers
if (!globalThis.__wb_reconciled) {
  globalThis.__wb_reconciled = true;
  setImmediate(async () => {
    await reconcileSessionsOnDisk();
    if (!shouldRunBootAutoResume()) return;
    await autoResumeRunningSessions();
  });
}

// Build the canUseTool callback the SDK invokes before each tool execution.
// We use it as the user-approval gate for ExitPlanMode: when the agent
// finishes a plan and tries to exit plan mode, we park the call in
// `pendingPermissions` and emit a `permission_request` event so the UI can
// surface an Approve/Deny card. Everything else auto-allows — sessions run
// in `bypassPermissions` so the SDK normally wouldn't even call this.
function buildCanUseTool(
  pendingPermissions: Map<string, PendingPermission>,
  events: EventEmitter,
): CanUseTool {
  return async (toolName, input, options) => {
    if (toolName === "ExitPlanMode") {
      return new Promise<PermissionResult>((resolve) => {
        const toolUseId = options.toolUseID;
        pendingPermissions.set(toolUseId, {
          toolName,
          input,
          resolve,
          requestedAt: new Date(),
        });
        events.emit("permission_request", {
          toolUseId,
          toolName,
          input,
        });
        // Persist hasPendingPrompt so a server restart while the user is
        // deciding doesn't auto-push a "[Server restarted...]" prompt into
        // a session that was parked on a user decision.
        const s = sessionForPermissionsMap(pendingPermissions);
        if (s) void persistPendingPromptFlag(s);
      });
    }
    return { behavior: "allow", updatedInput: input };
  };
}

// Reverse-lookup a session from its pendingPermissions map identity. The
// canUseTool closure captures the map but not the session — this avoids
// threading the session through buildCanUseTool's signature just for the
// meta-write side effect on pending-state change.
function sessionForPermissionsMap(map: Map<string, PendingPermission>): RuntimeSession | null {
  for (const s of registry.values()) {
    if (s.pendingPermissions === map) return s;
  }
  return null;
}

// Resolve a pending tool-use approval. Called by the permission API endpoint
// once the user clicks Approve or Deny in the UI.
export function resolvePermission(
  id: string,
  toolUseId: string,
  result: PermissionResult,
): boolean {
  const s = registry.get(id);
  if (!s) return false;
  const pending = s.pendingPermissions.get(toolUseId);
  if (!pending) return false;
  pending.resolve(result);
  s.pendingPermissions.delete(toolUseId);
  void persistPendingPromptFlag(s);
  // Echo the decision so the UI can clear its approval card without waiting
  // for the SDK's tool_result to come back.
  s.events.emit("permission_resolved", {
    toolUseId,
    behavior: result.behavior,
  });
  return true;
}

// Park an agent's "I think we're done" suggestion on a live session. The
// promise returned to the tool handler unblocks when the user clicks
// Approve / Dismiss in the UI. Returns the requestId so the caller can plumb
// it through the event payload. The tool is opt-in for the agent — manual
// completion via the UI does not go through this path.
export function addPendingCompletion(
  id: string,
  reason: string | undefined,
): { requestId: string; promise: Promise<boolean> } | null {
  const s = registry.get(id);
  if (!s) return null;
  if (!s.pendingCompletions) s.pendingCompletions = new Map();
  const requestId = randomUUID();
  const promise = new Promise<boolean>((resolve) => {
    s.pendingCompletions.set(requestId, {
      reason,
      resolve,
      requestedAt: new Date(),
    });
    s.events.emit("completion_request", { requestId, reason: reason ?? null });
    void persistPendingPromptFlag(s);
  });
  return { requestId, promise };
}

// Resolve a pending completion suggestion. Called by /api/sessions/[id]/complete
// when the user approves or dismisses the agent's request. Returns false if
// the session or request can't be found (already resolved, stale id, etc.).
export function resolveCompletionSuggestion(
  id: string,
  requestId: string,
  approved: boolean,
): boolean {
  const s = registry.get(id);
  if (!s) return false;
  const pending = s.pendingCompletions?.get(requestId);
  if (!pending) return false;
  pending.resolve(approved);
  s.pendingCompletions.delete(requestId);
  void persistPendingPromptFlag(s);
  s.events.emit("completion_resolved", { requestId, approved });
  return true;
}

// Resolve a pending AskUserQuestion. Called by /api/sessions/[id]/question
// when the user submits their selections in the UI. Returns false if the
// session or pending question can't be found (already answered, or the
// id is stale).
export function resolveQuestion(
  id: string,
  questionId: string,
  // null = the user refused the prompt instead of answering.
  answers: Array<{ selected?: string[]; other?: string } | { refused: true }> | null,
): boolean {
  const s = registry.get(id);
  if (!s) return false;
  const pending = s.pendingQuestions.get(questionId);
  if (!pending) return false;
  pending.resolve(answers);
  s.pendingQuestions.delete(questionId);
  void persistPendingPromptFlag(s);
  // Echo so any other clients viewing this session can clear their card.
  s.events.emit("question_resolved", { questionId });
  return true;
}

export function getSession(id: string): RuntimeSession | undefined {
  const s = registry.get(id);
  // The session registry is preserved across Next.js HMR via globalThis,
  // so sessions created before a field was added to RuntimeSession can be
  // missing that field after a hot reload. Backfill the post-launch fields
  // lazily so call sites (stream route, resolveQuestion, etc.) can iterate
  // them without crashing. Cheap one-time-per-stale-session no-op.
  if (s && !s.pendingQuestions) s.pendingQuestions = new Map();
  if (s && !s.pendingCompletions) s.pendingCompletions = new Map();
  if (s && typeof s.completed !== "boolean") s.completed = false;
  if (s && s.effort === undefined) s.effort = null;
  return s;
}

// Expose the live SDK Query for a session so MCP tools (chrome_connect /
// chrome_disconnect / chrome_reconnect in session-mcp.ts) can call its
// setMcpServers() to add or remove dynamic MCP servers mid-conversation.
// Returns null when the session is unknown or has no live query (e.g. a
// session restored from disk before resume).
export function getSessionQuery(id: string): AgentQuery | null {
  const s = registry.get(id);
  if (!s || !s.q) return null;
  return s.q;
}

// Forward a POST to the underlying runner of a remote session. Used by API
// routes that need to talk to runner-only endpoints (e.g. /auth-code for the
// inline /login flow). Returns null if the session isn't a remote one or has
// no live runner — the route then 404s.
export async function relayRemoteRunner(
  sessionId: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown } | null> {
  const s = registry.get(sessionId);
  if (!s || (s.runtime !== "remote" && s.runtime !== "cloud") || !s.q) return null;
  // RemoteAgentQuery + CloudAgentQuery both expose relayToRunner(); other
  // AgentQuery shapes don't. Duck-type the method off the AgentQuery so we
  // don't need a runtime cast.
  const q = s.q as unknown as {
    relayToRunner?: (p: string, b: unknown) => Promise<{ status: number; body: unknown }>;
  };
  if (typeof q.relayToRunner !== "function") return null;
  return q.relayToRunner(path, body);
}

// Dispatch the query() call to whatever AgentRuntime the session uses. The
// runtime registry lives in ./runtimes; every entry returns an AgentQuery,
// which is structurally compatible with what the rest of sessions.ts
// expects (pumpEvents, sendInput, interrupt, the SSE route).
//
// Centralising the dispatch here means the query call sites (startSession,
// startProjectSession, resumeSession) only need to add `runtime` to their
// options blob.
//
// The Claude SDK's options shape today doubles as our AgentQueryOptions —
// they're structurally compatible. The cast on `opts` lets the callers keep
// passing the SDK-shaped option blobs they already build. When a future
// runtime needs a different option shape, this is where the translation
// goes.
function createAgentQuery(
  runtime: SessionRuntime,
  opts: Record<string, unknown>,
  context?: { workspacePath: string[] },
): AgentQuery {
  // The remote runtime needs the workspace identity to forward to the
  // controller (the cwd alone is just the workspace root). Inject here so
  // callers don't have to remember which runtimes need which extras.
  const withRemote =
    runtime === "remote" && context
      ? { ...opts, remote: { workspacePath: context.workspacePath } }
      : opts;
  return getRuntime(runtime).query(withRemote as unknown as AgentQueryOptions);
}

// Debug helper to inspect the session registry
export function debugSessionRegistry(targetId: string): { found: boolean; hasQuery: boolean; allIds: string[] } {
  const s = registry.get(targetId);
  return {
    found: !!s,
    hasQuery: !!(s?.q),
    allIds: Array.from(registry.keys()),
  };
}

// Rename a live session's in-memory title directly by ID.
// Also persists to meta.json so the title survives restarts.
// Returns true if session was found and renamed.
export async function renameLiveSession(id: string, newName: string): Promise<boolean> {
  const s = registry.get(id);
  if (!s) return false;

  const trimmedName = newName.trim();
  s.title = trimmedName;

  await updateMeta(s, (meta) => {
    meta.name = trimmedName;
  });

  return true;
}

export function listLiveSessions(): SessionSummary[] {
  return [...registry.values()].map((s) => {
    // Session is unread only if it completed in the background (after user last viewed it)
    // Running sessions are never marked unread — user sees them update in real-time
    // Sessions marked complete are never unread — completion explicitly clears the badge
    const unread = !s.completed && s.completedAt !== null && (!s.seenAt || s.completedAt > s.seenAt);
    const hasPendingPrompt =
      s.pendingPermissions.size > 0
      || (s.pendingQuestions?.size ?? 0) > 0
      || (s.pendingCompletions?.size ?? 0) > 0;
    return {
      id: s.id,
      workspacePath: s.workspacePath,
      state: s.state,
      title: s.title,
      startedAt: s.startedAt.toISOString(),
      lastActivity: s.lastActivity.toISOString(),
      isLive: true,
      unread,
      completed: !!s.completed,
      hasPendingPrompt,
      runtime: s.runtime,
      model: s.model,
      effort: s.effort ?? null,
    };
  });
}

// Walk SESSIONS_ROOT flat — every direct subdirectory is a session, and each
// session's meta.json carries its workspace path. Sessions in the live
// registry are skipped to avoid double-listing.
export async function listAllSessions(): Promise<SessionSummary[]> {
  const live = listLiveSessions();
  const liveIds = new Set(live.map((s) => s.id));
  const out: SessionSummary[] = [...live];

  let dirents: import("node:fs").Dirent[];
  try { dirents = await fs.readdir(SESSIONS_ROOT, { withFileTypes: true }); }
  catch (err) {
    // First boot before any sessions exist — fine. Anything else, log.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[listAllSessions] could not read ${SESSIONS_ROOT}:`, (err as Error).message);
    }
    return out.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
  }

  for (const d of dirents) {
    if (!d.isDirectory() || liveIds.has(d.name)) continue;
    const id = d.name;
    const sessDir = path.join(SESSIONS_ROOT, id);
    const metaPath = path.join(sessDir, "meta.json");
    const inputPath = path.join(sessDir, "input.jsonl");
    let meta: { workspace?: string[]; startedAt?: string; name?: string; seenAt?: string; finalState?: SessionState; lastActivity?: string; completedAt?: string; completed?: boolean; hasPendingPrompt?: boolean; runtime?: SessionRuntime; model?: string | null; effort?: EffortLevel | null } = {};
    try { meta = JSON.parse(await fs.readFile(metaPath, "utf8")); } catch { continue; /* no meta → not a session */ }
    const workspacePath = Array.isArray(meta.workspace) ? meta.workspace : [];
    // Prefer generated name from meta.json; fall back to first message for legacy sessions.
    let title = meta.name ?? "(no message)";
    if (!meta.name) {
      try {
        const first = (await fs.readFile(inputPath, "utf8")).split("\n").find(Boolean);
        if (first) title = (JSON.parse(first).text as string).trim().slice(0, 120);
      } catch { /* missing */ }
    }
    // lastActivity is persisted to meta.json on every state transition; new
    // sessions always have it. Pre-D1 legacy sessions without it fall back
    // to startedAt or epoch.
    const lastActivity = meta.lastActivity ?? meta.startedAt ?? new Date(0).toISOString();
    // Session is unread only if it completed after user last viewed it.
    // For legacy sessions without completedAt, use lastActivity as proxy (they're already done).
    // Sessions explicitly marked complete are never unread.
    const completedAt = meta.completedAt ?? lastActivity;
    const unread = meta.completed === true ? false : (!meta.seenAt || meta.seenAt < completedAt);
    // Use persisted finalState if available (idle = done, error = error),
    // otherwise fall back to "idle" (assume completed) for historical sessions.
    const state: SessionState = meta.finalState ?? "idle";
    out.push({
      id,
      workspacePath,
      state,
      title,
      startedAt: meta.startedAt ?? lastActivity,
      lastActivity,
      isLive: false,
      unread,
      completed: meta.completed === true,
      hasPendingPrompt: meta.hasPendingPrompt === true,
      runtime: meta.runtime ?? "claude",
      model: meta.model ?? null,
      effort: meta.effort ?? null,
    });
  }

  out.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
  return out;
}

// Read a historical session's events from the D1 cowork-sessions-marco table.
// The workspacePath arg is used only for the workspace existence check —
// events themselves are keyed solely by session id.
//
// Pagination: offset is from the END (offset=0 = most recent `limit` events).
export async function readSessionHistory(
  workspacePath: string[],
  id: string,
  limit?: number,
  offset: number = 0,
): Promise<{ events: unknown[]; total: number; hasMore: boolean } | null> {
  const ws = await getWorkspace(workspacePath);
  if (!ws) return null;
  const eventsPath = path.join(sessionDir(id), "events.jsonl");
  // Tell the file backend where this stopped session's log lives, then read.
  registerSessionLog(id, eventsPath);
  try {
    return await readSessionEvents(id, { limit, offset });
  } catch (err) {
    console.error(`[sessions] readSessionHistory(${id}) failed:`, err);
    return null;
  }
}

// Restore a historical session from disk into the registry so it can be resumed.
// Returns the restored session if successful, or null if not found.
export async function restoreSession(
  workspacePath: string[],
  id: string,
): Promise<RuntimeSession | null> {
  // Check if already in registry — fast path, no lock needed.
  const existing = registry.get(id);
  if (existing) return existing;

  // Coalesce concurrent restores for the same id. The SSE stream endpoint,
  // /api/sessions/[id]/input, and autoResumeRunningSessions can all race to
  // restore the same session at the same moment; without this lock each one
  // would create its own RuntimeSession and (worse) spawn its own SDK
  // subprocess via resumeSession, leaving a duplicate orphaned the moment
  // the second write to `registry` overwrote the first one's reference.
  const inflight = restoreInFlight.get(id);
  if (inflight) return inflight;

  const promise = doRestoreSession(workspacePath, id);
  restoreInFlight.set(id, promise);
  try {
    return await promise;
  } finally {
    restoreInFlight.delete(id);
  }
}

async function doRestoreSession(
  workspacePath: string[],
  id: string,
): Promise<RuntimeSession | null> {
  // Re-check inside the lock — another caller may have populated the
  // registry while we were awaiting the lock.
  const existing = registry.get(id);
  if (existing) return existing;

  const ws = await getWorkspace(workspacePath);
  if (!ws) return null;

  // Sessions live flat in SESSIONS_ROOT — the directory no longer encodes
  // the workspace, only the session id. The workspace path comes from meta.
  const dir = sessionDir(id);
  // The agent's runtime cwd is always the workspace root (see startSession
  // comment). Stored on the RuntimeSession so resume keeps it consistent.
  const cwd = WORKSPACE_ROOT;

  // Read meta.json
  const metaPath = path.join(dir, "meta.json");
  let meta: {
    name?: string;
    startedAt?: string;
    sdkSessionId?: string;
    permissionMode?: string;
    model?: string;
    effort?: EffortLevel;
    finalState?: SessionState;
    seenAt?: string;
    lastActivity?: string;
    completedAt?: string;
    completed?: boolean;
    runtime?: SessionRuntime;
  } = {};
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    meta = JSON.parse(raw);
  } catch {
    return null; // No meta.json means session doesn't exist
  }

  // Read history back from the event log (file backend by default; see
  // cloud-events.ts). Empty (file missing or backend unreachable) is fine —
  // the UI just won't have a replay buffer, and resume will pick up via the
  // SDK's own transcript anyway.
  registerSessionLog(id, path.join(dir, "events.jsonl"));
  let history: SDKMessage[] = [];
  try {
    const { events } = await readSessionEvents(id);
    history = events as SDKMessage[];
  } catch (err) {
    console.warn(`[sessions] restoreSession(${id}) could not load history:`, err);
  }

  // Create a placeholder InputChannel and Query that will be replaced on resume
  const input = new InputChannel();
  input.close(); // Closed — not active
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const pendingPermissions = new Map<string, PendingPermission>();
  const pendingQuestions = new Map<string, PendingQuestion>();
  const pendingCompletions = new Map<string, PendingCompletion>();

  // Placeholder input log — replaced on resume when input.jsonl reopens.
  const sink = createWriteStream("/dev/null");

  const session: RuntimeSession = {
    id,
    workspacePath,
    cwd,
    title: meta.name ?? "(untitled)",
    startedAt: meta.startedAt ? new Date(meta.startedAt) : new Date(),
    lastActivity: meta.lastActivity ? new Date(meta.lastActivity) : new Date(),
    seenAt: meta.seenAt ? new Date(meta.seenAt) : null,
    completedAt: meta.completedAt ? new Date(meta.completedAt) : null,
    q: null as unknown as AgentQuery, // Placeholder — replaced on resume
    input,
    events,
    inputLog: sink,
    history,
    // Continue the seq sequence past the events already persisted in D1
    // (history was just rebuilt from the full event log above).
    seq: history.length,
    streamingText: "",
    // A restored session has closed streams and a placeholder query, so the
    // runtime state must be "stopped" regardless of what meta.json says —
    // sendInput dispatches by state, and only "stopped"/"error" routes through
    // resumeSession (which re-opens streams). If we left state as "idle" here,
    // the next user message would silently write to closed streams.
    state: "stopped",
    pendingPermissions,
    pendingQuestions,
    pendingCompletions,
    completed: meta.completed === true,
    sdkSessionId: meta.sdkSessionId ?? null,
    permissionMode: (meta.permissionMode as "default" | "acceptEdits" | "bypassPermissions" | "plan") ?? "bypassPermissions",
    model: meta.model ?? null,
    effort: (meta.effort as EffortLevel | undefined) ?? null,
    // Older meta.json files predate the runtime field — default to "claude"
    // so they keep working unchanged.
    runtime: (meta.runtime as SessionRuntime) ?? "claude",
  };

  registerSession(session);
  return session;
}

// Boot-time pass: find sessions that were processing when the server died
// (meta.finalState === "running" with an sdkSessionId on disk) and resume
// each via the SDK so it picks up where it left off. Restores each into the
// registry first, then pushes a synthetic continuation prompt so the SDK has
// a new turn to act on — without one it won't emit any events. Sequential by
// design: parallel resumes would burst API calls and racing pumpEvents loops
// on shared cwd transcripts is asking for trouble.
const RESUME_PROMPT = "[Server restarted — please continue where you left off.]";

// Check if the session's history ends with a pending tool_use (no matching tool_result).
// Returns the tool_use IDs that need synthetic tool_results before we can send a user message.
function findPendingToolUses(history: SDKMessage[]): string[] {
  // Walk backwards to find the last assistant message
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i] as { type?: string; message?: { role?: string; content?: unknown[] } };
    if (msg.type === "assistant" && msg.message?.role === "assistant") {
      const content = msg.message.content;
      if (!Array.isArray(content)) continue;

      // Collect tool_use IDs from this assistant message
      const toolUseIds: string[] = [];
      for (const block of content) {
        if ((block as { type?: string }).type === "tool_use") {
          toolUseIds.push((block as { id: string }).id);
        }
      }
      if (toolUseIds.length === 0) return [];

      // Check if there's a matching tool_result in subsequent messages
      const answeredIds = new Set<string>();
      for (let j = i + 1; j < history.length; j++) {
        const userMsg = history[j] as { type?: string; message?: { role?: string; content?: unknown[] } };
        if (userMsg.type === "user" && userMsg.message?.role === "user") {
          const userContent = userMsg.message.content;
          if (Array.isArray(userContent)) {
            for (const block of userContent) {
              if ((block as { type?: string }).type === "tool_result") {
                answeredIds.add((block as { tool_use_id: string }).tool_use_id);
              }
            }
          }
        }
      }

      // Return IDs that weren't answered
      return toolUseIds.filter(id => !answeredIds.has(id));
    }
  }
  return [];
}

// Scan SESSIONS_ROOT for candidates the boot-time auto-resume pass should
// pick up: sessions whose previous worker died mid-turn (`running`) or
// mid-resume (`resuming`), excluding remote (Docker) sessions and any whose
// in-memory pending-prompt state would be lost. The workspace path is read
// from each meta.json — no path traversal needed.
async function findRunningSessions(): Promise<Array<{ workspacePath: string[]; id: string; sdkSessionId: string }>> {
  const out: Array<{ workspacePath: string[]; id: string; sdkSessionId: string }> = [];
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(SESSIONS_ROOT, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[auto-resume] could not read ${SESSIONS_ROOT}:`, (err as Error).message);
    }
    return out;
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    // Skip sessions already in the registry — they're still live (preserved
    // via globalThis during HMR) and don't need resume.
    if (registry.has(d.name)) continue;
    const metaPath = path.join(SESSIONS_ROOT, d.name, "meta.json");
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
      // sdkSessionId is required: resume() needs it to find the SDK's
      // transcript. A session that crashed before the first `init` event has
      // no transcript to resume against — skip it.
      // "running" = the previous worker died mid-turn.
      // "resuming" = the previous worker died mid-resume (set right before
      // spawn, cleared on first event). Without this case we'd strand any
      // session whose autoResume itself was interrupted.
      // Remote (Docker) sessions are also skipped: their container is
      // orphaned after a cowork restart and auto-resume would spawn a fresh
      // container per session at boot — slow, noisy, and dependent on Docker.
      // Sessions parked on a user decision (pending permission / question /
      // completion at restart time) are also skipped: the parked tool call
      // lived in-memory only and is gone, so resuming would just blow away
      // the pending card with a "[Server restarted...]" prompt.
      // The actual "another live worker owns this" filter is the per-session
      // inspectOwnership call in doAutoResume, not this candidate filter.
      const resumable = meta.finalState === "running" || meta.finalState === "resuming";
      if (
        resumable
        && !meta.hasPendingPrompt
        && meta.sdkSessionId
        && meta.runtime !== "remote"
        && Array.isArray(meta.workspace)
        && meta.workspace.length > 0
      ) {
        out.push({
          workspacePath: meta.workspace,
          id: d.name,
          sdkSessionId: meta.sdkSessionId,
        });
      }
    } catch { /* skip unreadable meta */ }
  }
  return out;
}

// Lock file to prevent multiple workers from running auto-resume simultaneously.
// Next.js dev mode spawns multiple workers, each with its own globalThis, so
// the __wb_reconciled flag isn't enough.
const AUTO_RESUME_LOCK = path.join(os.tmpdir(), "cowork-auto-resume.lock");
const LOCK_STALE_MS = 30_000; // 30 seconds — if lock is older, it's stale

async function acquireAutoResumeLock(): Promise<boolean> {
  try {
    const stat = await fs.stat(AUTO_RESUME_LOCK);
    if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) {
      return false; // Another worker has the lock and it's fresh
    }
    // Lock is stale — remove it and try to acquire
    await fs.unlink(AUTO_RESUME_LOCK);
  } catch { /* file doesn't exist — we can take it */ }
  try {
    await fs.writeFile(AUTO_RESUME_LOCK, String(Date.now()), { flag: "wx" });
    return true;
  } catch {
    // Another worker beat us to it
    return false;
  }
}

export async function autoResumeRunningSessions(): Promise<{ resumed: number; failed: number }> {
  // Coalesce concurrent boot passes across Next.js dev workers. Lock has a
  // 30s TTL (LOCK_STALE_MS); we never release it explicitly so any worker
  // that boots within that window stands down. Per-session ps ownership
  // checks inside doAutoResume() handle workers that boot after the TTL.
  if (!(await acquireAutoResumeLock())) {
    console.log("[auto-resume] another worker is handling it — skip");
    return { resumed: 0, failed: 0 };
  }
  return await doAutoResume();
}

async function doAutoResume(): Promise<{ resumed: number; failed: number }> {
  const candidates = await findRunningSessions();
  if (candidates.length === 0) return { resumed: 0, failed: 0 };
  console.log(`[auto-resume] Found ${candidates.length} session(s) to resume`);

  let resumed = 0;
  let failed = 0;
  let skipped = 0;
  for (const c of candidates) {
    try {
      const own = await inspectOwnership(c.workspacePath, c.id, c.sdkSessionId);
      if (own.ownedByOther) {
        skipped++;
        console.log(`[auto-resume] ${c.id}: owned by another worker — skip`);
        continue;
      }
      const s = await restoreSession(c.workspacePath, c.id);
      if (!s) { failed++; continue; }
      // Belt-and-braces: clear finalState so a concurrent worker that hasn't
      // seen our ownerPid yet doesn't double-claim this candidate.
      await updateMeta(s, (meta) => { meta.finalState = "resuming"; });
      await killReclaimableSdks(own.reclaimable, `auto-resume ${c.id}`);
      const ok = await resumeSession(s, RESUME_PROMPT, "autoResume");
      if (ok) {
        resumed++;
        console.log(`[auto-resume] Resumed session ${c.id} (${c.workspacePath.join("/")})`);
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      console.error(`[auto-resume] Failed to resume ${c.id}:`, (err as Error).message);
    }
  }
  console.log(`[auto-resume] Done: ${resumed} resumed, ${skipped} skipped (owned elsewhere), ${failed} failed`);
  return { resumed, failed };
}

export interface StartSessionParams {
  /** Slug-chain identifying the workspace this session lives in. */
  workspacePath: string[];
  firstMessage: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  model?: string;
  effort?: EffortLevel;
  runtime?: SessionRuntime;       // defaults to "claude"
  /** Artifact path open in the user's workspace when they started the session. */
  openArtifact?: string;
  /** Files attached to the first message (already uploaded under <folder>/files). */
  files?: FileAttachmentInfo[];
  /**
   * When true, the session is the planning chat for a NEW child workspace
   * under `workspacePath`. The agent gets the planning system prompt plus the
   * `propose_workspace` MCP tool that the Chat UI watches for. The workspace
   * the session belongs to is the parent — the child being planned doesn't
   * exist yet.
   */
  planning?: boolean;
}

// Fold first-message attachments into the prompt: non-image files become
// `[Attached file: <path>]` references prepended to the text; images are read
// from disk and returned as base64 for an image-bearing user message. Mirrors
// the per-turn logic in sendInputWithFiles so the first turn behaves the same.
async function buildAttachmentMessage(
  baseText: string,
  files: FileAttachmentInfo[] | undefined,
  filesDir: string,
): Promise<{ text: string; images: ImageContent[] }> {
  if (!files || files.length === 0) return { text: baseText, images: [] };
  const imageFiles = files.filter((f) => f.mimeType.startsWith("image/"));
  const otherFiles = files.filter((f) => !f.mimeType.startsWith("image/"));

  let text = baseText;
  if (otherFiles.length > 0) {
    const fileRefs = otherFiles.map((f) => `[Attached file: ${f.path}]`).join("\n");
    text = `${fileRefs}\n\n${baseText}`;
  }

  const images: ImageContent[] = [];
  for (const imgFile of imageFiles) {
    try {
      const data = await fs.readFile(path.join(filesDir, imgFile.path));
      images.push({ mimeType: imgFile.mimeType, base64: data.toString("base64") });
    } catch (err) {
      console.error(`Failed to read image ${imgFile.path}:`, err);
    }
  }
  return { text, images };
}

export async function startSession(p: StartSessionParams): Promise<RuntimeSession> {
  const runtime: SessionRuntime = p.runtime ?? "claude";
  const ws = await getWorkspace(p.workspacePath);
  if (!ws) throw new Error(`unknown workspace ${p.workspacePath.join("/")}`);

  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}--${randomUUID().slice(0, 6)}`;
  const name = generateSessionLabel(p.firstMessage);
  // The agent runs with cwd = workspace root so CLAUDE.md / GEMINI.md at the
  // root are picked up by the runtime, and the agent has full access to the
  // workspaces/ tree without needing additionalDirectories. The workspace
  // identity + path is supplied via the system prompt (see
  // sessions/prompts.ts). Session persistence (events.jsonl, meta.json) lives
  // in a flat SESSIONS_ROOT (see fs.ts) — meta.json carries the workspace
  // path so the directory name doesn't need to encode it.
  const cwd = WORKSPACE_ROOT;
  const dir = sessionDir(id);
  await fs.mkdir(dir, { recursive: true });

  await fs.writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify(
      {
        id,
        name,
        workspace: p.workspacePath,
        cwd,
        startedAt: new Date().toISOString(),
        permissionMode: p.permissionMode ?? "bypassPermissions",
        model: p.model ?? null,
        effort: p.effort ?? null,
        runtime,
        // Marks the session as in-flight so the boot-time auto-resume pass
        // can detect a server crash mid-process. Overwritten by setState
        // when the session reaches a terminal state.
        finalState: "running",
      },
      null,
      2,
    ),
  );

  registerSessionLog(id, path.join(dir, "events.jsonl"));
  const inputLog = createWriteStream(path.join(dir, "input.jsonl"), { flags: "a" });

  const input = new InputChannel();
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const pendingPermissions = new Map<string, PendingPermission>();
  const pendingQuestions = new Map<string, PendingQuestion>();
  const pendingCompletions = new Map<string, PendingCompletion>();

  // First message. If an artifact is open in the workspace, prepend a hidden
  // <system-reminder> with its path so the agent knows what the user is
  // looking at from turn 1. Keep `firstMessage` raw in the session record so
  // auto-titling and labels use the user's actual prompt.
  const artifactsDir = workspaceDir(ws);
  const { text: firstWithFiles, images: firstImages } = await buildAttachmentMessage(
    p.firstMessage,
    p.files,
    artifactsDir,
  );
  const augmentedFirstMessage = p.openArtifact
    ? withOpenArtifactNote(firstWithFiles, p.openArtifact)
    : firstWithFiles;
  const firstMsg = firstImages.length > 0
    ? makeUserMessageWithImages(augmentedFirstMessage, firstImages, id)
    : makeUserMessage(augmentedFirstMessage, id);
  inputLog.write(JSON.stringify({ at: new Date().toISOString(), text: augmentedFirstMessage, files: p.files }) + "\n");
  input.push(firstMsg);

  // Planning mode swaps the regular context prompt for the claude_code preset
  // with the planning instructions appended, and merges the planning MCP
  // (propose_workspace) into the static workbench MCPs so the chat UI can
  // render the proposal as an inline card.
  const planningAppend = p.planning
    ? buildWorkspacePlanningSystemPrompt(
        ws.path,
        ws.overview,
        ws.children.map((c) => c.slug),
      )
    : null;
  const systemPrompt = planningAppend
    ? { type: "preset" as const, preset: "claude_code" as const, append: planningAppend }
    : await buildContextSystemPrompt(p.workspacePath, name);
  const planningMcps = p.planning
    ? { "workbench-planning": workbenchToolsAsClaudeMcp("workbench-planning", buildWorkspacePlanningTools()) }
    : {};

  const q = createAgentQuery(runtime, {
    prompt: input,
    options: {
      cwd,
      // Localhost personal use — full trust by default. We still listen for
      // end_turn to flip awaiting_input.
      permissionMode: p.permissionMode ?? "bypassPermissions",
      settingSources: ["project", "user"],
      canUseTool: buildCanUseTool(pendingPermissions, events),
      toolAliases: STATIC_TOOL_ALIASES,
      // Static workbench MCPs (comments, session-management, chrome
      // connect/disconnect) wrapped for Claude here. Gemini's runtime
      // adapter consumes workbenchToolGroups instead, registering them
      // into gemini-cli-core's ToolRegistry.
      mcpServers: { ...(await buildStaticWorkbenchMcps(id, p.workspacePath)), ...planningMcps },
      workbenchToolGroups: buildStaticWorkbenchToolGroups(id, p.workspacePath),
      runtimeStateDir: dir,
      systemPrompt,
      ...(p.model ? { model: p.model } : {}),
      ...(p.effort ? { effort: p.effort } : {}),
    },
    // RemoteRuntime needs the workspace to provision a container against the
    // right folder. Other runtimes ignore this block.
  }, { workspacePath: p.workspacePath });

  const now = new Date();
  const session: RuntimeSession = {
    id,
    workspacePath: p.workspacePath,
    cwd,
    title: name,
    startedAt: now,
    lastActivity: now,
    seenAt: null, // New session — never seen
    completedAt: null, // Not completed yet
    q,
    input,
    events,
    inputLog,
    history: [],
    seq: 0,
    streamingText: "",
    state: "running",
    pendingPermissions,
    pendingQuestions,
    pendingCompletions,
    completed: false,
    sdkSessionId: null,
    permissionMode: p.permissionMode ?? "bypassPermissions",
    model: p.model ?? null,
    effort: p.effort ?? null,
    runtime,
    firstMessage: p.firstMessage,
    autoTitleAttempted: false,
  };
  registerSession(session);
  void persistOwnerPid(session);

  // Echo the first user message into history + cloud event log so the UI
  // shows the user's prompt (the SDK doesn't echo typed inputs in streaming mode).
  session.history.push(firstMsg);
  appendEvent(session.id, session.seq++, firstMsg);
  session.events.emit("event", firstMsg);

  // Pump events in the background — never await this in the request handler.
  void pumpEvents(session);

  return session;
}

// Tools whose tool_use writes a file at a known path (carried in the input).
const FILE_MODIFYING_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

// Bash commands that can create, move, or (crucially) delete files. Agents have
// no dedicated delete tool — they remove artifacts via `Bash` (rm/mv/…), which
// otherwise never signals the UI, so a deleted artifact lingers in the list.
// The UI re-lists the whole directory on any change rather than patching a
// single path, so a coarse match is enough; we err toward refreshing. Matched
// against the first token of each ;/&&/||/| / newline-separated segment.
const FS_MUTATING_BASH = /(^|[;&|\n])\s*(sudo\s+)?(rm|rmdir|unlink|shred|mv|cp|ln|touch|mkdir|mktemp|dd|truncate|tee|install|rsync|scp|trash(-put)?|unzip)\b/i;
// Output redirection into a real file (skip /dev/* sinks and fd duplications).
const FS_REDIRECT_BASH = />>?\s*(?!\/dev\/|&)\S/;
// Tools that are usually read-only — only refresh when invoked in a write mode,
// so the agent's frequent `git status` / `find -name` / `sed -n` don't spam it.
const FS_MUTATING_CONDITIONAL = [
  /\bgit\s+(rm|mv|checkout|restore|clean|stash|reset|merge|rebase|pull|switch|apply|revert|cherry-pick)\b/i,
  /\bsed\b[^|;&]*\s-i/i,
  /\bperl\b[^|;&]*\s-i/i,
  /\bfind\b[^|;&]*\s(-delete|-exec(dir)?)\b/i,
  /\btar\b[^|;&]*\s-[a-z]*x/i,
];

function bashMutatesFiles(command: string): boolean {
  if (FS_MUTATING_BASH.test(command) || FS_REDIRECT_BASH.test(command)) return true;
  return FS_MUTATING_CONDITIONAL.some((re) => re.test(command));
}

// Returns a file path when a tool_use modifies a file at a known location
// (Edit/Write/NotebookEdit), an empty string when a Bash command mutates the
// filesystem (path unknown — the UI re-lists regardless), or null when nothing
// changed. Non-null means "tell the UI to refresh the artifact list."
function extractModifiedFilePath(msg: SDKMessage): string | null {
  if (msg.type !== "assistant") return null;
  const content = (msg as { message?: { content?: unknown[] } }).message?.content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    const p = part as { type?: string; name?: string; input?: { file_path?: string; notebook_path?: string; command?: string } };
    if (p.type !== "tool_use") continue;
    if (FILE_MODIFYING_TOOLS.has(p.name ?? "")) {
      return p.input?.file_path ?? p.input?.notebook_path ?? "";
    }
    if (p.name === "Bash" && typeof p.input?.command === "string" && bashMutatesFiles(p.input.command)) {
      return "";
    }
  }
  return null;
}

// When a turn is interrupted, the SDK aborts the in-flight request, which the
// query iterator surfaces by throwing an abort / "ede_diagnostic" error. That's
// the expected outcome of a user pressing stop — not a crash — so we recognize
// it and record a clean "stopped" instead of flipping the session to "error".
//
// Also includes the SDK's exit messages ("Claude Code process terminated by
// signal SIGKILL/SIGTERM", "Claude Code process exited with code …"). Those
// fire whenever we deliberately kill the prior subprocess — via
// AgentQuery.close() in resumeSession, or via killReclaimableSdks during
// auto-resume / cross-worker reclamation. The pumpEvents `s.q !== myQuery`
// bail-out catches these in most cases, but there's a narrow event-loop
// window where the exit event lands while s.q is still the dying query.
// Treating it as a clean stop closes the hole: intentional kill → new query
// takes over; external kill (OOM, manual pkill) → session lands in "stopped"
// and the user's next message restarts it via resumeSession. Either way,
// no scary red error in the transcript.
function isInterruptError(message: string): boolean {
  return /request was aborted|ede_diagnostic|returned an error result|process terminated by signal|process exited with code/i.test(message);
}

// 529 = Anthropic API overloaded. Retryable with backoff.
function is529Error(message: string): boolean {
  return /529|overloaded/i.test(message);
}

// Exponential backoff delay: 2s, 4s, 8s, 16s, 32s (capped)
function backoffDelay(attempt: number): number {
  return Math.min(2000 * Math.pow(2, attempt), 32000);
}

// Re-derive the todo list from the FULL in-memory history and emit a `todos`
// event when it changes. Deriving over the complete history (not a paginated
// window) is the whole point — it keeps the task panel coherent no matter how
// much transcript the chat UI has loaded. Cheap: only runs on assistant
// messages (the only carrier of TodoWrite/TaskCreate/TaskUpdate tool calls)
// and short-circuits via a serialized diff so unchanged turns emit nothing.
function maybeEmitTodos(s: RuntimeSession) {
  const todos = extractTodosFromMessages(s.history);
  const json = JSON.stringify(todos);
  if (json === s.lastTodosJson) return;
  s.lastTodosJson = json;
  s.events.emit("todos", todos);
}

async function pumpEvents(s: RuntimeSession) {
  // Snapshot the query this pump is iterating. resumeSession() / retrySession()
  // swap s.q for a fresh AgentQuery; the OLD pump's iterator throws on the
  // interrupt and we use this reference to recognize "I'm a stale loop, don't
  // mutate state." Checking by `s.q !== myQuery` is precise — checking by
  // s.state (e.g. "running") gave false positives for INITIAL pumps that
  // fail before producing any event (remote runtime ECONNREFUSED on a dead
  // controller would silently strand the session as "working").
  const myQuery = s.q;
  try {
    for await (const msg of s.q) {
      // stream_event = per-token streaming delta (Claude SDKPartialAssistantMessage
      // or our Gemini equivalent). Forward to live SSE clients so the UI can
      // render incremental text, but skip persistence/history — the final
      // assistant message at end-of-turn carries the full text and is what
      // gets logged. Otherwise events.jsonl bloats ~30× per turn and the
      // in-memory replay buffer grows without bound.
      const isStreamEvent = (msg as { type?: string }).type === "stream_event";
      // After the user hits Stop, q.interrupt() resolves but the SDK keeps
      // flushing trailing per-token deltas of the aborted response. Drop them so
      // the UI stops growing text after Stop. Non-stream events (the interrupt
      // marker, the final result) still flow through so the log and the
      // "interrupted" note stay correct — they just won't resurrect state below.
      if (s.interrupted && isStreamEvent) continue;
      // rate_limit_event = claude.ai subscription usage snapshot (the data the
      // CLI's /usage shows). Keep only the latest on the session and push it to
      // live clients on a dedicated channel; don't persist to history (like
      // stream_event, it's transient — persisting bloats the log and it'd
      // replay as an unrenderable "message"). The SSE route snapshots
      // s.rateLimit on connect so a fresh client gets the last known value.
      if ((msg as { type?: string }).type === "rate_limit_event") {
        const info = (msg as { rate_limit_info?: RuntimeSession["rateLimit"] }).rate_limit_info;
        if (info) {
          s.rateLimit = info;
          s.events.emit("rate_limit", info);
        }
        continue;
      }
      if (!isStreamEvent) {
        appendEvent(s.id, s.seq++, msg);
        s.history.push(msg);
        // Todo list only changes via tool calls in assistant messages. Re-derive
        // from the full history and push a `todos` snapshot to live clients when
        // it changes, so the task panel stays correct without the client having
        // to load the entire (possibly very long) transcript.
        if ((msg as { type?: string }).type === "assistant") maybeEmitTodos(s);
      }
      // Track per-token text so a client that joins mid-stream can be
      // seeded with the text that streamed before it connected. Mirrors
      // Chat.tsx exactly: append on text_delta, clear on any non-stream
      // assistant/result/user message (which marks the end of the current
      // text block — the canonical text now lives in history).
      if (isStreamEvent) {
        const delta = (msg as { event?: { delta?: { type?: string; text?: string } } }).event?.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          s.streamingText += delta.text;
        }
      } else if (msg.type === "assistant" || msg.type === "result" || msg.type === "user") {
        s.streamingText = "";
      }
      s.lastActivity = new Date();
      s.events.emit("event", msg);

      // Track the SDK session ID for resumption. Only `system: init` events
      // mark the start of a new SDK session — every other event inherits the
      // current session's id (including subagent messages, which we must NOT
      // mistake for the parent). Each resume / cwd-change spawns a new init
      // with a new session_id, so we keep the LATEST one rather than the
      // first (the prior `!s.sdkSessionId` capture would otherwise stick on
      // a stale planning-era id and break resume after an adopt).
      if (msg.type === "system" && (msg as { subtype?: string }).subtype === "init") {
        const sid = (msg as { session_id?: string }).session_id;
        if (sid && sid !== s.sdkSessionId) {
          s.sdkSessionId = sid;
          void persistSdkSessionId(s);
        }
        const initModel = (msg as { model?: string }).model;
        if (initModel && initModel !== s.model) {
          s.model = initModel;
          void updateMeta(s, (meta) => { meta.model = initModel; });
        }
      }

      // Emit file_changed when the agent creates, edits, or deletes a file so
      // the UI can refresh. "" is a valid signal (Bash mutation, path unknown) —
      // guard on null, not truthiness, or deletions would be dropped.
      const modifiedPath = extractModifiedFilePath(msg);
      if (modifiedPath !== null) {
        s.events.emit("file_changed", { path: modifiedPath });
      }

      // Remote auth flow: the runner emits `system/auth_required` when the
      // SDK reports "Not logged in" and pivots to claude setup-token. While
      // the AuthCard waits on the user, the session is genuinely awaiting a
      // user action — flip out of "running" so the "Working…" indicator
      // disappears and the UI shows the pending state instead. Flip back to
      // "running" on auth_done so the SDK restart's events render normally.
      if (msg.type === "system") {
        const sub = (msg as { subtype?: string }).subtype;
        if (sub === "auth_required" && isValidTransition(s.state, "awaiting_input")) {
          setState(s, "awaiting_input");
        } else if (
          (sub === "auth_submitted" || sub === "auth_done")
          && isValidTransition(s.state, "running")
        ) {
          // auth_submitted = code POSTed to runner, optimistic flip back.
          // auth_done     = setup-token actually finished writing creds.
          // Either signals "stop showing the AuthCard, resume working state".
          setState(s, "running");
        } else if (sub === "auth_failed" && isValidTransition(s.state, "awaiting_input")) {
          // Reopen the awaiting state — the UI's MessageStream will treat the
          // next auth_required (if the runner spawns a fresh setup-token) as
          // a new card. Until then, the error message from the auth_failed
          // event surfaces in chat.
          setState(s, "awaiting_input");
        }
      }

      // A `result` event ends the turn. Use the state machine to determine
      // the next state based on whether the agent asked a question.
      if (msg.type === "result") {
        const resultMsg = msg as { subtype?: string; error?: string; is_error?: boolean };
        // "error_during_execution" is a user interrupt, not a real error — the
        // "[Request interrupted by user]" message the SDK emits covers it.
        const isInterrupt = resultMsg.subtype === "error_during_execution";
        // Check for error results — is_error covers rate limits (429) and other
        // API errors where subtype may still be "success". Exclude interrupts.
        const isError = !isInterrupt && (resultMsg.is_error || resultMsg.subtype === "error" || !!resultMsg.error);
        // Only emit a system error event for explicit SDK errors (subtype=error or
        // error field set). Rate limit results (is_error=true) are rendered directly
        // by MessageStream from the result event — no separate system error needed.
        if (resultMsg.subtype === "error" || resultMsg.error) {
          const errorText = resultMsg.error ?? "Unknown error";
          const errMsg = {
            type: "system",
            subtype: "error",
            message: errorText,
          } as unknown as SDKMessage;
          s.history.push(errMsg);
          appendEvent(s.id, s.seq++, errMsg);
          s.events.emit("event", errMsg);
        }
        // A user interrupt already drove the session to "stopped"; don't let the
        // trailing result flip it back to idle/awaiting_input.
        if (!s.interrupted) {
          if (isError) {
            setState(s, "error");
          } else {
            const text = lastAssistantText(s.history);
            const isQuestion = /[?？]\s*['""')\]]*\s*$/.test(text.trim());
            setState(s, stateAfterResult(isQuestion));
          }
        }
        // First *successful* turn → auto-title. The model can't reliably call
        // set_session_title on turn 1 in the 1M-context Opus runtime (deferred
        // tools take a ToolSearch round-trip), so the workbench summarizes
        // turn 1 itself via a sub-query. Skipped if the title has already
        // been overridden (model or human) during the turn.
        //
        // Only on a clean turn: an errored turn (e.g. rate/session limit, where
        // subtype can still be "success" but is_error is set) or a user
        // interrupt leaves autoTitleAttempted false so the next real turn gets
        // to name the session. Otherwise the auto-title sub-query — which runs
        // on the same account — also hits the limit and the SDK's error text
        // ("You've hit your session limit…") leaks in as the title.
        if (!isError && !s.interrupted && !s.autoTitleAttempted) {
          s.autoTitleAttempted = true;
          void autoTitleFromFirstTurn(s);
        }
      } else if (msg.type === "assistant" || msg.type === "user") {
        // Buffered in-flight messages arriving after an interrupt must not
        // resurrect "running" over the user's stop.
        if (s.state !== "running" && !s.interrupted) setState(s, "running");
      }
    }
    // Query completed successfully — reset retry counter
    s.retryAttempts = 0;
    // Only transition to "stopped" if the state machine allows it.
    // This prevents overwriting "idle" (completed) or "running" (resumed).
    if (canOverwriteWithStopped(s.state)) {
      setState(s, "stopped");
    }
  } catch (err) {
    // Only bail if our query was replaced (resume / retry started a fresh
    // one). Don't gate on s.state — initial pumps fail before producing any
    // event and state stays at "running", which previously caused silent
    // hangs.
    if (s.q !== myQuery) return;

    const errorMsg = err instanceof Error ? err.message : String(err);

    // A user interrupt aborts the request mid-turn; the iterator then throws an
    // abort diagnostic. Treat it as a clean stop — the "[Request interrupted by
    // user]" message the SDK already emitted is what the UI surfaces.
    if (isInterruptError(errorMsg)) {
      setState(s, "stopped");
      return;
    }

    console.error(`[session ${s.id}] Error in pumpEvents:`, errorMsg);

    // Auto-retry for 529 (overloaded) errors with exponential backoff
    const MAX_RETRIES = 3;
    if (is529Error(errorMsg)) {
      const attempts = (s.retryAttempts ?? 0) + 1;
      s.retryAttempts = attempts;

      if (attempts <= MAX_RETRIES) {
        const delay = backoffDelay(attempts - 1);
        const retryMsg = {
          type: "system",
          subtype: "info",
          message: `API overloaded (529). Retrying in ${delay / 1000}s... (attempt ${attempts}/${MAX_RETRIES})`,
        } as unknown as SDKMessage;
        s.history.push(retryMsg);
        appendEvent(s.id, s.seq++, retryMsg);
        s.events.emit("event", retryMsg);

        // Schedule retry after backoff delay
        setTimeout(async () => {
          try {
            await retrySession(s.id);
          } catch (err) {
            console.error(`[session ${s.id}] Auto-retry failed:`, err);
          }
        }, delay);
        return; // Don't set error state — retry is in progress
      }
      // Exceeded max retries — fall through to error state
      const maxRetryMsg = `API overloaded (529). Max retries (${MAX_RETRIES}) exceeded. Use the Retry button to try again.`;
      s.events.emit("event", {
        type: "system",
        subtype: "error",
        message: maxRetryMsg,
      } as unknown as SDKMessage);
      appendEvent(s.id, s.seq++, { type: "system", subtype: "error", message: maxRetryMsg } as unknown as SDKMessage);
      setState(s, "error");
      return;
    }

    s.events.emit("event", {
      type: "system",
      subtype: "error",
      message: errorMsg,
    } as unknown as SDKMessage);
    appendEvent(s.id, s.seq++, { type: "system", subtype: "error", message: errorMsg } as unknown as SDKMessage);
    setState(s, "error");
  } finally {
    // Don't close streams if session was resumed (a new inputLog was created)
    // or if it was cleanly stopped (interrupt already closed them or will).
    if (s.state !== "running" && s.state !== "stopped") {
      void flushEvents(s.id);
      s.inputLog.end();
      // Mark the InputChannel closed too. sendInput uses this as its signal
      // that the SDK has gone away — without it, an input arriving here
      // (state=idle, streams closed, dead SDK) would silently disappear.
      s.input.close();
    }
  }
}

// Summarize the user's first message + the assistant's first text reply into
// a 3-6 word sidebar title, then apply it via renameLiveSession. Runs as a
// detached sub-query using the session's own runtime + model, so it inherits
// the same auth (no extra API key needed). Best-effort: any failure leaves
// the placeholder title in place. The model can still override later with
// set_session_title.
async function autoTitleFromFirstTurn(s: RuntimeSession): Promise<void> {
  const firstMessage = s.firstMessage;
  if (!firstMessage) return;

  // Skip if the title was already overridden during turn 1 (model called
  // set_session_title, or human renamed via the UI). generateSessionLabel
  // is the placeholder we'd have set at session creation.
  const placeholder = generateSessionLabel(firstMessage);
  if (s.title.trim() !== placeholder.trim()) return;

  const firstReply = lastAssistantText(s.history).trim().slice(0, 1500);
  const prompt = [
    "Summarize this Claude Code session as a 3-6 word title for a sidebar.",
    "Output ONLY the title — no quotes, no surrounding punctuation, no",
    'prefix like "Title:". Capitalize like a sentence. Skip filler verbs',
    'like "Implemented", "Updated", "Changed".',
    "",
    "User's first message:",
    firstMessage.slice(0, 800),
    "",
    "Assistant's first reply (excerpt):",
    firstReply || "(no text reply)",
  ].join("\n");

  try {
    const sub = createAgentQuery(s.runtime, {
      prompt,
      options: {
        cwd: s.cwd,
        // No workbench tools, no skills, no project settings — just the model.
        settingSources: [],
        ...(s.model ? { model: s.model } : {}),
      },
    });
    let text = "";
    let subErrored = false;
    for await (const msg of sub) {
      if (msg.type === "assistant") {
        const parts = (msg as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(parts)) {
          for (const part of parts as Array<{ type?: string; text?: string }>) {
            if (part.type === "text" && typeof part.text === "string") text += part.text;
          }
        }
      } else if (msg.type === "result") {
        // If the sub-query itself errored (e.g. it hit the same rate/session
        // limit as the parent), `text` may hold the SDK's error message rather
        // than a real title. Bail rather than rename the session to that.
        const r = msg as { subtype?: string; error?: string; is_error?: boolean };
        subErrored = !!(r.is_error || r.subtype === "error" || r.error);
        break;
      }
    }
    if (subErrored) return;
    const title = text
      .trim()
      .split("\n")[0]
      .replace(/^["'`*\s]+|["'`*\s.!?]+$/g, "")
      .slice(0, 60)
      .trim();
    if (title.length >= 3 && title !== placeholder) {
      await renameLiveSession(s.id, title);
    }
  } catch (e) {
    console.warn(`[session ${s.id}] auto-title failed:`, e instanceof Error ? e.message : e);
  }
}

function lastAssistantText(history: SDKMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.type !== "assistant") continue;
    // Skip synthetic messages (e.g. rate-limit notices) — they're system-generated,
    // not actual model output, and shouldn't be used for auto-titling or question detection.
    const msg = m as { message?: { content?: unknown; model?: string }; error?: string };
    if (msg.message?.model === "<synthetic>" || msg.error) continue;
    const parts = msg.message?.content;
    if (!Array.isArray(parts)) return "";
    return (parts as Array<{ type?: string; text?: string }>)
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join(" ");
  }
  return "";
}

function setState(s: RuntimeSession, state: SessionState) {
  if (s.state === state) return;

  // Validate state transition
  if (!isValidTransition(s.state, state)) {
    console.warn(
      `[session ${s.id}] Invalid state transition ${s.state} → ${state}, ignoring`
    );
    return;
  }

  const wasTerminal = isTerminalState(s.state);
  s.state = state;
  s.events.emit("state", state);

  // Track when session completes (for "New" badge logic)
  // Only set completedAt when transitioning FROM a non-terminal state TO a terminal state.
  // Transitions between terminal states (e.g., stopped → idle) shouldn't create a new "New" badge.
  if (shouldPersistState(state)) {
    if (!wasTerminal) {
      s.completedAt = new Date();
      // If a viewer is currently subscribed to this session's SSE stream
      // (i.e. the chat is open in a browser), bump seenAt to the same moment
      // so the "unread" badge never appears for them. Without this, the badge
      // flickers on for ~2.5s until the next client poll hits /seen.
      if (s.events.listenerCount("state") > 0) {
        s.seenAt = s.completedAt;
      }
    }
    void persistSessionState(s, state);
  }
}

// Called from fs.ts after a workspace is moved/renamed. With flat session
// storage, meta.json is the source of truth for which workspace a session
// belongs to — so the in-memory registry update is no longer enough on its
// own; we also walk every session meta on disk and rewrite paths whose first
// `oldPath.length` segments match `oldPath`, splicing the new prefix in.
// That handles both renames at depth and moves of an entire subtree (every
// session under the moved workspace, including grand-children, gets fixed).
export async function relocateSessionsForWorkspace(
  oldPath: string[],
  newPath: string[],
): Promise<void> {
  // In-memory registry first — live sessions need their workspacePath fixed
  // before any subsequent registry walks (subscribeFileChanges, listLiveSessions)
  // would emit a stale path.
  for (const s of registry.values()) {
    const m = matchPrefix(s.workspacePath, oldPath);
    if (m) s.workspacePath = [...newPath, ...m];
  }
  await rewriteSessionMetas((meta) => {
    if (!Array.isArray(meta.workspace)) return false;
    const m = matchPrefix(meta.workspace, oldPath);
    if (!m) return false;
    meta.workspace = [...newPath, ...m];
    return true;
  });
}

// Returns the suffix `path` has after `prefix`, or null when path doesn't
// start with prefix.
function matchPrefix(path: string[], prefix: string[]): string[] | null {
  if (path.length < prefix.length) return null;
  for (let i = 0; i < prefix.length; i++) {
    if (path[i] !== prefix[i]) return null;
  }
  return path.slice(prefix.length);
}

// Iterate every session on disk, hand its meta to `mutate`, and persist if
// `mutate` returned true. Best effort — individual failures are logged but
// don't abort the walk so a single corrupted meta.json can't strand all the
// others mid-rename.
async function rewriteSessionMetas(
  mutate: (meta: { workspace?: string[]; [k: string]: unknown }) => boolean,
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(SESSIONS_ROOT, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[relocate] could not read ${SESSIONS_ROOT}:`, (err as Error).message);
    }
    return;
  }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const metaPath = path.join(SESSIONS_ROOT, d.name, "meta.json");
    let meta: { workspace?: string[]; [k: string]: unknown };
    try { meta = JSON.parse(await fs.readFile(metaPath, "utf8")); }
    catch { continue; }
    if (!mutate(meta)) continue;
    try { await fs.writeFile(metaPath, JSON.stringify(meta, null, 2)); }
    catch (err) {
      console.warn(`[relocate] could not rewrite ${metaPath}:`, (err as Error).message);
    }
  }
}

// Move a session into a different workspace. Used by the New-Workspace
// planning flow: when the user accepts the proposed child, the session that
// produced the plan adopts that child so it lives with the workspace it
// created.
//
// With flat session storage the on-disk directory doesn't change — only the
// `workspace` field in meta.json (and the in-memory registry entry) needs to
// be updated. The agent's open log fds keep writing to the same path either
// way.
export async function moveSessionToWorkspace(
  sessionId: string,
  newWorkspacePath: string[],
): Promise<boolean> {
  const s = registry.get(sessionId);
  if (!s) return false;
  if (samePath(s.workspacePath, newWorkspacePath)) return true;

  const target = await getWorkspace(newWorkspacePath);
  if (!target) return false;

  s.workspacePath = newWorkspacePath;
  await updateMeta(s, (meta) => {
    meta.workspace = newWorkspacePath;
  });
  return true;
}

// Wrap the user's text with a hidden <system-reminder> note about the artifact
// currently open in their workspace. The UI strips the tag from the rendered
// user bubble; the agent still sees it as part of the message content.
export const OPEN_ARTIFACT_TAG = "system-reminder";
function withOpenArtifactNote(text: string, artifactPath: string): string {
  const note = `<${OPEN_ARTIFACT_TAG}>The user currently has the artifact "${artifactPath}" open in their workspace.</${OPEN_ARTIFACT_TAG}>`;
  return text ? `${note}\n\n${text}` : note;
}

export async function sendInput(id: string, text: string, openArtifact?: string): Promise<boolean> {
  const s = registry.get(id);
  if (!s) return false;

  // Prepend a hidden <system-reminder> when an artifact is open in the user's
  // workspace, so the agent knows which file the user is looking at without
  // them having to repeat it. The Chat UI strips this tag from the user
  // bubble (see MessageStream).
  const augmented = openArtifact ? withOpenArtifactNote(text, openArtifact) : text;

  // Route to resumeSession when the SDK is no longer consuming input. The
  // nominal state isn't sufficient: the SDK process can die unexpectedly
  // (e.g. `Claude Code process exited with code 1`) and leave the session in
  // state="idle" or "awaiting_input" while the input channel is closed.
  // Without this guard, sendInput would write to a closed inputLog, push into
  // a dead InputChannel, flip state to "running" — and the session would
  // appear alive but never produce events.
  if (s.input.isClosed() || s.state === "stopped" || s.state === "error") {
    return resumeSession(s, augmented, "sendInput");
  }

  // The SDK doesn't echo typed user messages in streaming-input mode, so we
  // surface them ourselves: write to inputLog, push into the input channel
  // for the agent to receive, and also append to history + emit on the event
  // bus so the UI renders the bubble.
  s.inputLog.write(JSON.stringify({ at: new Date().toISOString(), text: augmented }) + "\n");
  const msg = makeUserMessage(augmented, id);
  s.history.push(msg);
  appendEvent(s.id, s.seq++, msg);
  s.events.emit("event", msg);
  s.input.push(msg);
  s.lastActivity = new Date();
  // Sending a new message restarts a completed session — clear the sticky
  // completion flag so the UI flips back to "working" and out of "Completed".
  // Also reset retry counter since this is fresh user input.
  s.retryAttempts = 0;
  if (s.completed) {
    s.completed = false;
    void updateMeta(s, (meta) => { meta.completed = false; });
    s.events.emit("completed_changed", { completed: false });
  }
  setState(s, "running");
  return true;
}

// Extended file attachment info
export interface FileAttachmentInfo {
  name: string;
  path: string;
  mimeType: string;
  size: number;
}

// Send input with optional image attachments
export async function sendInputWithFiles(
  id: string,
  text: string,
  files: FileAttachmentInfo[],
  workspacePath: string[],
  openArtifact?: string
): Promise<boolean> {
  const s = registry.get(id);
  if (!s) return false;

  // Separate images from other files
  const imageFiles = files.filter((f) => f.mimeType.startsWith("image/"));
  const otherFiles = files.filter((f) => !f.mimeType.startsWith("image/"));

  // Build the text message with non-image file references
  let messageText = text;
  if (otherFiles.length > 0) {
    const fileRefs = otherFiles
      .map((f) => `[Attached file: ${f.path}]`)
      .join("\n");
    messageText = `${fileRefs}\n\n${text}`;
  }
  if (openArtifact) {
    messageText = withOpenArtifactNote(messageText, openArtifact);
  }

  // Route to resumeSession when the SDK is no longer consuming input — same
  // dead-SDK guard as sendInput. See its comment for rationale.
  if (s.input.isClosed() || s.state === "stopped" || s.state === "error") {
    // For resumed sessions, we can't easily add images to the resume flow.
    // Just include the text with file references.
    return resumeSession(s, messageText, "sendInputWithFiles");
  }

  // Read images and convert to base64
  const images: ImageContent[] = [];
  if (imageFiles.length > 0) {
    const ws = await getWorkspace(workspacePath);
    if (ws) {
      const artifactsDir = workspaceDir(ws);
      for (const imgFile of imageFiles) {
        try {
          const imgPath = path.join(artifactsDir, imgFile.path);
          const data = await fs.readFile(imgPath);
          const base64 = data.toString("base64");
          images.push({ mimeType: imgFile.mimeType, base64 });
        } catch (err) {
          console.error(`Failed to read image ${imgFile.path}:`, err);
        }
      }
    }
  }

  // Create the appropriate message type
  let msg;
  if (images.length > 0) {
    msg = makeUserMessageWithImages(messageText, images, id);
  } else {
    msg = makeUserMessage(messageText, id);
  }

  // Log and emit the message
  s.inputLog.write(JSON.stringify({ at: new Date().toISOString(), text: messageText, files }) + "\n");
  s.history.push(msg);
  appendEvent(s.id, s.seq++, msg);
  s.events.emit("event", msg);
  s.input.push(msg);
  s.lastActivity = new Date();
  if (s.completed) {
    s.completed = false;
    void updateMeta(s, (meta) => { meta.completed = false; });
    s.events.emit("completed_changed", { completed: false });
  }
  setState(s, "running");
  return true;
}

// Path to the SDK transcript jsonl for a given session ID at WORKSPACE_ROOT
// (the cwd every session uses). Mirrors the Claude SDK's encoding scheme:
// `~/.claude/projects/<cwd-with-slashes-replaced-by-dashes>/<sid>.jsonl`.
function sdkTranscriptPath(sdkSessionId: string): string {
  const encoded = WORKSPACE_ROOT.replaceAll("/", "-");
  return path.join(os.homedir(), ".claude", "projects", encoded, `${sdkSessionId}.jsonl`);
}

async function sdkTranscriptExists(sdkSessionId: string): Promise<boolean> {
  try {
    await fs.access(sdkTranscriptPath(sdkSessionId));
    return true;
  } catch {
    return false;
  }
}

// Resume a stopped session. Re-uses the SDK's `resume` mechanism when the
// prior transcript is still on disk; otherwise starts a fresh SDK conversation
// while keeping the visible event history intact.
async function resumeSession(s: RuntimeSession, newMessage: string, caller: string = "unknown"): Promise<boolean> {
  // Coalesce concurrent resumes for the same session id. The user's send
  // endpoint, auto-resume on boot, and any retry path can all call this at
  // the same moment for the same session; before the lock each one created
  // its own SDK subprocess against the same --resume <sdkSessionId>, which
  // is exactly how we got 8 drafts when the user asked for 4 (two
  // subprocesses both ran the user's "make calendar holds" turn from the
  // same transcript).
  //
  // A second caller can't just return the in-flight promise — that would
  // drop its own newMessage on the floor (only the first caller's message
  // gets pushed into the fresh subprocess). Instead, await the resume and
  // then route this caller's message through sendInput, which will hit the
  // live input channel like any other turn.
  const inflight = resumeInFlight.get(s.id);
  if (inflight) {
    console.log(`[resumeSession] ${s.id} caller=${caller} awaiting in-flight resume`);
    await inflight;
    return sendInput(s.id, newMessage);
  }
  const promise = doResumeSession(s, newMessage, caller);
  resumeInFlight.set(s.id, promise);
  try {
    return await promise;
  } finally {
    resumeInFlight.delete(s.id);
  }
}

async function doResumeSession(s: RuntimeSession, newMessage: string, caller: string = "unknown"): Promise<boolean> {
  console.log(`[resumeSession] ${s.id} caller=${caller} state=${s.state} hasQuery=${!!s.q} sdkSessionId=${s.sdkSessionId} msg="${newMessage.slice(0, 60)}"`);

  // Ownership check — same logic as auto-resume. If another live worker
  // owns this session, our request landed on the wrong one; spawning a
  // fresh SDK here would race two subprocesses against the same on-disk
  // transcript (the bug that produced 8 drafts from one "make 4 calendar
  // holds" request). Bail with a user-visible error. Otherwise reclaim
  // any leftover SDK subprocesses before we spawn the replacement.
  const own = await inspectOwnership(s.workspacePath, s.id, s.sdkSessionId);
  if (own.ownedByOther) {
    console.warn(`[resumeSession] ${s.id} aborting — owned by another worker`);
    const errMsg = {
      type: "system",
      subtype: "error",
      message: "This session is being handled by another server worker (Next.js dev). Please refresh the page and try again.",
    } as unknown as SDKMessage;
    s.history.push(errMsg);
    appendEvent(s.id, s.seq++, errMsg);
    s.events.emit("event", errMsg);
    return false;
  }
  await killReclaimableSdks(own.reclaimable, `resume ${s.id}`);

  // Decide whether the SDK can actually pick up where the prior turn left off.
  // Both pieces must hold: we kept the session_id in meta.json, AND its on-disk
  // transcript is still where the SDK expects it. If the transcript is gone
  // (legacy fallout: the pre-WORKSPACE_ROOT-cwd refactor stored transcripts
  // under task-folder-encoded dirs, and the buggy relocate in fs.ts moved them
  // to mangled paths that got cleaned up later), passing `resume:` to the SDK
  // silently no-ops — the user's send button does nothing and no agent turn
  // runs. Fall through to a fresh SDK conversation: the user-visible history
  // (events.jsonl) is preserved, only the agent's SDK memory of those turns
  // is lost. Same path covers sessions that never got an sdkSessionId at all
  // (older sessions before tracking, or sessions that crashed before init).
  // The local-transcript check only applies to the Claude runtime (it resumes
  // from an on-disk SDK transcript). Cloud resumes via the DO (restore +
  // `resume` server-side) and Gemini from its runtimeStateDir history, so for
  // those runtimes the on-disk check is a false alarm — skip it (no scary
  // "couldn't resume" notice, don't clear their session id).
  const isLocalSdkRuntime = s.runtime === "claude";
  const canResume = isLocalSdkRuntime && !!s.sdkSessionId && (await sdkTranscriptExists(s.sdkSessionId));
  const lostTranscript = isLocalSdkRuntime && !!s.sdkSessionId && !canResume;
  if (lostTranscript) {
    s.sdkSessionId = null;
    void updateMeta(s, (meta) => {
      meta.sdkSessionId = null;
    });
  }

  // Hard-stop the existing in-process query before creating a new one.
  // close() asks the SDK CLI subprocess to terminate (SIGTERM, then SIGKILL
  // after 5s). The previous implementation used interrupt() with a 2s
  // timeout, which only stops the current turn and leaves the subprocess
  // alive — a fresh query with resume:<same sdkSessionId> would then attach
  // to the same transcript and both subprocesses would run turns in parallel.
  //
  // Detach s.q BEFORE close: the old pumpEvents loop's iterator throws an
  // exit error when its subprocess dies, and its catch block bails silently
  // only when `s.q !== myQuery`. If we leave s.q pointing at the dying
  // query, the catch instead surfaces "terminated by signal SIGTERM/SIGKILL"
  // as a user-visible session error.
  const oldQ = s.q;
  s.q = undefined as unknown as AgentQuery;
  if (oldQ) {
    try { oldQ.close(); }
    catch (err) { console.warn(`[resumeSession] ${s.id} close() failed:`, (err as Error).message); }
  }

  try {
    // Re-open the log files for appending. Workspace lookup is still
    // performed for validation (it's used downstream for prompts/MCPs) but
    // no longer determines the on-disk session location.
    const ws = await getWorkspace(s.workspacePath);
    if (!ws) throw new Error("Workspace not found");

    const dir = sessionDir(s.id);

    // Re-create log streams
    registerSessionLog(s.id, path.join(dir, "events.jsonl"));
    s.inputLog = createWriteStream(path.join(dir, "input.jsonl"), { flags: "a" });

    // Create a new input channel
    s.input = new InputChannel();

    // If the prior SDK transcript was missing, tell the user. Persist to history
    // + events.jsonl so the notice survives reload, not just live SSE.
    if (lostTranscript) {
      const notice = {
        type: "system",
        subtype: "info",
        message:
          "Couldn't resume the prior agent context — its SDK transcript is missing on disk. " +
          "Starting a fresh agent session. The conversation above is preserved but the agent " +
          "doesn't remember it.",
      } as unknown as SDKMessage;
      s.history.push(notice);
      appendEvent(s.id, s.seq++, notice);
      s.events.emit("event", notice);
    }

    const systemPrompt = await buildContextSystemPrompt(s.workspacePath);

    // Create new query, re-using the session's existing pendingPermissions
    // map + events emitter so a permission request emitted mid-resume reaches
    // the same SSE subscribers. `resume:` is only passed when canResume held
    // — otherwise the call starts a fresh SDK conversation (see the comment
    // at the top of this function for why).
    s.q = createAgentQuery(s.runtime, {
      prompt: s.input,
      options: {
        // s.cwd is set to WORKSPACE_ROOT for new sessions; for old
        // sessions resumed from disk, force-override since their stored
        // cwd may be the workspace folder (pre-refactor).
        cwd: WORKSPACE_ROOT,
        ...(canResume ? { resume: s.sdkSessionId! } : {}),
        permissionMode: s.permissionMode,
        settingSources: ["project", "user"],
        canUseTool: buildCanUseTool(s.pendingPermissions, s.events),
        toolAliases: STATIC_TOOL_ALIASES,
        mcpServers: await buildStaticWorkbenchMcps(s.id, s.workspacePath),
        workbenchToolGroups: buildStaticWorkbenchToolGroups(s.id, s.workspacePath),
        runtimeStateDir: dir,
        systemPrompt,
        ...(s.model ? { model: s.model } : {}),
        ...(s.effort ? { effort: s.effort } : {}),
      },
    }, { workspacePath: s.workspacePath });

    // Check if there are pending tool_uses without tool_results.
    // If so, inject synthetic tool_results first so the conversation is valid.
    const pendingToolIds = findPendingToolUses(s.history);
    if (pendingToolIds.length > 0) {
      const toolResults = pendingToolIds.map(id => ({
        type: "tool_result" as const,
        tool_use_id: id,
        content: "[Tool execution interrupted by server restart]",
        is_error: true,
      }));
      const toolResultMsg = {
        type: "user",
        message: {
          role: "user",
          content: toolResults,
        },
        parent_tool_use_id: null,
        session_id: s.id,
      } as unknown as SDKUserMessage;
      s.history.push(toolResultMsg);
      appendEvent(s.id, s.seq++, toolResultMsg);
      s.events.emit("event", toolResultMsg);
      s.input.push(toolResultMsg);
    }

    // Write the new message to logs
    s.inputLog.write(JSON.stringify({ at: new Date().toISOString(), text: newMessage }) + "\n");
    const msg = makeUserMessage(newMessage, s.id);
    s.history.push(msg);
    appendEvent(s.id, s.seq++, msg);
    s.events.emit("event", msg);

    // Push the message to the input channel
    s.input.push(msg);
    s.lastActivity = new Date();
    s.completedAt = null; // Clear unread-tracking timestamp — session is running again
    // Clear the sticky "Completed" mark too — resuming means the user wants
    // more work done, so the session should not appear completed anymore.
    if (s.completed) {
      s.completed = false;
      void updateMeta(s, (meta) => { meta.completed = false; });
      s.events.emit("completed_changed", { completed: false });
    }
    // Clear the interrupt latch — a fresh turn is starting, so the new
    // pumpEvents loop should track "running" normally again. Drop any
    // leftover streamingText from a prior aborted turn (no final assistant
    // message arrived to reset it) so the new turn's deltas accumulate
    // from a clean slate.
    s.interrupted = false;
    s.streamingText = "";
    setState(s, "running");
    void persistOwnerPid(s);

    // Start pumping events from the new query
    void pumpEvents(s);

    return true;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[session ${s.id}] Failed to resume:`, errorMsg);
    const resumeFailMsg = {
      type: "system",
      subtype: "error",
      message: `Failed to resume session: ${errorMsg}`,
    } as unknown as SDKMessage;
    s.history.push(resumeFailMsg);
    appendEvent(s.id, s.seq++, resumeFailMsg);
    s.events.emit("event", resumeFailMsg);
    return false;
  }
}

export async function interrupt(id: string): Promise<boolean> {
  const s = registry.get(id);
  if (!s) return false;
  // Set BEFORE awaiting q.interrupt(): the pumpEvents loop is concurrently
  // consuming events, and the SDK keeps flushing buffered in-flight messages
  // while/after the interrupt resolves. The flag tells that loop to stop
  // resurrecting "running" so the stop actually sticks.
  s.interrupted = true;
  try {
    await s.q.interrupt();
    setState(s, "stopped");
    s.input.close();
    return true;
  } catch {
    // SDK interrupt failed — fall back to force-stop
    return forceStop(id);
  }
}

// Force-stop a session that's stuck. Unlike interrupt(), this doesn't try to
// call the SDK — it just marks the session as stopped and cleans up resources.
// Use this when a session is stuck in "running" but the SDK is unresponsive.
export function forceStop(id: string): boolean {
  const s = registry.get(id);
  if (!s) return false;
  try {
    s.interrupted = true;
    setState(s, "stopped");
    s.input.close();
    forgetSession(s.id);
    s.inputLog.end();
    return true;
  } catch {
    return false;
  }
}

// Retry a session that's in error state. Re-sends the last user message
// (if any) to restart the conversation. Returns true if retry started.
export async function retrySession(id: string): Promise<boolean> {
  const s = registry.get(id);
  if (!s) return false;
  if (s.state !== "error" && s.state !== "stopped") return false;

  // Find the last user message to retry. History entries follow the SDK
  // envelope shape `{ type: "user", message: { role, content }, ... }` (see
  // makeUserMessage in input-channel.ts), so read content from msg.message,
  // not the top level. Skip user-typed envelopes whose content is a
  // tool_result array — those are synthetic tool replies, not user input.
  let lastUserMessage = "";
  for (let i = s.history.length - 1; i >= 0; i--) {
    const msg = s.history[i] as { type?: string; message?: { content?: unknown } };
    if (msg.type !== "user") continue;
    const content = msg.message?.content;
    if (typeof content === "string") {
      lastUserMessage = content;
      break;
    }
    if (Array.isArray(content)) {
      const isToolResult = content.some(
        (b: { type?: string }) => b?.type === "tool_result",
      );
      if (isToolResult) continue;
      const textBlock = content.find((b: { type?: string }) => b?.type === "text");
      if (textBlock && typeof (textBlock as { text?: string }).text === "string") {
        lastUserMessage = (textBlock as { text: string }).text;
        break;
      }
    }
  }

  // Emit a system message noting the retry
  const retryNotice = {
    type: "system",
    subtype: "info",
    message: "Retrying after error...",
  } as unknown as SDKMessage;
  s.history.push(retryNotice);
  appendEvent(s.id, s.seq++, retryNotice);
  s.events.emit("event", retryNotice);

  // Resume the session - sendInput handles the state transition
  // If no user message found, just use an empty prompt to restart
  const success = await sendInput(id, lastUserMessage || "continue");
  return success;
}

// Mark a session as seen by updating its meta.json with a seenAt timestamp.
// Also updates the in-memory seenAt for live sessions.
// Returns true if successful, false if session not found.
export async function markSessionSeen(
  workspacePath: string[],
  sessionId: string,
): Promise<boolean> {
  const now = new Date();

  // Live session: route through updateMeta so this serializes with the
  // setState / persistSdkSessionId writers (otherwise concurrent writes can
  // corrupt meta.json).
  const liveSession = registry.get(sessionId);
  if (liveSession) {
    liveSession.seenAt = now;
    await updateMeta(liveSession, (meta) => {
      meta.seenAt = now.toISOString();
    });
    return true;
  }

  // Dead session (not in registry): no other writer can race, direct write is fine.
  const ws = await getWorkspace(workspacePath);
  if (!ws) return false;

  const metaPath = path.join(sessionDir(sessionId), "meta.json");
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const meta = JSON.parse(raw);
    meta.seenAt = now.toISOString();
    const tmpPath = metaPath + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(meta, null, 2));
    await fs.rename(tmpPath, metaPath);
    return true;
  } catch {
    return false;
  }
}

// Mark a session as completed (or un-complete it). Sticky across reloads via
// meta.json. The flag is orthogonal to runtime state — a session can be live
// and completed, in which case the UI offers Reopen; sending another message
// auto-unmarks (see sendInput / sendInputWithFiles / resumeSession).
export async function markSessionCompleted(
  workspacePath: string[],
  sessionId: string,
  value: boolean,
): Promise<boolean> {
  // Marking complete also clears the "unread" badge: a completed session
  // shouldn't still nag the user. Unread is derived from completedAt > seenAt,
  // so bumping seenAt to now drops it. We only do this when value=true; on
  // reopen we leave seenAt alone (it's accurate either way).
  const now = new Date();

  // Live session: route through updateMeta so this serializes with the
  // setState / persistSdkSessionId writers (concurrent writes corrupt meta.json).
  const liveSession = registry.get(sessionId);
  if (liveSession) {
    liveSession.completed = value;
    if (value) liveSession.seenAt = now;
    await updateMeta(liveSession, (meta) => {
      meta.completed = value;
      if (value) meta.seenAt = now.toISOString();
    });
    liveSession.events.emit("completed_changed", { completed: value });
    return true;
  }

  // Dead session (not in registry): no other writer can race, direct write is fine.
  const ws = await getWorkspace(workspacePath);
  if (!ws) return false;

  const metaPath = path.join(sessionDir(sessionId), "meta.json");
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const meta = JSON.parse(raw);
    meta.completed = value;
    if (value) meta.seenAt = now.toISOString();
    const tmpPath = metaPath + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(meta, null, 2));
    await fs.rename(tmpPath, metaPath);
    return true;
  } catch {
    return false;
  }
}

// Rename a session by updating its meta.json `name` field.
// Also updates the in-memory title for live sessions.
export async function renameSession(
  workspacePath: string[],
  sessionId: string,
  newName: string,
): Promise<boolean> {
  const trimmedName = newName.trim();

  // Update in-memory title for live sessions
  const liveSession = registry.get(sessionId);
  if (liveSession) {
    liveSession.title = trimmedName;
  }

  const ws = await getWorkspace(workspacePath);
  if (!ws) return !!liveSession; // Return true if we at least updated in-memory

  const metaPath = path.join(sessionDir(sessionId), "meta.json");
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const meta = JSON.parse(raw);
    meta.name = trimmedName;
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    return true;
  } catch {
    return !!liveSession; // Return true if we at least updated in-memory
  }
}

// Delete a session by removing its entire directory.
// Returns true if successful, false if session not found or still running.
export async function deleteSession(
  workspacePath: string[],
  sessionId: string,
): Promise<boolean> {
  // Check if session is in registry
  const liveSession = registry.get(sessionId);
  if (liveSession) {
    // Only block deletion if session is actively running
    if (liveSession.state === "running") {
      return false;
    }
    // Session is stopped/idle/error — clean up streams and remove from registry
    try {
      liveSession.input.close();
      forgetSession(liveSession.id);
      liveSession.inputLog.end();
    } catch {
      // Ignore stream cleanup errors
    }
    registry.delete(sessionId);
  }

  const ws = await getWorkspace(workspacePath);
  if (!ws) return false;

  const dir = sessionDir(sessionId);
  try {
    // Check directory exists before attempting delete
    await fs.access(dir);
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// Inject a system message into a live session. Used to add confirmation
// messages (e.g., when a plan is approved) that appear in the chat stream.
// Returns true if the session was found and message was injected.
export function injectSystemMessage(id: string, message: string): boolean {
  const s = registry.get(id);
  if (!s) return false;

  const msg = {
    type: "system" as const,
    subtype: "info" as const,
    message,
  } as unknown as SDKMessage;

  s.history.push(msg);
  appendEvent(s.id, s.seq++, msg);
  s.events.emit("event", msg);
  s.lastActivity = new Date();

  return true;
}
