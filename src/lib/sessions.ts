import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
import { getProject, getTask, taskDir, WORKSPACE_ROOT, PROJECTS_DIR, listProjects, projectDir, reconcileSessionsOnDisk } from "./fs";
import { buildPlanningTools, PLANNING_SYSTEM_PROMPT } from "./workbench-tools/planning";
import { buildCommentsTools } from "./workbench-tools/comments";
import { buildSessionTools } from "./workbench-tools/session";
import { buildEmailTools } from "./workbench-tools/email";
import { workbenchToolsAsClaudeMcp } from "./runtimes/claude-tool-adapter";
import { buildStaticWorkbenchMcps } from "./claude-chrome-tools";
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
    { name: "workbench-email", tools: buildEmailTools(sessionId) },
  ];
}
import {
  type SessionState,
  isValidTransition,
  isTerminalState,
  shouldPersistState,
  canOverwriteWithStopped,
  stateAfterResult,
} from "./session-state-machine";

// Build a system prompt that includes project.md and task.md context so the
// agent knows what project/task it's working in. Returns undefined if no
// context files exist (letting the SDK use its default preset).
async function buildContextSystemPrompt(
  projectSlug: string,
  taskSlug: string,
): Promise<{ type: "preset"; preset: "claude_code"; append: string } | undefined> {
  const parts: string[] = [];

  // Read project.md
  try {
    const projectMdPath = path.join(PROJECTS_DIR, `wip-${projectSlug}`, "files", "project.md");
    const projectContent = await fs.readFile(projectMdPath, "utf8");
    if (projectContent.trim()) {
      parts.push(`<project-context>\n# Project: ${projectSlug}\n\n${projectContent.trim()}\n</project-context>`);
    }
  } catch {
    // Try done- prefix
    try {
      const projectMdPath = path.join(PROJECTS_DIR, `done-${projectSlug}`, "files", "project.md");
      const projectContent = await fs.readFile(projectMdPath, "utf8");
      if (projectContent.trim()) {
        parts.push(`<project-context>\n# Project: ${projectSlug}\n\n${projectContent.trim()}\n</project-context>`);
      }
    } catch { /* no project.md */ }
  }

  // Read task.md
  if (taskSlug) {
    try {
      const project = await getProject(projectSlug);
      if (project) {
        const task = project.tasks.find((t) => t.slug === taskSlug);
        if (task) {
          const taskMdPath = path.join(PROJECTS_DIR, project.folderName, task.folderName, "files", "task.md");
          const taskContent = await fs.readFile(taskMdPath, "utf8");
          if (taskContent.trim()) {
            parts.push(`<task-context>\n# Task: ${taskSlug}\n\n${taskContent.trim()}\n</task-context>`);
          }
        }
      }
    } catch { /* no task.md */ }
  }

  if (parts.length === 0) return undefined;

  const contextPrompt = `
You are working within the Agent Workbench on a specific project and task. Here is the context:

${parts.join("\n\n")}

Use this context to understand the goals, requirements, and current state of work. When relevant, refer back to these documents for guidance.

## Inline Media in Chat

You can display images and videos inline in your chat responses using markdown syntax:

**Basic syntax:**
- Image: \`![alt text](url)\`
- Video: \`![alt text](url.mp4)\` (automatically detected by extension: mp4, webm, mov, avi, mkv, m4v)

**With custom dimensions** (append \`|width\` or \`|widthxheight\` to alt text):
- \`![description|800](url)\` — 800px wide, maintains aspect ratio
- \`![description|800x600](url)\` — exact 800x600 dimensions

**For files in the task folder**, use the raw file API:
\`\`\`
![screenshot|600](/api/files/raw?project=PROJECT&task=TASK&path=uploads/image.png)
![demo video|800](/api/files/raw?project=PROJECT&task=TASK&path=uploads/demo.mp4)
\`\`\`

Replace PROJECT and TASK with the current project/task slugs (URL-encoded). Files in the task's \`files/\` directory are served via this API.
`.trim();

  return { type: "preset", preset: "claude_code", append: contextPrompt };
}

// Generate a short label from the first message by extracting key words.
// Produces labels like "Add dark mode", "Fix login bug", "Session names feature"
function generateSessionLabel(firstMessage: string): string {
  // Clean up the message
  let text = firstMessage
    .trim()
    .replace(/^(can you|could you|please|hey|hi|hello|I want to|I need to|I'd like to|let's|we should)\s*/gi, "")
    .replace(/[?!.]+$/, "")
    .trim();

  // If it starts with a verb, capitalize it; otherwise add context
  const words = text.split(/\s+/);
  if (words.length === 0) return "New session";

  // Capitalize first letter
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);

  // Take first ~5 words or ~40 chars, whichever is shorter
  let label = "";
  for (const word of words) {
    if (label.length + word.length > 40) break;
    label += (label ? " " : "") + word;
  }

  return label || "New session";
}

// Re-export SessionState for consumers who import from sessions.ts
export type { SessionState } from "./session-state-machine";

// Which agent runtime drives this session. Claude is the default and is
// what every session today uses; Gemini is a phase-3 follow-up. Stored in
// meta.json so resume after a server restart picks the same runtime.
export type SessionRuntime = "claude" | "gemini";

interface RuntimeSession {
  id: string;
  projectSlug: string;
  taskSlug: string;
  cwd: string;
  title: string;                 // short label derived from first message (e.g. "Add dark mode")
  startedAt: Date;
  lastActivity: Date;
  seenAt: Date | null;           // when user last viewed this session (null = never seen)
  completedAt: Date | null;      // when session finished (idle/stopped/error) — for unread tracking
  q: AgentQuery;
  input: InputChannel;
  events: EventEmitter;          // emits 'event' (SDKMessage) and 'state' (SessionState)
  log: WriteStream;              // events.jsonl
  inputLog: WriteStream;         // input.jsonl
  history: SDKMessage[];         // in-memory replay buffer for new SSE clients
  state: SessionState;
  // Tool calls awaiting user approval via canUseTool. Keyed by toolUseID.
  // Today this is used for ExitPlanMode (the agent finishes a plan, the SDK
  // asks for user approval before exiting plan mode). The resolver is called
  // by the /api/sessions/[id]/permission endpoint with the user's decision.
  pendingPermissions: Map<string, PendingPermission>;
  sdkSessionId: string | null;   // the SDK's internal session ID for resumption
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  model: string | null;
  runtime: SessionRuntime;       // claude (default) | gemini
}

export interface PendingPermission {
  toolName: string;
  input: Record<string, unknown>;
  resolve: (r: PermissionResult) => void;
  requestedAt: Date;
}

export interface SessionSummary {
  id: string;
  projectSlug: string;
  taskSlug: string;
  state: SessionState;
  title: string;
  startedAt: string;             // ISO
  lastActivity: string;          // ISO
  isLive: boolean;
  unread: boolean;               // completed session not yet viewed
  runtime: SessionRuntime;
  model: string | null;          // actual model id (e.g. "claude-opus-4-7", "gemini-3.5-flash")
}

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

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes — watchdog fallback with error emit
const IDLE_EVICT_MS = 5 * 60 * 1000;      // idle this long → close streams + transition to stopped
const WATCHDOG_INTERVAL_MS = 60 * 1000;   // check every minute

// Runtime contract: any session whose streams have been closed MUST be in
// state "stopped". sendInput dispatches by state — "running"/"idle" goes to
// the live-write path that pushes into the InputChannel and writes to
// inputLog. If streams are closed but state still says "idle", that write
// silently no-ops and the agent never sees the message — that's the "session
// stuck after 5 min" symptom. So the watchdog closes streams AND transitions
// state to stopped together. resumeSession is responsible for re-opening
// streams when the user sends another message.
function runWatchdog() {
  const now = Date.now();
  for (const s of registry.values()) {
    const sinceActivity = now - s.lastActivity.getTime();
    if (s.state === "running" && sinceActivity > STALE_THRESHOLD_MS) {
      console.warn(`[watchdog] Session ${s.id} stuck in running state for ${Math.round(sinceActivity / 1000)}s — auto-stopping`);
      try {
        s.events.emit("event", {
          type: "system",
          subtype: "error",
          message: "Session timed out due to inactivity",
        } as unknown as SDKMessage);
        s.input.close();
        s.log.end();
        s.inputLog.end();
        setState(s, "stopped");
      } catch { /* best effort */ }
    } else if (s.state === "idle" && sinceActivity > IDLE_EVICT_MS) {
      console.log(`[watchdog] Session ${s.id} idle for ${Math.round(sinceActivity / 1000)}s — closing (resumable on next message)`);
      try {
        s.input.close();
        s.log.end();
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
if (!globalThis.__wb_reconciled) {
  globalThis.__wb_reconciled = true;
  setImmediate(async () => {
    await reconcileSessionsOnDisk();
    // Resume sessions that were mid-process when the server died. Awaited
    // after reconcile so we read freshly-corrected (projectSlug, taskSlug,
    // cwd) values — otherwise auto-resume could try to restore against a
    // stale path and silently fail.
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

export function getSession(id: string): RuntimeSession | undefined {
  return registry.get(id);
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

// Get the session directory for a live session.
// Returns null if the session is not found.
export function getSessionDir(id: string): string | null {
  const s = registry.get(id);
  if (!s) return null;
  return path.join(s.cwd, "sessions", s.id);
}

// Dispatch the query() call to whatever AgentRuntime the session uses. The
// runtime registry lives in ./runtimes; every entry returns an AgentQuery,
// which is structurally compatible with what the rest of sessions.ts
// expects (pumpEvents, sendInput, interrupt, the SSE route).
//
// Centralising the dispatch here means the 4 query call sites (startSession,
// startProjectSession, startPlanningSession, resumeSession) only need to add
// `runtime` to their options blob.
//
// The Claude SDK's options shape today doubles as our AgentQueryOptions —
// they're structurally compatible. The cast on `opts` lets the callers keep
// passing the SDK-shaped option blobs they already build. When a future
// runtime needs a different option shape, this is where the translation
// goes.
function createAgentQuery(runtime: SessionRuntime, opts: Record<string, unknown>): AgentQuery {
  return getRuntime(runtime).query(opts as unknown as AgentQueryOptions);
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
    const unread = s.completedAt !== null && (!s.seenAt || s.completedAt > s.seenAt);
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
      runtime: s.runtime,
      model: s.model,
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
    let meta: { startedAt?: string; name?: string; seenAt?: string; finalState?: SessionState; lastActivity?: string; completedAt?: string; runtime?: SessionRuntime; model?: string | null } = {};
    try { meta = JSON.parse(await fs.readFile(metaPath, "utf8")); } catch { /* missing */ }
    // Prefer generated name from meta.json; fall back to first message for legacy sessions
    let title = meta.name ?? "(no message)";
    if (!meta.name) {
      try {
        const first = (await fs.readFile(inputPath, "utf8")).split("\n").find(Boolean);
        if (first) title = (JSON.parse(first).text as string).trim().slice(0, 120);
      } catch { /* missing */ }
    }
    // Prefer persisted lastActivity from meta.json (reliable); fall back to file mtime (unreliable across restarts)
    let lastActivity = meta.lastActivity ?? meta.startedAt ?? new Date(0).toISOString();
    if (!meta.lastActivity) {
      try {
        const st = await fs.stat(path.join(sessDir, id, "events.jsonl"));
        lastActivity = st.mtime.toISOString();
      } catch { /* missing */ }
    }
    // Session is unread only if it completed after user last viewed it
    // For legacy sessions without completedAt, use lastActivity as proxy (they're already done)
    const completedAt = meta.completedAt ?? lastActivity;
    const unread = !meta.seenAt || (meta.seenAt < completedAt);
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
      runtime: meta.runtime ?? "claude",
      model: meta.model ?? null,
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

// Read a historical session's events.jsonl from disk for clients viewing a
// stopped session. Handles both project-level (taskSlug === "") and task-
// level locations.
//
// Pagination support for lazy loading:
// - limit: maximum number of events to return (undefined = all)
// - offset: how many events to skip from the END (0 = most recent)
//
// Example: total 200 events, limit=50, offset=0 → returns events 150-199 (newest 50)
//          total 200 events, limit=50, offset=50 → returns events 100-149 (next 50 older)
//
// Returns { events, total, hasMore } for pagination context.
export async function readSessionHistory(
  projectSlug: string,
  taskSlug: string,
  id: string,
  limit?: number,
  offset: number = 0,
): Promise<{ events: unknown[]; total: number; hasMore: boolean } | null> {
  const project = await getProject(projectSlug);
  if (!project) return null;
  let file: string;
  if (!taskSlug) {
    file = path.join(PROJECTS_DIR, project.folderName, "sessions", id, "events.jsonl");
  } else {
    const task = project.tasks.find((t) => t.slug === taskSlug);
    if (!task) return null;
    file = path.join(PROJECTS_DIR, project.folderName, task.folderName, "sessions", id, "events.jsonl");
  }
  try {
    const raw = await fs.readFile(file, "utf8");
    const allEvents = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const total = allEvents.length;

    // If no limit specified, return all events
    if (limit === undefined) {
      return { events: allEvents, total, hasMore: false };
    }

    // Calculate slice indices from the end
    // offset=0, limit=50 with 200 total → start=150, end=200 → events[150:200]
    // offset=50, limit=50 with 200 total → start=100, end=150 → events[100:150]
    const end = total - offset;
    const start = Math.max(0, end - limit);

    if (end <= 0) {
      // Offset is beyond the total events
      return { events: [], total, hasMore: false };
    }

    const events = allEvents.slice(start, end);
    const hasMore = start > 0;

    return { events, total, hasMore };
  } catch {
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
  let cwd: string;
  if (!taskSlug) {
    sessionDir = path.join(PROJECTS_DIR, project.folderName, "sessions", id);
    cwd = path.join(PROJECTS_DIR, project.folderName);
  } else {
    const task = project.tasks.find((t) => t.slug === taskSlug);
    if (!task) return null;
    sessionDir = path.join(PROJECTS_DIR, project.folderName, task.folderName, "sessions", id);
    cwd = path.join(PROJECTS_DIR, project.folderName, task.folderName);
  }

  // Read meta.json
  const metaPath = path.join(sessionDir, "meta.json");
  let meta: {
    name?: string;
    startedAt?: string;
    sdkSessionId?: string;
    permissionMode?: string;
    model?: string;
    finalState?: SessionState;
    seenAt?: string;
    lastActivity?: string;
    completedAt?: string;
    runtime?: SessionRuntime;
  } = {};
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    meta = JSON.parse(raw);
  } catch {
    return null; // No meta.json means session doesn't exist
  }

  // Read history from events.jsonl
  const eventsPath = path.join(sessionDir, "events.jsonl");
  let history: SDKMessage[] = [];
  try {
    const raw = await fs.readFile(eventsPath, "utf8");
    history = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    // Empty history is fine
  }

  // Create a placeholder InputChannel and Query that will be replaced on resume
  const input = new InputChannel();
  input.close(); // Closed — not active
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const pendingPermissions = new Map<string, PendingPermission>();

  // Don't create file streams yet — they'll be created on resume
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
    log: sink,
    inputLog: sink,
    history,
    // A restored session has closed streams and a placeholder query, so the
    // runtime state must be "stopped" regardless of what meta.json says —
    // sendInput dispatches by state, and only "stopped"/"error" routes through
    // resumeSession (which re-opens streams). If we left state as "idle" here,
    // the next user message would silently write to closed streams.
    state: "stopped",
    pendingPermissions,
    sdkSessionId: meta.sdkSessionId ?? null,
    permissionMode: (meta.permissionMode as "default" | "acceptEdits" | "bypassPermissions" | "plan") ?? "bypassPermissions",
    model: meta.model ?? null,
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
    const metaPath = path.join(sessDir, d.name, "meta.json");
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
      // sdkSessionId is required: resume() needs it to find the SDK's
      // transcript. A session that crashed before the first `init` event has
      // no transcript to resume against — skip it.
      if (meta.finalState === "running" && meta.sdkSessionId) {
        out.push({ projectSlug, taskSlug, id: d.name });
      }
    } catch { /* skip unreadable meta */ }
  }
  return out;
}

export async function autoResumeRunningSessions(): Promise<{ resumed: number; failed: number }> {
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
  runtime?: SessionRuntime;       // defaults to "claude"
}

export async function startSession(p: StartSessionParams): Promise<RuntimeSession> {
  const runtime: SessionRuntime = p.runtime ?? "claude";
  const project = await getProject(p.projectSlug);
  const task = await getTask(p.projectSlug, p.taskSlug);
  if (!project || !task) throw new Error("unknown project/task");

  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}--${randomUUID().slice(0, 6)}`;
  const name = generateSessionLabel(p.firstMessage);
  const cwd = taskDir(project, task);
  const sessionDir = path.join(cwd, "sessions", id);
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

  const log = createWriteStream(path.join(sessionDir, "events.jsonl"), { flags: "a" });
  const inputLog = createWriteStream(path.join(sessionDir, "input.jsonl"), { flags: "a" });

  const input = new InputChannel();
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const pendingPermissions = new Map<string, PendingPermission>();

  // First message
  const firstMsg = makeUserMessage(p.firstMessage, id);
  inputLog.write(JSON.stringify({ at: new Date().toISOString(), text: p.firstMessage }) + "\n");
  input.push(firstMsg);

  const systemPrompt = await buildContextSystemPrompt(p.projectSlug, p.taskSlug);
  const q = createAgentQuery(runtime, {
    prompt: input,
    options: {
      cwd,
      // Grant access to the whole workspace root so agents can read shared
      // resources (CLAUDE.md, skills/, scripts/, etc.) while keeping their
      // cwd at the task folder where outputs naturally land.
      additionalDirectories: [WORKSPACE_ROOT],
      // Localhost personal use — full trust by default. We still listen for
      // end_turn to flip awaiting_input.
      permissionMode: p.permissionMode ?? "bypassPermissions",
      settingSources: ["project", "user"],
      canUseTool: buildCanUseTool(pendingPermissions, events),
      // Static workbench MCPs (comments, session-management, email, chrome
      // connect/disconnect) are wrapped for Claude here. Gemini's adapter
      // ignores this field today and registers workbench tools through its
      // own ToolRegistry path (TODO step 4 of gemini-runtime-parity).
      mcpServers: buildStaticWorkbenchMcps(id, p.projectSlug, p.taskSlug),
      workbenchToolGroups: buildStaticWorkbenchToolGroups(id, p.projectSlug, p.taskSlug),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(p.model ? { model: p.model } : {}),
    },
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
    log,
    inputLog,
    history: [],
    state: "running",
    pendingPermissions,
    sdkSessionId: null,
    permissionMode: p.permissionMode ?? "bypassPermissions",
    model: p.model ?? null,
    runtime,
  };
  registerSession(session);

  // Echo the first user message into history + events.jsonl so the UI shows
  // the user's prompt (the SDK doesn't echo typed inputs in streaming mode).
  session.history.push(firstMsg);
  session.log.write(JSON.stringify(firstMsg) + "\n");
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

// Persist the SDK session ID to meta.json so the session can be resumed after server restart
async function persistSdkSessionId(s: RuntimeSession): Promise<void> {
  await updateMeta(s, (meta) => {
    meta.sdkSessionId = s.sdkSessionId;
  });
}

// Per-session mutex queue for meta.json updates. Without this, two
// setState() calls in quick succession (very common: running → idle → stopped
// over a few hundred ms) trigger two concurrent persistSessionState calls,
// each doing read-modify-write on the same file. We've observed the resulting
// file corruption in the wild: the shorter write's `}\n` ends up overlaid on
// top of the longer write's content, leaving JSON that won't parse. That
// blocks restoreSession and the session becomes unrecoverable across server
// restarts ("session not found or failed to resume").
const metaWriteQueue = new Map<string, Promise<void>>();

// Read-modify-write meta.json safely:
// - Serialized per-session: concurrent updateMeta calls for the same session
//   are queued, so reader/writer cycles never interleave.
// - Atomic on the file system: write to a sibling .tmp file and rename, so
//   a crash or process kill mid-write never leaves a half-written meta.json.
async function updateMeta(
  s: RuntimeSession,
  mutate: (meta: Record<string, unknown>) => void,
): Promise<void> {
  // Skip for planning sessions (they write to /dev/null)
  if (s.projectSlug === "__planning__") return;

  const prev = metaWriteQueue.get(s.id) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      const project = await getProject(s.projectSlug);
      if (!project) return;

      let sessionDir: string;
      if (!s.taskSlug) {
        sessionDir = path.join(PROJECTS_DIR, project.folderName, "sessions", s.id);
      } else {
        const task = project.tasks.find((t) => t.slug === s.taskSlug);
        if (!task) return;
        sessionDir = path.join(PROJECTS_DIR, project.folderName, task.folderName, "sessions", s.id);
      }

      const metaPath = path.join(sessionDir, "meta.json");
      const tmpPath = metaPath + ".tmp";
      const raw = await fs.readFile(metaPath, "utf8");
      const meta = JSON.parse(raw) as Record<string, unknown>;
      mutate(meta);
      await fs.writeFile(tmpPath, JSON.stringify(meta, null, 2));
      await fs.rename(tmpPath, metaPath);
    } catch {
      // Best effort — meta drift gets caught by reconcileSessionsOnDisk on boot.
    }
  });
  metaWriteQueue.set(s.id, next);
  try {
    await next;
  } finally {
    // If this was the last queued write for the session, drop the entry so
    // the map doesn't accumulate forever.
    if (metaWriteQueue.get(s.id) === next) metaWriteQueue.delete(s.id);
  }
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
      if (!isStreamEvent) {
        s.log.write(JSON.stringify(msg) + "\n");
        s.history.push(msg);
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
          // Persist to meta.json so the new id survives restarts. (For
          // session.projectSlug = "__planning__" persistSdkSessionId is a
          // no-op; after adoptSessionToProject the slug becomes real and the
          // next init's id is persisted automatically.)
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
        const resultMsg = msg as { subtype?: string; error?: string };
        // Check for error results
        if (resultMsg.subtype === "error" || resultMsg.error) {
          const errorText = resultMsg.error ?? "Unknown error";
          s.events.emit("event", {
            type: "system",
            subtype: "error",
            message: errorText,
          } as unknown as SDKMessage);
        }
        const text = lastAssistantText(s.history);
        const isQuestion = /[?？]\s*['""')\]]*\s*$/.test(text.trim());
        setState(s, stateAfterResult(isQuestion));
      } else if (msg.type === "assistant" || msg.type === "user") {
        if (s.state !== "running") setState(s, "running");
      }
    }
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
    console.error(`[session ${s.id}] Error in pumpEvents:`, errorMsg);
    s.events.emit("event", {
      type: "system",
      subtype: "error",
      message: errorMsg,
    } as unknown as SDKMessage);
    s.log.write(JSON.stringify({ type: "system", subtype: "error", message: errorMsg }) + "\n");
    setState(s, "error");
  } finally {
    // Don't close streams if session was resumed (new streams were created)
    // or if it was cleanly stopped (interrupt already closed them or will)
    if (s.state !== "running" && s.state !== "stopped") {
      s.log.end();
      s.inputLog.end();
      // Mark the InputChannel closed too. sendInput uses this as its signal
      // that the SDK has gone away — without it, an input arriving here
      // (state=idle, streams closed, dead SDK) would silently disappear.
      s.input.close();
    }
  }
}

function lastAssistantText(history: SDKMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.type !== "assistant") continue;
    const parts = (m as { message?: { content?: unknown } }).message?.content;
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
    }
    void persistSessionState(s, state);
  }
}

// Persist the final state to meta.json for recovery after server restart
async function persistSessionState(s: RuntimeSession, state: SessionState): Promise<void> {
  await updateMeta(s, (meta) => {
    meta.finalState = state;
    meta.lastActivity = s.lastActivity.toISOString();
    if (s.completedAt) {
      meta.completedAt = s.completedAt.toISOString();
    }
  });
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

// Promote an ephemeral planning session into the project that was just
// created from its proposal. We write the conversation history that's been
// accumulating in memory out to `projects/<project>/sessions/<id>/`, redirect
// the session's log streams there for any further events, and re-key the
// in-memory entry so the project's sessions list picks it up.
export async function adoptSessionToProject(id: string, projectSlug: string): Promise<boolean> {
  const s = registry.get(id);
  if (!s) return false;
  const project = await getProject(projectSlug);
  if (!project) return false;

  const newCwd = path.join(PROJECTS_DIR, project.folderName);
  const sessionDir = path.join(newCwd, "sessions", id);
  await fs.mkdir(sessionDir, { recursive: true });

  // meta.json — preserve the session's generated name
  await fs.writeFile(path.join(sessionDir, "meta.json"), JSON.stringify({
    id,
    name: s.title,
    project: projectSlug,
    task: "",
    cwd: newCwd,
    startedAt: s.startedAt.toISOString(),
    originatedFrom: "planning",
    runtime: s.runtime,
  }, null, 2));

  // events.jsonl — dump whatever's already streamed
  await fs.writeFile(
    path.join(sessionDir, "events.jsonl"),
    s.history.map((m) => JSON.stringify(m)).join("\n") + (s.history.length ? "\n" : ""),
  );

  // input.jsonl — extract user-typed messages from history
  const userLines = s.history
    .filter((m): m is SDKMessage & { type: "user" } => m.type === "user")
    .map((m) => {
      const content = (m as { message?: { content?: unknown } }).message?.content;
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        text = (content as Array<{ type?: string; text?: string }>)
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("");
      }
      return JSON.stringify({ at: new Date().toISOString(), text });
    });
  await fs.writeFile(
    path.join(sessionDir, "input.jsonl"),
    userLines.join("\n") + (userLines.length ? "\n" : ""),
  );

  // Close the old (/dev/null) sinks and reopen real ones so any further
  // events from the still-running query land in the right files.
  try { s.log.end(); } catch { /* already closed */ }
  try { s.inputLog.end(); } catch { /* already closed */ }
  s.log = createWriteStream(path.join(sessionDir, "events.jsonl"), { flags: "a" });
  s.inputLog = createWriteStream(path.join(sessionDir, "input.jsonl"), { flags: "a" });

  // Re-key the registry entry into the new project
  s.projectSlug = projectSlug;
  s.taskSlug = "";
  s.cwd = newCwd;
  return true;
}

export function relocateSessionsForProject(oldProject: string, newProject: string): void {
  for (const s of registry.values()) {
    if (s.projectSlug === oldProject) s.projectSlug = newProject;
  }
}

// Project-level session — cwd is the project folder, sessions persist to
// `projects/<project>/sessions/<id>/`. Uses the same on-disk layout as task
// sessions but at one level up.
export async function startProjectSession(p: { projectSlug: string; firstMessage: string; permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan"; model?: string; runtime?: SessionRuntime }): Promise<RuntimeSession> {
  const runtime: SessionRuntime = p.runtime ?? "claude";
  const project = await getProject(p.projectSlug);
  if (!project) throw new Error("unknown project");

  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}--${randomUUID().slice(0, 6)}`;
  const name = generateSessionLabel(p.firstMessage);
  const cwd = path.join(PROJECTS_DIR, project.folderName);
  const sessionDir = path.join(cwd, "sessions", id);
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
      runtime,
      finalState: "running",
    }, null, 2),
  );

  const log = createWriteStream(path.join(sessionDir, "events.jsonl"), { flags: "a" });
  const inputLog = createWriteStream(path.join(sessionDir, "input.jsonl"), { flags: "a" });

  const input = new InputChannel();
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const pendingPermissions = new Map<string, PendingPermission>();

  inputLog.write(JSON.stringify({ at: new Date().toISOString(), text: p.firstMessage }) + "\n");
  input.push(makeUserMessage(p.firstMessage, id));

  // Project-level sessions only get project.md context (no task). Comments
  // and other workbench tools scope to project-level (empty taskSlug); the
  // comments tool operates on project-level .comments.json in that case.
  const systemPrompt = await buildContextSystemPrompt(p.projectSlug, "");
  const q = createAgentQuery(runtime, {
    prompt: input,
    options: {
      cwd,
      additionalDirectories: [WORKSPACE_ROOT],
      permissionMode: p.permissionMode ?? "bypassPermissions",
      settingSources: ["project", "user"],
      canUseTool: buildCanUseTool(pendingPermissions, events),
      mcpServers: buildStaticWorkbenchMcps(id, p.projectSlug, ""),
      workbenchToolGroups: buildStaticWorkbenchToolGroups(id, p.projectSlug, ""),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(p.model ? { model: p.model } : {}),
    },
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
    log,
    inputLog,
    history: [firstUserEcho],
    state: "running",
    pendingPermissions,
    sdkSessionId: null,
    permissionMode: p.permissionMode ?? "bypassPermissions",
    model: p.model ?? null,
    runtime,
  };
  registerSession(session);
  session.log.write(JSON.stringify(firstUserEcho) + "\n");
  session.events.emit("event", firstUserEcho);
  void pumpEvents(session);
  return session;
}

// Ephemeral, in-memory only — used by the "New Project" chat modal.
// Doesn't persist to disk and doesn't show up in the workspace.
export async function startPlanningSession(firstMessage: string): Promise<RuntimeSession> {
  const id = `plan-${randomUUID().slice(0, 8)}`;
  const name = generateSessionLabel(firstMessage);
  // Planning sessions run at the workspace root so the agent can read shared
  // resources (CLAUDE.md, skills/, scripts/, etc.) and walk `projects/` to
  // discover what already exists before proposing a new project.
  const cwd = WORKSPACE_ROOT;
  const input = new InputChannel();
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const pendingPermissions = new Map<string, PendingPermission>();

  input.push(makeUserMessage(firstMessage, id));

  // Planning sessions are always Claude — see RuntimeSession construction below.
  const q = createAgentQuery("claude", {
    prompt: input,
    options: {
      cwd,
      permissionMode: "bypassPermissions",
      // Use Claude Code's preset so the agent retains Read / Glob / Bash for
      // discovering existing projects, with our planning prompt appended.
      systemPrompt: { type: "preset", preset: "claude_code", append: PLANNING_SYSTEM_PROMPT },
      settingSources: ["project", "user"],
      canUseTool: buildCanUseTool(pendingPermissions, events),
      mcpServers: {
        "workbench-planning": workbenchToolsAsClaudeMcp("workbench-planning", buildPlanningTools()),
      },
      // Don't specify model — use SDK default (latest Claude)
    },
  });

  const now = new Date();
  // Discard logs — these sessions are throwaway.
  const sink: WriteStream = createWriteStream("/dev/null");
  const firstUserEcho = makeUserMessage(firstMessage, id);
  const session: RuntimeSession = {
    id,
    projectSlug: "__planning__",
    taskSlug: "__planning__",
    cwd,
    title: name,
    startedAt: now,
    lastActivity: now,
    seenAt: null, // Planning sessions don't track seen state
    completedAt: null, // Planning sessions don't track completion
    q,
    input,
    events,
    log: sink,
    inputLog: createWriteStream("/dev/null"),
    history: [firstUserEcho],
    state: "running",
    pendingPermissions,
    sdkSessionId: null,
    permissionMode: "bypassPermissions",
    model: null,
    // Planning sessions are always Claude — they predate the runtime selector
    // and run before any project has a configured runtime preference.
    runtime: "claude",
  };
  registerSession(session);
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
  s.log.write(JSON.stringify(msg) + "\n");
  s.events.emit("event", msg);
  s.input.push(msg);
  s.lastActivity = new Date();
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
  s.log.write(JSON.stringify(msg) + "\n");
  s.events.emit("event", msg);
  s.input.push(msg);
  s.lastActivity = new Date();
  setState(s, "running");
  return true;
}

// Resume a stopped session by creating a new SDK query with the resume option
async function resumeSession(s: RuntimeSession, newMessage: string): Promise<boolean> {
  // Need the SDK session ID to resume
  if (!s.sdkSessionId) {
    // No SDK session ID — we can't resume via SDK, emit error
    s.events.emit("event", {
      type: "system",
      subtype: "error",
      message: "Cannot resume: session has no SDK session ID. Please start a new session.",
    } as unknown as SDKMessage);
    return false;
  }

  // Interrupt any existing query to stop the old pumpEvents loop.
  // This prevents race conditions where the old loop overwrites state after
  // the new one has already set it.
  if (s.q) {
    try {
      await s.q.interrupt();
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
    s.log = createWriteStream(path.join(sessionDir, "events.jsonl"), { flags: "a" });
    s.inputLog = createWriteStream(path.join(sessionDir, "input.jsonl"), { flags: "a" });

    // Create a new input channel
    s.input = new InputChannel();

    const systemPrompt = await buildContextSystemPrompt(s.projectSlug, s.taskSlug);

    // Create new query with resume option. Re-use the session's existing
    // pendingPermissions map + events emitter so a permission request emitted
    // mid-resume reaches the same SSE subscribers.
    s.q = createAgentQuery(s.runtime, {
      prompt: s.input,
      options: {
        cwd: s.cwd,
        additionalDirectories: [WORKSPACE_ROOT],
        resume: s.sdkSessionId,
        permissionMode: s.permissionMode,
        settingSources: ["project", "user"],
        canUseTool: buildCanUseTool(s.pendingPermissions, s.events),
        mcpServers: buildStaticWorkbenchMcps(s.id, s.projectSlug, s.taskSlug),
        workbenchToolGroups: buildStaticWorkbenchToolGroups(s.id, s.projectSlug, s.taskSlug),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(s.model ? { model: s.model } : {}),
      },
    });

    // Write the new message to logs
    s.inputLog.write(JSON.stringify({ at: new Date().toISOString(), text: newMessage }) + "\n");
    const msg = makeUserMessage(newMessage, s.id);
    s.history.push(msg);
    s.log.write(JSON.stringify(msg) + "\n");
    s.events.emit("event", msg);

    // Push the message to the input channel
    s.input.push(msg);
    s.lastActivity = new Date();
    s.completedAt = null; // Clear completion — session is running again
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
    setState(s, "stopped");
    s.input.close();
    s.log.end();
    s.inputLog.end();
    return true;
  } catch {
    return false;
  }
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
      liveSession.log.end();
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
  s.log.write(JSON.stringify(msg) + "\n");
  s.events.emit("event", msg);
  s.lastActivity = new Date();

  return true;
}
