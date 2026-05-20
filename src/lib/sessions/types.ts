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
