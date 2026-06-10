// Session-related types. Lives in its own file so consumers can import
// types without pulling the whole sessions module (and its many runtime
// + fs dependencies) into the typecheck graph.

import type { EventEmitter } from "node:events";
import type { WriteStream } from "node:fs";
import type {
  AgentEvent as SDKMessage,
  AgentPermissionResult as PermissionResult,
  AgentRateLimitInfo,
  AgentQuery,
} from "../agent-runtime";
import type { InputChannel } from "../input-channel";
import type { SessionState } from "../session-state-machine";

// Which agent runtime drives this session. Claude is the default and is
// what every session today uses; Gemini runs through gemini-cli-core; remote
// provisions a container via the local cloud-agent-runner controller; cloud
// talks to the cloud-agent worker on Cloudflare (app.rowads.studio/api/agent/*)
// and authenticates via the rw CLI's stored session cookie. Stored in
// meta.json so resume after a server restart picks the same runtime.
export type SessionRuntime = "claude" | "gemini" | "cloud";

// Thinking effort level. Mirrors the Claude Agent SDK's EffortLevel
// (see @anthropic-ai/claude-agent-sdk). Passed to query() as `effort` and
// also accepted by the CLI's /model command. When null, the SDK uses its
// default ('high').
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

// In-memory live session state. Held in the registry (see registry.ts).
// Created by lifecycle.startSession et al, mutated by pump.ts as the
// runtime streams events, and torn down by watchdog.ts or
// lifecycle.deleteSession.
export interface RuntimeSession {
  id: string;
  // Slug-chain of the workspace this session belongs to, e.g. ["HR", "pay-contractors"].
  // Single-element for what used to be a project-level session, two or more
  // for any nested workspace. The empty-array case is never valid — every
  // session must live in some workspace.
  workspacePath: string[];
  cwd: string;
  title: string;                 // short label derived from first message (e.g. "Add dark mode")
  startedAt: Date;
  lastActivity: Date;
  seenAt: Date | null;           // when user last viewed this session (null = never seen)
  completedAt: Date | null;      // when session finished (idle/stopped/error) — for unread tracking
  q: AgentQuery;
  input: InputChannel;
  events: EventEmitter;          // emits 'event' (SDKMessage) and 'state' (SessionState)
  inputLog: WriteStream;         // input.jsonl
  history: SDKMessage[];         // in-memory replay buffer for new SSE clients
  // Monotonic per-session event sequence number. Assigned to every persisted
  // event via cloud-events.appendEvent(id, seq, event) using `seq++`. Starts at
  // 0 for a new session and is seeded to history.length on restore (history is
  // rebuilt from the full D1 event log), so D1's seq-keyed idempotent writes
  // (onConflict: ignore) never collide or silently drop events across restarts.
  seq: number;
  // Accumulated text from `text_delta` stream_event chunks of the CURRENT
  // in-flight assistant turn. Per-token deltas aren't persisted to history
  // (they'd bloat the event log ~30× per turn), so without this buffer a
  // client that joins mid-stream sees only the deltas that arrive after it
  // connects. Cleared whenever a non-stream assistant/result/user message
  // ends the current text block, and on resume when a fresh turn begins —
  // mirrors the client-side reset in Chat.tsx so server and live UI stay
  // in sync.
  streamingText: string;
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
  // Completion suggestions the agent has parked via the suggest_session_complete
  // tool. Keyed by a request id we generate at park time. Resolved by
  // /api/sessions/[id]/complete with { requestId, approved }. The tool handler
  // unblocks with the user's decision.
  pendingCompletions: Map<string, PendingCompletion>;
  // Whether the human (or agent + human approval) has marked this session
  // complete. Sticky across reloads via meta.json. Cleared automatically when
  // a new user message is sent (the session is being revived).
  completed: boolean;
  // Whether the human has moved this session to the backlog — its completion is
  // waiting on something external (another session, a person, a dependency).
  // Sticky across reloads via meta.json. Orthogonal to `completed` and to the
  // runtime state. Backlog sessions drop out of the "Active Sessions" list into
  // a separate "Backlog" list. Cleared automatically when a new user message is
  // sent (the dependency is presumably resolved).
  backlog: boolean;
  sdkSessionId: string | null;   // the SDK's internal session ID for resumption
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  model: string | null;
  effort: EffortLevel | null;    // thinking effort, null = SDK default ('high')
  runtime: SessionRuntime;       // claude (default) | gemini
  // Verbatim text of the user's first message — kept so auto-titling can
  // summarize it after turn 1 without re-parsing history[0].
  firstMessage?: string;
  // Flips true the first time a `result` event fires for this session, so
  // the auto-titler runs at most once. Resume does not reset it.
  autoTitleAttempted?: boolean;
  // Track retry attempts for 529 (overloaded) errors. Reset on successful
  // completion or manual user input.
  retryAttempts?: number;
  // Serialized snapshot of the last todo list emitted on the `todos` event.
  // Used to diff so pumpEvents only re-emits when the derived list actually
  // changes. The list itself is derived from the full `history` (see
  // @/lib/todos), keeping the task panel correct independent of how much
  // transcript the chat UI has lazily loaded.
  lastTodosJson?: string;
  // Latest claude.ai subscription rate-limit snapshot, from the SDK's
  // `rate_limit_event`. Held (not persisted to history) so the SSE route can
  // replay it to a freshly-connecting client and the chat UI can show a small
  // usage indicator. Only the Claude runtime ever sets it.
  rateLimit?: AgentRateLimitInfo;
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

// A user's answer to a single AskUserQuestion item. `refused: true` means
// the user dismissed the prompt instead of picking an option.
export type AskUserQuestionAnswer = { selected?: string[]; other?: string } | { refused: true };

export interface PendingQuestion {
  questions: AskUserQuestionItem[];
  // The user either answers every question or refuses the whole prompt. We
  // resolve with `null` for refusal and an array otherwise.
  resolve: (answers: AskUserQuestionAnswer[] | null) => void;
  requestedAt: Date;
}

// Agent's request to mark the session complete, awaiting user approval.
export interface PendingCompletion {
  reason?: string;               // optional one-line summary from the agent
  resolve: (approved: boolean) => void;
  requestedAt: Date;
}

// Listing-friendly snapshot of a session. Returned by listLiveSessions /
// listAllSessions. UI-side mirror lives in src/lib/types.ts as
// SessionSummaryDTO.
export interface SessionSummary {
  id: string;
  workspacePath: string[];
  state: SessionState;
  title: string;
  startedAt: string;             // ISO
  lastActivity: string;          // ISO
  isLive: boolean;
  unread: boolean;               // completed session not yet viewed
  completed: boolean;            // sticky "marked complete" flag (manual or agent-suggested + approved)
  backlog: boolean;              // sticky "moved to backlog" flag — completion waits on something external
  hasPendingPrompt: boolean;     // agent's turn is parked on a user decision (permission/question/completion)
  runtime: SessionRuntime;
  model: string | null;          // actual model id (e.g. "claude-opus-4-7", "gemini-3.5-flash")
  effort: EffortLevel | null;    // thinking effort, null = SDK default ('high')
}
