import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { query, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { InputChannel, makeUserMessage, makeUserMessageWithImages, type ImageContent } from "./input-channel";
import { getProject, getTask, taskDir, WORKSPACE_ROOT, PROJECTS_DIR, listProjects, projectDir } from "./fs";
import { buildCommentsMcp } from "./comments-mcp";
import { buildSessionMcp } from "./session-mcp";
import { buildPlanningMcp, PLANNING_SYSTEM_PROMPT } from "./planning-mcp";
import {
  type SessionState,
  isValidTransition,
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

interface RuntimeSession {
  id: string;
  projectSlug: string;
  taskSlug: string;
  cwd: string;
  title: string;                 // short label derived from first message (e.g. "Add dark mode")
  startedAt: Date;
  lastActivity: Date;
  seenAt: Date | null;           // when user last viewed this session (null = never seen)
  q: Query;
  input: InputChannel;
  events: EventEmitter;          // emits 'event' (SDKMessage) and 'state' (SessionState)
  log: WriteStream;              // events.jsonl
  inputLog: WriteStream;         // input.jsonl
  history: SDKMessage[];         // in-memory replay buffer for new SSE clients
  state: SessionState;
  pendingPermission: null;       // reserved for canUseTool integration
  sdkSessionId: string | null;   // the SDK's internal session ID for resumption
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  model: string | null;
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

export function getSession(id: string): RuntimeSession | undefined {
  return registry.get(id);
}

// Rename a live session's in-memory title directly by ID.
// Also persists to meta.json so the title survives restarts.
// Returns true if session was found and renamed.
export async function renameLiveSession(id: string, newName: string): Promise<boolean> {
  const s = registry.get(id);
  if (!s) return false;

  const trimmedName = newName.trim();
  s.title = trimmedName;

  // Also persist to meta.json
  try {
    const project = await getProject(s.projectSlug);
    if (project) {
      let sessionDir: string;
      if (!s.taskSlug) {
        sessionDir = path.join(PROJECTS_DIR, project.folderName, "sessions", id);
      } else {
        const task = project.tasks.find((t) => t.slug === s.taskSlug);
        if (task) {
          sessionDir = path.join(PROJECTS_DIR, project.folderName, task.folderName, "sessions", id);
        } else {
          return true; // In-memory update succeeded, disk update not possible
        }
      }
      const metaPath = path.join(sessionDir, "meta.json");
      const raw = await fs.readFile(metaPath, "utf8");
      const meta = JSON.parse(raw);
      meta.name = trimmedName;
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    }
  } catch {
    // Disk update failed, but in-memory succeeded
  }

  return true;
}

export function listLiveSessions(): SessionSummary[] {
  return [...registry.values()].map((s) => {
    const unread = !s.seenAt || s.lastActivity > s.seenAt;
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
    let meta: { startedAt?: string; name?: string; seenAt?: string; finalState?: SessionState; lastActivity?: string } = {};
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
    // Session is unread if it hasn't been seen, or if there's activity after seenAt
    const unread = !meta.seenAt || (meta.seenAt < lastActivity);
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
    q: null as unknown as Query, // Placeholder — replaced on resume
    input,
    events,
    log: sink,
    inputLog: sink,
    history,
    // Use persisted finalState if available, default to "idle" (done) for restored sessions
    state: meta.finalState ?? "idle",
    pendingPermission: null,
    sdkSessionId: meta.sdkSessionId ?? null,
    permissionMode: (meta.permissionMode as "default" | "acceptEdits" | "bypassPermissions" | "plan") ?? "bypassPermissions",
    model: meta.model ?? null,
  };

  registerSession(session);
  return session;
}

export interface StartSessionParams {
  projectSlug: string;
  taskSlug: string;
  firstMessage: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  model?: string;
}

export async function startSession(p: StartSessionParams): Promise<RuntimeSession> {
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

  // First message
  const firstMsg = makeUserMessage(p.firstMessage, id);
  inputLog.write(JSON.stringify({ at: new Date().toISOString(), text: p.firstMessage }) + "\n");
  input.push(firstMsg);

  const commentsMcp = buildCommentsMcp(p.projectSlug, p.taskSlug);
  const systemPrompt = await buildContextSystemPrompt(p.projectSlug, p.taskSlug);
  const q = query({
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
      mcpServers: {
        "workbench-comments": commentsMcp,
        "workbench-session": buildSessionMcp(id),
      },
      // Enable Claude in Chrome integration for browser automation
      extraArgs: { chrome: null },
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
    q,
    input,
    events,
    log,
    inputLog,
    history: [],
    state: "running",
    pendingPermission: null,
    sdkSessionId: null,
    permissionMode: p.permissionMode ?? "bypassPermissions",
    model: p.model ?? null,
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
  // Skip for planning sessions (they write to /dev/null)
  if (s.projectSlug === "__planning__") return;

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
    const raw = await fs.readFile(metaPath, "utf8");
    const meta = JSON.parse(raw);
    meta.sdkSessionId = s.sdkSessionId;
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
  } catch {
    // Ignore errors — best effort
  }
}

async function pumpEvents(s: RuntimeSession) {
  try {
    for await (const msg of s.q) {
      s.log.write(JSON.stringify(msg) + "\n");
      s.history.push(msg);
      s.lastActivity = new Date();
      s.events.emit("event", msg);

      // Capture SDK session ID from messages for resumption
      const msgAny = msg as { session_id?: string };
      if (msgAny.session_id && !s.sdkSessionId) {
        s.sdkSessionId = msgAny.session_id;
        // Persist SDK session ID to meta.json for recovery after server restart
        void persistSdkSessionId(s);
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

  s.state = state;
  s.events.emit("state", state);

  // Persist certain states to meta.json so they survive restarts
  if (shouldPersistState(state)) {
    void persistSessionState(s, state);
  }
}

// Persist the final state to meta.json for recovery after server restart
async function persistSessionState(s: RuntimeSession, state: SessionState): Promise<void> {
  // Skip for planning sessions (they write to /dev/null)
  if (s.projectSlug === "__planning__") return;

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
    const raw = await fs.readFile(metaPath, "utf8");
    const meta = JSON.parse(raw);
    meta.finalState = state;
    // Persist lastActivity so unread detection doesn't rely on file mtime
    meta.lastActivity = s.lastActivity.toISOString();
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
  } catch {
    // Ignore errors — best effort
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
export async function startProjectSession(p: { projectSlug: string; firstMessage: string; permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan"; model?: string }): Promise<RuntimeSession> {
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
    }, null, 2),
  );

  const log = createWriteStream(path.join(sessionDir, "events.jsonl"), { flags: "a" });
  const inputLog = createWriteStream(path.join(sessionDir, "input.jsonl"), { flags: "a" });

  const input = new InputChannel();
  const events = new EventEmitter();
  events.setMaxListeners(0);

  inputLog.write(JSON.stringify({ at: new Date().toISOString(), text: p.firstMessage }) + "\n");
  input.push(makeUserMessage(p.firstMessage, id));

  // Comments MCP scoped to the project — tools operate on project-level
  // .comments.json (taskSlug is empty).
  const commentsMcp = buildCommentsMcp(p.projectSlug, "");
  // Project-level sessions only get project.md context (no task)
  const systemPrompt = await buildContextSystemPrompt(p.projectSlug, "");
  const q = query({
    prompt: input,
    options: {
      cwd,
      additionalDirectories: [WORKSPACE_ROOT],
      permissionMode: p.permissionMode ?? "bypassPermissions",
      settingSources: ["project", "user"],
      mcpServers: {
        "workbench-comments": commentsMcp,
        "workbench-session": buildSessionMcp(id),
      },
      // Enable Claude in Chrome integration for browser automation
      extraArgs: { chrome: null },
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
    q,
    input,
    events,
    log,
    inputLog,
    history: [firstUserEcho],
    state: "running",
    pendingPermission: null,
    sdkSessionId: null,
    permissionMode: p.permissionMode ?? "bypassPermissions",
    model: p.model ?? null,
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

  input.push(makeUserMessage(firstMessage, id));

  const planningMcp = buildPlanningMcp();
  const q = query({
    prompt: input,
    options: {
      cwd,
      permissionMode: "bypassPermissions",
      // Use Claude Code's preset so the agent retains Read / Glob / Bash for
      // discovering existing projects, with our planning prompt appended.
      systemPrompt: { type: "preset", preset: "claude_code", append: PLANNING_SYSTEM_PROMPT },
      settingSources: ["project", "user"],
      mcpServers: { "workbench-planning": planningMcp },
      // Enable Claude in Chrome integration for browser automation
      extraArgs: { chrome: null },
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
    q,
    input,
    events,
    log: sink,
    inputLog: createWriteStream("/dev/null"),
    history: [firstUserEcho],
    state: "running",
    pendingPermission: null,
    sdkSessionId: null,
    permissionMode: "bypassPermissions",
    model: null,
  };
  registerSession(session);
  session.events.emit("event", firstUserEcho);
  void pumpEvents(session);
  return session;
}

export async function sendInput(id: string, text: string): Promise<boolean> {
  const s = registry.get(id);
  if (!s) return false;

  // If session is stopped/error, resume it first
  if (s.state === "stopped" || s.state === "error") {
    const resumed = await resumeSession(s, text);
    return resumed;
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

  // If session is stopped/error, resume it with the message
  if (s.state === "stopped" || s.state === "error") {
    // For resumed sessions, we can't easily add images to the resume flow
    // Just include the text with file references
    const resumed = await resumeSession(s, messageText);
    return resumed;
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

    // Build MCP servers for the resumed session
    const commentsMcp = buildCommentsMcp(s.projectSlug, s.taskSlug);
    const systemPrompt = await buildContextSystemPrompt(s.projectSlug, s.taskSlug);

    // Create new query with resume option
    s.q = query({
      prompt: s.input,
      options: {
        cwd: s.cwd,
        additionalDirectories: [WORKSPACE_ROOT],
        resume: s.sdkSessionId,
        permissionMode: s.permissionMode,
        settingSources: ["project", "user"],
        mcpServers: {
          "workbench-comments": commentsMcp,
          "workbench-session": buildSessionMcp(s.id),
        },
        // Enable Claude in Chrome integration for browser automation
        extraArgs: { chrome: null },
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

  // Update in-memory seenAt for live sessions
  const liveSession = registry.get(sessionId);
  if (liveSession) {
    liveSession.seenAt = now;
  }

  const project = await getProject(projectSlug);
  if (!project) return !!liveSession; // Return true if we at least updated in-memory

  let sessionDir: string;
  if (!taskSlug) {
    // Project-level session
    sessionDir = path.join(PROJECTS_DIR, project.folderName, "sessions", sessionId);
  } else {
    const task = project.tasks.find((t) => t.slug === taskSlug);
    if (!task) return !!liveSession;
    sessionDir = path.join(PROJECTS_DIR, project.folderName, task.folderName, "sessions", sessionId);
  }

  const metaPath = path.join(sessionDir, "meta.json");
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const meta = JSON.parse(raw);
    meta.seenAt = now.toISOString();
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    return true;
  } catch {
    return !!liveSession; // Return true if we at least updated in-memory
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
// Returns true if successful, false if session not found or is live.
export async function deleteSession(
  projectSlug: string,
  taskSlug: string,
  sessionId: string,
): Promise<boolean> {
  // Don't allow deleting live sessions
  if (registry.has(sessionId)) return false;

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
