import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { createWriteStream, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
  deleteSessionEvents,
  registerSessionLog,
} from "./cloud-events";
import { getProject, getTask, taskDir, WORKSPACE_ROOT, PROJECTS_DIR, listProjects, projectDir, reconcileSessionsOnDisk } from "./fs";
import { buildContextSystemPrompt, generateSessionLabel } from "./sessions/prompts";
import { extractTodosFromMessages } from "./todos";
import { updateMeta, persistSdkSessionId, persistSessionState } from "./sessions/meta";
import {
  buildPlanningTools,
  buildTaskPlanningTools,
  buildTaskPlanningSystemPrompt,
  PLANNING_SYSTEM_PROMPT,
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
  projectSlug: string,
  taskSlug: string,
): Array<{ name: string; tools: WorkbenchTool[] }> {
  return [
    { name: "workbench-comments", tools: buildCommentsTools(projectSlug, taskSlug) },
    { name: "workbench-session", tools: buildSessionTools(sessionId, projectSlug, taskSlug) },
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
  // eslint-disable-next-line no-var
  var __wb_session_registry: Map<string, RuntimeSession> | undefined;
  // eslint-disable-next-line no-var
  var __wb_watchdog_interval: ReturnType<typeof setInterval> | undefined;
  // eslint-disable-next-line no-var
  var __wb_session_registry_events: EventEmitter | undefined;
  // eslint-disable-next-line no-var
  var __wb_reconciled: boolean | undefined;
}
const registry: Map<string, RuntimeSession> =
  globalThis.__wb_session_registry ?? (globalThis.__wb_session_registry = REGISTRY);

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

// Subscribe to file_changed events from every live session matching
// (projectSlug, taskSlug), including sessions added after this call. Returns
// an unsubscribe function. Used by the multiplexed /api/file-events/stream
// endpoint so one browser connection covers all sessions on a task.
export function subscribeFileChanges(
  projectSlug: string,
  taskSlug: string,
  listener: (data: { path: string; sessionId: string }) => void,
): () => void {
  const attached = new Map<string, (data: { path: string }) => void>();
  const attach = (s: RuntimeSession) => {
    if (s.projectSlug !== projectSlug || s.taskSlug !== taskSlug) return;
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

// Subscribe to open_artifact events from every live session matching
// (projectSlug, taskSlug), including sessions added after this call. These are
// emitted by the workbench-session.open_artifact tool so an agent can push a
// freshly-saved artifact into the user's artifact panel. Returns an unsubscribe
// function. Multiplexed by /api/file-events/stream alongside file_changed.
export function subscribeOpenArtifact(
  projectSlug: string,
  taskSlug: string,
  listener: (data: { path: string; sessionId: string }) => void,
): () => void {
  const attached = new Map<string, (data: { path: string }) => void>();
  const attach = (s: RuntimeSession) => {
    if (s.projectSlug !== projectSlug || s.taskSlug !== taskSlug) return;
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

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes — watchdog fallback with error emit
const IDLE_EVICT_MS = 5 * 60 * 1000;      // idle this long → close streams + transition to stopped
const WATCHDOG_INTERVAL_MS = 60 * 1000;   // check every minute

// Heartbeat used to distinguish a genuine cold start (the whole `next dev`
// process tree was down) from Next.js dev churn — HMR re-evals and worker /
// helper-process recycles that all re-run this module's top-level code. Auto-
// resume must only fire on a true restart; otherwise every churn re-pushes a
// "[Server restarted...]" prompt into whatever session was mid-turn (we've
// seen 16+ stack up in a single uninterrupted dev run). A PID guard is no good
// here because in dev there is no single stable "server" PID — parent, worker
// and short-lived helpers all execute this file under different PIDs. Instead
// the watchdog touches a heartbeat file every minute while *any* part of the
// tree is alive; on boot, a fresh heartbeat means the server was up moments
// ago (churn → skip), a stale/absent one means a real cold start (→ resume).
const HEARTBEAT_FILE = path.join(
  os.tmpdir(),
  `cowork-server-${createHash("sha1").update(process.cwd()).digest("hex").slice(0, 8)}.heartbeat`,
);
const HEARTBEAT_STALE_MS = 2 * WATCHDOG_INTERVAL_MS; // tolerate one missed tick

function touchHeartbeat(): void {
  // Sync write: called from setInterval and boot init where we don't await.
  try { writeFileSync(HEARTBEAT_FILE, String(Date.now())); } catch { /* best effort */ }
}

// True iff the heartbeat is stale/absent — i.e. the server tree was NOT alive
// within the last couple of watchdog intervals, so this boot is a real cold
// start rather than dev churn. Touches the heartbeat before returning so the
// next churn within this same tree sees it fresh even before the first
// watchdog tick lands.
function isColdStart(): boolean {
  let cold = true;
  try {
    const ts = parseInt(readFileSync(HEARTBEAT_FILE, "utf8"), 10);
    if (Number.isFinite(ts) && Date.now() - ts < HEARTBEAT_STALE_MS) cold = false;
  } catch { /* missing/unreadable → cold start */ }
  touchHeartbeat();
  return cold;
}

// Runtime contract: any session whose streams have been closed MUST be in
// state "stopped". sendInput dispatches by state — "running"/"idle" goes to
// the live-write path that pushes into the InputChannel and writes to
// inputLog. If streams are closed but state still says "idle", that write
// silently no-ops and the agent never sees the message — that's the "session
// stuck after 5 min" symptom. So the watchdog closes streams AND transitions
// state to stopped together. resumeSession is responsible for re-opening
// streams when the user sends another message.
function runWatchdog() {
  // Mark the server tree as alive so a boot that follows soon after is
  // recognised as dev churn rather than a cold start (see isColdStart).
  touchHeartbeat();
  const now = Date.now();
  for (const s of registry.values()) {
    // A session blocked on a user decision (ExitPlanMode approval or an
    // AskUserQuestion) is "running" only because the SDK turn is parked
    // awaiting the user — no events flow, so lastActivity goes stale even
    // though nothing is wrong. Don't let the watchdog kill it out from under
    // a pending card; the user may take minutes to answer.
    if (
      s.pendingPermissions.size > 0
      || (s.pendingQuestions?.size ?? 0) > 0
      || (s.pendingCompletions?.size ?? 0) > 0
    ) continue;
    const sinceActivity = now - s.lastActivity.getTime();
    if (s.state === "running" && sinceActivity > STALE_THRESHOLD_MS) {
      console.warn(`[watchdog] Session ${s.id} stuck in running state for ${Math.round(sinceActivity / 1000)}s — auto-stopping`);
      try {
        s.events.emit("event", {
          type: "system",
          subtype: "error",
          message: "Session timed out due to inactivity",
        } as unknown as SDKMessage);
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
  globalThis.__wb_watchdog_interval = setInterval(runWatchdog, WATCHDOG_INTERVAL_MS);
  // Don't prevent process exit
  if (globalThis.__wb_watchdog_interval.unref) {
    globalThis.__wb_watchdog_interval.unref();
  }
}

// On first boot, walk every session on disk and fix any meta.json whose
// project/task/cwd drifted from the actual folder it lives in (e.g. a user
// renamed a project folder outside the rename API). Fire-and-forget — the
// registry is empty at boot, so this can race with the first incoming
// request harmlessly: either the request reads pre-fix meta or post-fix
// meta, both are valid JSON. The next restoreSession after reconciliation
// sees the corrected values.
//
// Defer to the next tick because sessions.ts ↔ fs.ts is a circular import;
// calling the reconciler synchronously here would hit a TDZ error on
// PROJECTS_DIR depending on which module the loader entered first.
//
// Two guards, because neither alone is enough in Next.js dev:
//   - globalThis.__wb_reconciled is a fast in-process flag, but dev sometimes
//     re-evals this module in a fresh VM context whose globalThis isn't shared,
//     so the flag reads `undefined` and we'd run again.
//   - isColdStart() is the real gate: it consults the on-disk heartbeat to tell
//     a true cold start (resume interrupted sessions) from dev churn — HMR and
//     worker/helper recycles that all re-run this top-level code (skip, so we
//     don't spam "[Server restarted...]" prompts).
if (!globalThis.__wb_reconciled) {
  globalThis.__wb_reconciled = true;
  setImmediate(async () => {
    // Always run reconciliation — it's idempotent and cheap.
    await reconcileSessionsOnDisk();
    // Resume sessions that were mid-process when the server died. The
    // function itself checks whether each session is already in the
    // registry (preserved via globalThis during HMR) and skips those,
    // so we don't need the isColdStart() gate here anymore.
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
      });
    }
    return { behavior: "allow", updatedInput: input };
  };
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
  context?: { projectSlug: string; taskSlug: string },
): AgentQuery {
  // The remote runtime needs project/task identity to forward to the
  // controller (the cwd alone is just the workspace root). Inject here so
  // callers don't have to remember which runtimes need which extras.
  const withRemote =
    runtime === "remote" && context
      ? { ...opts, remote: { project: context.projectSlug, task: context.taskSlug } }
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
      projectSlug: s.projectSlug,
      taskSlug: s.taskSlug,
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

async function discoverFromDir(sessDir: string, projectSlug: string, taskSlug: string, liveIds: Set<string>): Promise<SessionSummary[]> {
  const out: SessionSummary[] = [];
  let dirents: import("node:fs").Dirent[];
  try { dirents = await fs.readdir(sessDir, { withFileTypes: true }); }
  catch { return out; }
  for (const d of dirents) {
    if (!d.isDirectory() || liveIds.has(d.name)) continue;
    const id = d.name;
    const metaPath = path.join(sessDir, id, "meta.json");
    const inputPath = path.join(sessDir, id, "input.jsonl");
    let meta: { startedAt?: string; name?: string; seenAt?: string; finalState?: SessionState; lastActivity?: string; completedAt?: string; completed?: boolean; runtime?: SessionRuntime; model?: string | null; effort?: EffortLevel | null } = {};
    try { meta = JSON.parse(await fs.readFile(metaPath, "utf8")); } catch { /* missing */ }
    // Prefer generated name from meta.json; fall back to first message for legacy sessions
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
    // otherwise fall back to "idle" (assume completed) for historical sessions
    const state: SessionState = meta.finalState ?? "idle";
    out.push({
      id,
      projectSlug,
      taskSlug,
      state,
      title,
      startedAt: meta.startedAt ?? lastActivity,
      lastActivity,
      isLive: false,
      unread,
      completed: meta.completed === true,
      hasPendingPrompt: false, // historical sessions have no in-memory pending state
      runtime: meta.runtime ?? "claude",
      model: meta.model ?? null,
      effort: meta.effort ?? null,
    });
  }
  return out;
}

// Walk workspace for session folders so they persist across restarts.
// Includes project-level sessions (`projects/<project>/sessions/`) and
// task-level sessions (`projects/<project>/<task>/sessions/`).
export async function listAllSessions(): Promise<SessionSummary[]> {
  const live = listLiveSessions();
  const liveIds = new Set(live.map((s) => s.id));
  const projects = await listProjects();
  const out: SessionSummary[] = [...live];

  for (const p of projects) {
    // Project-level sessions
    out.push(...await discoverFromDir(
      path.join(PROJECTS_DIR, p.folderName, "sessions"),
      p.slug, "", liveIds,
    ));
    for (const t of p.tasks) {
      out.push(...await discoverFromDir(
        path.join(PROJECTS_DIR, p.folderName, t.folderName, "sessions"),
        p.slug, t.slug, liveIds,
      ));
    }
  }

  out.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
  return out;
}

// Read a historical session's events from the D1 cowork-sessions-marco table.
// The projectSlug/taskSlug args remain for parity with the rest of the API but
// are only used for the project/task existence check — events themselves are
// keyed solely by session id.
//
// Pagination: offset is from the END (offset=0 = most recent `limit` events).
export async function readSessionHistory(
  projectSlug: string,
  taskSlug: string,
  id: string,
  limit?: number,
  offset: number = 0,
): Promise<{ events: unknown[]; total: number; hasMore: boolean } | null> {
  const project = await getProject(projectSlug);
  if (!project) return null;
  let eventsPath: string;
  if (!taskSlug) {
    eventsPath = path.join(PROJECTS_DIR, project.folderName, "sessions", id, "events.jsonl");
  } else {
    const task = project.tasks.find((t) => t.slug === taskSlug);
    if (!task) return null;
    eventsPath = path.join(PROJECTS_DIR, project.folderName, task.folderName, "sessions", id, "events.jsonl");
  }
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
  projectSlug: string,
  taskSlug: string,
  id: string,
): Promise<RuntimeSession | null> {
  // Check if already in registry
  const existing = registry.get(id);
  if (existing) return existing;

  const project = await getProject(projectSlug);
  if (!project) return null;

  let sessionDir: string;
  if (!taskSlug) {
    sessionDir = path.join(PROJECTS_DIR, project.folderName, "sessions", id);
  } else {
    const task = project.tasks.find((t) => t.slug === taskSlug);
    if (!task) return null;
    sessionDir = path.join(PROJECTS_DIR, project.folderName, task.folderName, "sessions", id);
  }
  // The agent's runtime cwd is always the workspace root (see startSession
  // comment). Stored on the RuntimeSession so resume keeps it consistent.
  const cwd = WORKSPACE_ROOT;

  // Read meta.json
  const metaPath = path.join(sessionDir, "meta.json");
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
  registerSessionLog(id, path.join(sessionDir, "events.jsonl"));
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
    projectSlug,
    taskSlug,
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

async function findRunningSessionsInDir(
  sessDir: string,
  projectSlug: string,
  taskSlug: string,
): Promise<Array<{ projectSlug: string; taskSlug: string; id: string }>> {
  const out: Array<{ projectSlug: string; taskSlug: string; id: string }> = [];
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(sessDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    // Skip sessions already in the registry — they're still live (preserved
    // via globalThis during HMR) and don't need resume.
    if (registry.has(d.name)) continue;
    const metaPath = path.join(sessDir, d.name, "meta.json");
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
      // sdkSessionId is required: resume() needs it to find the SDK's
      // transcript. A session that crashed before the first `init` event has
      // no transcript to resume against — skip it. Also skip "resuming" state
      // which means another worker is already handling this session.
      // Remote (Docker) sessions are also skipped: their container is orphaned
      // after a cowork restart and auto-resume would spawn a fresh container
      // per session at boot — slow, noisy, and dependent on Docker being up.
      // The user resumes them manually by sending a message.
      if (
        meta.finalState === "running"
        && meta.sdkSessionId
        && meta.runtime !== "remote"
      ) {
        out.push({ projectSlug, taskSlug, id: d.name });
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

async function releaseAutoResumeLock(): Promise<void> {
  try { await fs.unlink(AUTO_RESUME_LOCK); } catch { /* best effort */ }
}

export async function autoResumeRunningSessions(): Promise<{ resumed: number; failed: number }> {
  // Acquire lock to prevent multiple workers from resuming the same sessions.
  // Don't release the lock — let it expire naturally (LOCK_STALE_MS = 30s).
  // This ensures all workers that start within 30s will skip auto-resume,
  // preventing duplicate "[Server restarted]" messages.
  if (!(await acquireAutoResumeLock())) {
    console.log("[auto-resume] Skipping — another worker is handling it");
    return { resumed: 0, failed: 0 };
  }

  return await doAutoResume();
}

async function doAutoResume(): Promise<{ resumed: number; failed: number }> {
  let projects;
  try {
    projects = await listProjects();
  } catch (err) {
    console.warn(`[auto-resume] could not list projects:`, (err as Error).message);
    return { resumed: 0, failed: 0 };
  }

  const candidates: Array<{ projectSlug: string; taskSlug: string; id: string }> = [];
  for (const p of projects) {
    candidates.push(...await findRunningSessionsInDir(
      path.join(PROJECTS_DIR, p.folderName, "sessions"),
      p.slug, "",
    ));
    for (const t of p.tasks) {
      candidates.push(...await findRunningSessionsInDir(
        path.join(PROJECTS_DIR, p.folderName, t.folderName, "sessions"),
        p.slug, t.slug,
      ));
    }
  }

  if (candidates.length === 0) return { resumed: 0, failed: 0 };
  console.log(`[auto-resume] Found ${candidates.length} session(s) to resume`);

  let resumed = 0;
  let failed = 0;
  for (const c of candidates) {
    try {
      const s = await restoreSession(c.projectSlug, c.taskSlug, c.id);
      if (!s) { failed++; continue; }
      // Clear finalState immediately so other workers (Next.js dev mode runs
      // multiple) don't also try to resume this session.
      await updateMeta(s, (meta) => { meta.finalState = "resuming"; });
      const ok = await resumeSession(s, RESUME_PROMPT);
      if (ok) {
        resumed++;
        console.log(`[auto-resume] Resumed session ${c.id} (${c.projectSlug}/${c.taskSlug})`);
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      console.error(`[auto-resume] Failed to resume ${c.id}:`, (err as Error).message);
    }
  }
  console.log(`[auto-resume] Done: ${resumed} resumed, ${failed} failed`);
  return { resumed, failed };
}

export interface StartSessionParams {
  projectSlug: string;
  taskSlug: string;
  firstMessage: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  model?: string;
  effort?: EffortLevel;
  runtime?: SessionRuntime;       // defaults to "claude"
}

export async function startSession(p: StartSessionParams): Promise<RuntimeSession> {
  const runtime: SessionRuntime = p.runtime ?? "claude";
  const project = await getProject(p.projectSlug);
  const task = await getTask(p.projectSlug, p.taskSlug);
  if (!project || !task) throw new Error("unknown project/task");

  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}--${randomUUID().slice(0, 6)}`;
  const name = generateSessionLabel(p.firstMessage);
  // The agent runs with cwd = workspace root so CLAUDE.md / GEMINI.md at
  // the root are picked up by the runtime, and the agent has full access
  // to the projects/ tree without needing additionalDirectories. The
  // task identity + path is supplied via the system prompt (see
  // sessions/prompts.ts). Session persistence (events.jsonl, meta.json)
  // still lives under the task folder.
  const cwd = WORKSPACE_ROOT;
  const sessionDir = path.join(taskDir(project, task), "sessions", id);
  await fs.mkdir(sessionDir, { recursive: true });

  await fs.writeFile(
    path.join(sessionDir, "meta.json"),
    JSON.stringify(
      {
        id,
        name,
        project: p.projectSlug,
        task: p.taskSlug,
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

  registerSessionLog(id, path.join(sessionDir, "events.jsonl"));
  const inputLog = createWriteStream(path.join(sessionDir, "input.jsonl"), { flags: "a" });

  const input = new InputChannel();
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const pendingPermissions = new Map<string, PendingPermission>();
  const pendingQuestions = new Map<string, PendingQuestion>();
  const pendingCompletions = new Map<string, PendingCompletion>();

  // First message
  const firstMsg = makeUserMessage(p.firstMessage, id);
  inputLog.write(JSON.stringify({ at: new Date().toISOString(), text: p.firstMessage }) + "\n");
  input.push(firstMsg);

  const systemPrompt = await buildContextSystemPrompt(p.projectSlug, p.taskSlug, name);
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
      mcpServers: buildStaticWorkbenchMcps(id, p.projectSlug, p.taskSlug),
      workbenchToolGroups: buildStaticWorkbenchToolGroups(id, p.projectSlug, p.taskSlug),
      runtimeStateDir: sessionDir,
      systemPrompt,
      ...(p.model ? { model: p.model } : {}),
      ...(p.effort ? { effort: p.effort } : {}),
    },
    // RemoteRuntime needs project/task to provision a container against the
    // right task folder. Other runtimes ignore this block.
    remote: { project: p.projectSlug, task: p.taskSlug },
  });

  const now = new Date();
  const session: RuntimeSession = {
    id,
    projectSlug: p.projectSlug,
    taskSlug: p.taskSlug,
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

  // Echo the first user message into history + cloud event log so the UI
  // shows the user's prompt (the SDK doesn't echo typed inputs in streaming mode).
  session.history.push(firstMsg);
  appendEvent(session.id, session.seq++, firstMsg);
  session.events.emit("event", firstMsg);

  // Pump events in the background — never await this in the request handler.
  void pumpEvents(session);

  return session;
}

// File-modifying tools that should trigger a refresh in the UI
const FILE_MODIFYING_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

// Extract file path from a tool_use block if it's a file-modifying tool
function extractModifiedFilePath(msg: SDKMessage): string | null {
  if (msg.type !== "assistant") return null;
  const content = (msg as { message?: { content?: unknown[] } }).message?.content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    const p = part as { type?: string; name?: string; input?: { file_path?: string; notebook_path?: string } };
    if (p.type === "tool_use" && FILE_MODIFYING_TOOLS.has(p.name ?? "")) {
      return p.input?.file_path ?? p.input?.notebook_path ?? null;
    }
  }
  return null;
}

// When a turn is interrupted, the SDK aborts the in-flight request, which the
// query iterator surfaces by throwing an abort / "ede_diagnostic" error. That's
// the expected outcome of a user pressing stop — not a crash — so we recognize
// it and record a clean "stopped" instead of flipping the session to "error".
function isInterruptError(message: string): boolean {
  return /request was aborted|ede_diagnostic|returned an error result/i.test(message);
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

      // Emit file_changed when the agent modifies a file so the UI can refresh
      const modifiedPath = extractModifiedFilePath(msg);
      if (modifiedPath) {
        s.events.emit("file_changed", { path: modifiedPath });
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
          s.events.emit("event", {
            type: "system",
            subtype: "error",
            message: errorText,
          } as unknown as SDKMessage);
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
    // If session is already running (resumed) or stopped (interrupted),
    // this is a stale pumpEvents — don't touch state
    if (s.state === "running" || s.state === "stopped") return;

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

// Called from fs.ts after a task or project is moved/renamed. Keeps the
// in-memory session entries' (projectSlug, taskSlug) labels in sync with the
// new folder names so the UI continues to find them.
export function relocateSessionsForTask(
  oldProject: string,
  oldTask: string,
  newProject: string,
  newTask: string,
): void {
  for (const s of registry.values()) {
    if (s.projectSlug === oldProject && s.taskSlug === oldTask) {
      s.projectSlug = newProject;
      s.taskSlug = newTask;
    }
  }
}

export function relocateSessionsForProject(oldProject: string, newProject: string): void {
  for (const s of registry.values()) {
    if (s.projectSlug === oldProject) s.projectSlug = newProject;
  }
}

// Move a project-level session into a task's sessions folder. Used by the
// "New task" planning flow: when the user accepts the proposed task, the
// session that produced the plan moves from `projects/<p>/sessions/<id>/` to
// `projects/<p>/<task>/sessions/<id>/` so it lives with the task it created.
// Open log fd's survive the directory rename on POSIX, so streams keep
// writing to the moved location without needing to be reopened.
export async function moveSessionToTask(
  sessionId: string,
  newTaskSlug: string,
): Promise<boolean> {
  const s = registry.get(sessionId);
  if (!s) return false;
  if (s.taskSlug === newTaskSlug) return true;

  const project = await getProject(s.projectSlug);
  if (!project) return false;
  const newTask = project.tasks.find((t) => t.slug === newTaskSlug);
  if (!newTask) return false;

  const oldDir = s.taskSlug
    ? path.join(PROJECTS_DIR, project.folderName, project.tasks.find((t) => t.slug === s.taskSlug)?.folderName ?? "", "sessions", sessionId)
    : path.join(PROJECTS_DIR, project.folderName, "sessions", sessionId);
  const newDir = path.join(PROJECTS_DIR, project.folderName, newTask.folderName, "sessions", sessionId);

  try {
    await fs.mkdir(path.dirname(newDir), { recursive: true });
    await fs.rename(oldDir, newDir);
  } catch (err) {
    console.warn(`[moveSessionToTask] failed to move ${oldDir} → ${newDir}:`, (err as Error).message);
    return false;
  }

  s.taskSlug = newTaskSlug;
  await updateMeta(s, (meta) => {
    meta.task = newTaskSlug;
  });
  return true;
}

// Project-level session — cwd is the project folder, sessions persist to
// `projects/<project>/sessions/<id>/`. Uses the same on-disk layout as task
// sessions but at one level up.
//
// `planning` opts the session into the create-project / create-task chat
// flow: instead of the standard project-context system prompt + static
// workbench tools, the agent gets the planning system prompt and the
// `propose_plan` / `propose_task` MCP tool that the Chat UI watches for.
// Everything else (persistence, sidebar listing, resume) behaves exactly
// like a normal session.
export async function startProjectSession(p: { projectSlug: string; firstMessage: string; permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan"; model?: string; effort?: EffortLevel; runtime?: SessionRuntime; planning?: "project" | "task" }): Promise<RuntimeSession> {
  const runtime: SessionRuntime = p.runtime ?? "claude";
  const project = await getProject(p.projectSlug);
  if (!project) throw new Error("unknown project");

  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}--${randomUUID().slice(0, 6)}`;
  const name = generateSessionLabel(p.firstMessage);
  // Agent runs at workspace root; project identity + path comes via the
  // system prompt. See startSession comment.
  const cwd = WORKSPACE_ROOT;
  const sessionDir = path.join(PROJECTS_DIR, project.folderName, "sessions", id);
  await fs.mkdir(sessionDir, { recursive: true });

  await fs.writeFile(
    path.join(sessionDir, "meta.json"),
    JSON.stringify({
      id,
      name,
      project: p.projectSlug,
      task: "",
      cwd,
      startedAt: new Date().toISOString(),
      permissionMode: p.permissionMode ?? "bypassPermissions",
      model: p.model ?? null,
      effort: p.effort ?? null,
      runtime,
      finalState: "running",
    }, null, 2),
  );

  registerSessionLog(id, path.join(sessionDir, "events.jsonl"));
  const inputLog = createWriteStream(path.join(sessionDir, "input.jsonl"), { flags: "a" });

  const input = new InputChannel();
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const pendingPermissions = new Map<string, PendingPermission>();
  const pendingQuestions = new Map<string, PendingQuestion>();
  const pendingCompletions = new Map<string, PendingCompletion>();

  inputLog.write(JSON.stringify({ at: new Date().toISOString(), text: p.firstMessage }) + "\n");
  input.push(makeUserMessage(p.firstMessage, id));

  // Project-level sessions only get project.md context (no task). Comments
  // and other workbench tools scope to project-level (empty taskSlug); the
  // comments tool operates on project-level .comments.json in that case.
  //
  // Planning mode swaps the project-context prompt for the claude_code preset
  // with the planning instructions appended, and merges the planning MCP
  // (propose_plan / propose_task) into the static workbench MCPs so the chat
  // UI can render the proposal as an inline card.
  const planningAppend = p.planning === "task"
    ? buildTaskPlanningSystemPrompt(
        project.slug,
        project.folderName,
        project.overview,
        project.tasks.map((t) => t.slug),
      )
    : p.planning === "project"
      ? PLANNING_SYSTEM_PROMPT
      : null;
  const systemPrompt = planningAppend
    ? { type: "preset" as const, preset: "claude_code" as const, append: planningAppend }
    : await buildContextSystemPrompt(p.projectSlug, "", name);
  const planningMcps = p.planning === "task"
    ? { "workbench-planning": workbenchToolsAsClaudeMcp("workbench-planning", buildTaskPlanningTools()) }
    : p.planning === "project"
      ? { "workbench-planning": workbenchToolsAsClaudeMcp("workbench-planning", buildPlanningTools()) }
      : {};
  const q = createAgentQuery(runtime, {
    prompt: input,
    options: {
      cwd,
      permissionMode: p.permissionMode ?? "bypassPermissions",
      settingSources: ["project", "user"],
      canUseTool: buildCanUseTool(pendingPermissions, events),
      toolAliases: STATIC_TOOL_ALIASES,
      mcpServers: { ...buildStaticWorkbenchMcps(id, p.projectSlug, ""), ...planningMcps },
      workbenchToolGroups: buildStaticWorkbenchToolGroups(id, p.projectSlug, ""),
      runtimeStateDir: sessionDir,
      systemPrompt,
      ...(p.model ? { model: p.model } : {}),
      ...(p.effort ? { effort: p.effort } : {}),
    },
    remote: { project: p.projectSlug, task: "" },
  });

  const now = new Date();
  const firstUserEcho = makeUserMessage(p.firstMessage, id);
  const session: RuntimeSession = {
    id,
    projectSlug: p.projectSlug,
    taskSlug: "",
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
    history: [firstUserEcho],
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
  appendEvent(session.id, session.seq++, firstUserEcho);
  session.events.emit("event", firstUserEcho);
  void pumpEvents(session);
  return session;
}

export async function sendInput(id: string, text: string): Promise<boolean> {
  const s = registry.get(id);
  if (!s) return false;

  // Route to resumeSession when the SDK is no longer consuming input. The
  // nominal state isn't sufficient: the SDK process can die unexpectedly
  // (e.g. `Claude Code process exited with code 1`) and leave the session in
  // state="idle" or "awaiting_input" while the input channel is closed.
  // Without this guard, sendInput would write to a closed inputLog, push into
  // a dead InputChannel, flip state to "running" — and the session would
  // appear alive but never produce events.
  const sdkDead = s.input.isClosed() || s.state === "stopped" || s.state === "error";
  if (sdkDead) {
    return resumeSession(s, text);
  }

  // The SDK doesn't echo typed user messages in streaming-input mode, so we
  // surface them ourselves: write to inputLog, push into the input channel
  // for the agent to receive, and also append to history + emit on the event
  // bus so the UI renders the bubble.
  s.inputLog.write(JSON.stringify({ at: new Date().toISOString(), text }) + "\n");
  const msg = makeUserMessage(text, id);
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
  projectSlug: string,
  taskSlug: string
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

  // Route to resumeSession when the SDK is no longer consuming input — same
  // dead-SDK guard as sendInput. See its comment for rationale.
  const sdkDead = s.input.isClosed() || s.state === "stopped" || s.state === "error";
  if (sdkDead) {
    // For resumed sessions, we can't easily add images to the resume flow.
    // Just include the text with file references.
    return resumeSession(s, messageText);
  }

  // Read images and convert to base64
  const images: ImageContent[] = [];
  if (imageFiles.length > 0) {
    const project = await getProject(projectSlug);
    if (project) {
      const task = project.tasks.find((t) => t.slug === taskSlug);
      if (task) {
        const filesDir = path.join(taskDir(project, task), "files");
        for (const imgFile of imageFiles) {
          try {
            const imgPath = path.join(filesDir, imgFile.path);
            const data = await fs.readFile(imgPath);
            const base64 = data.toString("base64");
            images.push({ mimeType: imgFile.mimeType, base64 });
          } catch (err) {
            console.error(`Failed to read image ${imgFile.path}:`, err);
          }
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
async function resumeSession(s: RuntimeSession, newMessage: string): Promise<boolean> {
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
  const canResume = !!s.sdkSessionId && (await sdkTranscriptExists(s.sdkSessionId));
  const lostTranscript = !!s.sdkSessionId && !canResume;
  if (lostTranscript) {
    s.sdkSessionId = null;
    void updateMeta(s, (meta) => {
      meta.sdkSessionId = null;
    });
  }

  // Interrupt any existing query to stop the old pumpEvents loop.
  // This prevents race conditions where the old loop overwrites state after
  // the new one has already set it.
  //
  // Wrap with a 2s timeout: the Claude SDK's interrupt() writes a
  // control_request to the bridge subprocess and waits for an ack on the
  // same channel. If the bridge has already exited (e.g. after the user
  // hit Stop, which left s.q referencing a dead transport), the write
  // succeeds locally but no response ever arrives — the promise hangs
  // forever. Without this guard, resume-after-stop blocks for tens of
  // seconds and ends up creating a new query against a dead transport,
  // so the UI sees "send button does nothing" — the request is in flight
  // for ~30s and produces zero agent output.
  if (s.q) {
    try {
      await Promise.race([
        s.q.interrupt(),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // Ignore errors — query may already be done
    }
  }

  try {
    // Re-open the log files for appending
    const project = await getProject(s.projectSlug);
    if (!project) throw new Error("Project not found");

    let sessionDir: string;
    if (!s.taskSlug) {
      sessionDir = path.join(PROJECTS_DIR, project.folderName, "sessions", s.id);
    } else {
      const task = project.tasks.find((t) => t.slug === s.taskSlug);
      if (!task) throw new Error("Task not found");
      sessionDir = path.join(PROJECTS_DIR, project.folderName, task.folderName, "sessions", s.id);
    }

    // Re-create log streams
    registerSessionLog(s.id, path.join(sessionDir, "events.jsonl"));
    s.inputLog = createWriteStream(path.join(sessionDir, "input.jsonl"), { flags: "a" });

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

    const systemPrompt = await buildContextSystemPrompt(s.projectSlug, s.taskSlug);

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
        // cwd may be the task folder (pre-refactor).
        cwd: WORKSPACE_ROOT,
        ...(canResume ? { resume: s.sdkSessionId! } : {}),
        permissionMode: s.permissionMode,
        settingSources: ["project", "user"],
        canUseTool: buildCanUseTool(s.pendingPermissions, s.events),
        toolAliases: STATIC_TOOL_ALIASES,
        mcpServers: buildStaticWorkbenchMcps(s.id, s.projectSlug, s.taskSlug),
        workbenchToolGroups: buildStaticWorkbenchToolGroups(s.id, s.projectSlug, s.taskSlug),
        runtimeStateDir: sessionDir,
        systemPrompt,
        ...(s.model ? { model: s.model } : {}),
        ...(s.effort ? { effort: s.effort } : {}),
      },
      remote: { project: s.projectSlug, task: s.taskSlug },
    });

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

    // Start pumping events from the new query
    void pumpEvents(s);

    return true;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[session ${s.id}] Failed to resume:`, errorMsg);
    s.events.emit("event", {
      type: "system",
      subtype: "error",
      message: `Failed to resume session: ${errorMsg}`,
    } as unknown as SDKMessage);
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

  // Find the last user message to retry
  let lastUserMessage = "";
  for (let i = s.history.length - 1; i >= 0; i--) {
    const msg = s.history[i] as { role?: string; content?: unknown };
    if (msg.role === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        lastUserMessage = content;
      } else if (Array.isArray(content)) {
        // Handle content array (text blocks)
        const textBlock = content.find((b: { type?: string }) => b.type === "text");
        if (textBlock && typeof (textBlock as { text?: string }).text === "string") {
          lastUserMessage = (textBlock as { text: string }).text;
        }
      }
      break;
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
  projectSlug: string,
  taskSlug: string,
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
  const project = await getProject(projectSlug);
  if (!project) return false;

  let sessionDir: string;
  if (!taskSlug) {
    sessionDir = path.join(PROJECTS_DIR, project.folderName, "sessions", sessionId);
  } else {
    const task = project.tasks.find((t) => t.slug === taskSlug);
    if (!task) return false;
    sessionDir = path.join(PROJECTS_DIR, project.folderName, task.folderName, "sessions", sessionId);
  }

  const metaPath = path.join(sessionDir, "meta.json");
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
  projectSlug: string,
  taskSlug: string,
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
  const project = await getProject(projectSlug);
  if (!project) return false;

  let sessionDir: string;
  if (!taskSlug) {
    sessionDir = path.join(PROJECTS_DIR, project.folderName, "sessions", sessionId);
  } else {
    const task = project.tasks.find((t) => t.slug === taskSlug);
    if (!task) return false;
    sessionDir = path.join(PROJECTS_DIR, project.folderName, task.folderName, "sessions", sessionId);
  }

  const metaPath = path.join(sessionDir, "meta.json");
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
  projectSlug: string,
  taskSlug: string,
  sessionId: string,
  newName: string,
): Promise<boolean> {
  const trimmedName = newName.trim();

  // Update in-memory title for live sessions
  const liveSession = registry.get(sessionId);
  if (liveSession) {
    liveSession.title = trimmedName;
  }

  const project = await getProject(projectSlug);
  if (!project) return !!liveSession; // Return true if we at least updated in-memory

  let sessionDir: string;
  if (!taskSlug) {
    sessionDir = path.join(PROJECTS_DIR, project.folderName, "sessions", sessionId);
  } else {
    const task = project.tasks.find((t) => t.slug === taskSlug);
    if (!task) return false;
    sessionDir = path.join(PROJECTS_DIR, project.folderName, task.folderName, "sessions", sessionId);
  }

  const metaPath = path.join(sessionDir, "meta.json");
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
  projectSlug: string,
  taskSlug: string,
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

  const project = await getProject(projectSlug);
  if (!project) return false;

  let sessionDir: string;
  if (!taskSlug) {
    sessionDir = path.join(PROJECTS_DIR, project.folderName, "sessions", sessionId);
  } else {
    const task = project.tasks.find((t) => t.slug === taskSlug);
    if (!task) return false;
    sessionDir = path.join(PROJECTS_DIR, project.folderName, task.folderName, "sessions", sessionId);
  }

  try {
    // Check directory exists before attempting delete
    await fs.access(sessionDir);
    await fs.rm(sessionDir, { recursive: true, force: true });
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
