// Session-related types. Lives in its own file so consumers can import
// types without pulling the whole sessions module (and its many runtime
// + fs dependencies) into the typecheck graph.

import type { EventEmitter } from "node:events";
import type { WriteStream } from "node:fs";
import type {
  AgentEvent as SDKMessage,
  AgentPermissionResult as PermissionResult,
  AgentQuery,
} from "../agent-runtime";
import type { InputChannel } from "../input-channel";
import type { SessionState } from "../session-state-machine";

// Which agent runtime drives this session. Claude is the default and is
// what every session today uses; Gemini runs through gemini-cli-core.
// Stored in meta.json so resume after a server restart picks the same
// runtime.
export type SessionRuntime = "claude" | "gemini";

// In-memory live session state. Held in the registry (see registry.ts).
// Created by lifecycle.startSession et al, mutated by pump.ts as the
// runtime streams events, and torn down by watchdog.ts or
// lifecycle.deleteSession.
export interface RuntimeSession {
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
  // Set true by interrupt()/forceStop() so the running pumpEvents loop knows a
  // stop is in flight. The SDK keeps delivering buffered in-flight events after
  // q.interrupt() resolves; without this flag those trailing assistant/result
  // events flip the session back to "running" and the Stop button looks broken.
  // Cleared by resumeSession() when a fresh turn starts.
  interrupted?: boolean;
  // Tool calls awaiting user approval via canUseTool. Keyed by toolUseID.
  // Today this is used for ExitPlanMode (the agent finishes a plan, the SDK
  // asks for user approval before exiting plan mode). The resolver is called
  // by the /api/sessions/[id]/permission endpoint with the user's decision.
  pendingPermissions: Map<string, PendingPermission>;
  // Questions the agent is waiting on (AskUserQuestion). Keyed by a question
  // id we generate at park time. The resolver is called by
  // /api/sessions/[id]/question with the user's selected answers, and its
  // return is what the agent sees as the tool_result.
  pendingQuestions: Map<string, PendingQuestion>;
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

// One AskUserQuestion call parked on the session. The agent's tool handler
// returns once `resolve` is invoked with the user's selections.
export interface AskUserQuestionItem {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string; preview?: string }>;
}

export interface PendingQuestion {
  questions: AskUserQuestionItem[];
  // Each question gets back either an array of selected option labels (from
  // the provided list) or a single free-text answer typed under "Other".
  resolve: (answers: Array<{ selected?: string[]; other?: string }>) => void;
  requestedAt: Date;
}

// Listing-friendly snapshot of a session. Returned by listLiveSessions /
// listAllSessions. UI-side mirror lives in src/lib/types.ts as
// SessionSummaryDTO.
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
