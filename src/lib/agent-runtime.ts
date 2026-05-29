// Neutral interface that every agent backend (Claude SDK, Gemini, Codex, …)
// implements. cowork's session machinery (pumpEvents, sendInput, interrupt,
// the SSE route, the chat UI) speaks only this interface — nothing in
// sessions.ts imports an SDK type directly. To add a new runtime: write a
// file under src/lib/runtimes/, implement AgentRuntime, and register it in
// runtimes/index.ts.
//
// The event shape is intentionally structurally compatible with the Claude
// SDK's SDKMessage today — the UI already knows how to render that shape and
// rewriting it would be a much bigger refactor. Gemini/Codex implementations
// translate their native events into this shape at the runtime boundary.
// We can evolve AgentEvent into something more neutral later without
// touching consumers, because the type lives here.

import type {
  SDKMessage,
  SDKUserMessage,
  CanUseTool,
  PermissionResult,
  McpServerConfig,
  McpSetServersResult,
} from "@anthropic-ai/claude-agent-sdk";

// What the runtime emits during a turn. Today this is exactly Claude's
// SDKMessage union so the chat UI / pumpEvents don't change. Treat this as
// the canonical event shape across all runtimes — implementations translate
// into it, never out of it. If you find yourself reaching for SDKMessage in
// consumer code, import AgentEvent instead.
export type AgentEvent = SDKMessage;

// What the caller pushes into a runtime as user input. Same story — today
// this is Claude SDK's SDKUserMessage so InputChannel doesn't need to change.
export type AgentUserMessage = SDKUserMessage;

// Permission-flow types (used by ExitPlanMode + future tool approval flows).
// Re-exported so consumers don't have to know they originated in Claude SDK.
export type AgentCanUseTool = CanUseTool;
export type AgentPermissionResult = PermissionResult;

// MCP server configuration shape, accepted by AgentQuery.setMcpServers().
// Today this aliases the Claude SDK's MCP descriptor — session-mcp.ts
// already builds objects of this shape, so the migration stays mechanical.
// Runtimes that don't support MCP (Gemini v0, future Codex stub) silently
// no-op the call.
export type AgentMcpServer = McpServerConfig;

export interface AgentMcpServerStatus {
  name: string;
  status: string;
}

export type AgentSetMcpServersResult = McpSetServersResult;

// Options passed to AgentRuntime.query(). Mirrors Claude SDK's query options
// but exposed under our own type so other runtimes don't have to depend on
// @anthropic-ai/claude-agent-sdk's option shape.
export interface AgentQueryOptions {
  prompt: AsyncIterable<AgentUserMessage>;
  cwd?: string;
  model?: string;
  // Claude SDK accepts either a preset shape or a raw string. Gemini's adapter
  // honors only the `append` text when it's the preset shape, or the string
  // verbatim.
  systemPrompt?:
    | { type: "preset"; preset: "claude_code"; append: string }
    | string;
  // Tool approval callback (used today for ExitPlanMode in Claude). Runtimes
  // that don't have an equivalent loop can ignore it.
  canUseTool?: AgentCanUseTool;
  // Static MCP servers registered at start; AgentQuery.setMcpServers() can
  // mutate later (e.g. when chrome_connect wires the browser bridge).
  mcpServers?: Record<string, AgentMcpServer>;
  // Runtime-agnostic in-process tool groups (cowork's workbench tools).
  // Each runtime's adapter handles registration in its native way: Claude
  // wraps each group as a createSdkMcpServer MCP and merges into
  // mcpServers; Gemini registers them as native Tools in gemini-cli-core's
  // ToolRegistry. See src/lib/workbench-tools/ for definitions.
  workbenchToolGroups?: Array<{ name: string; tools: import("./workbench-tools/types").WorkbenchTool[] }>;
  // Optional per-session directory where the runtime can persist arbitrary
  // state (history snapshots, etc.) it needs to survive server restarts.
  // Claude doesn't need this — the SDK manages its own transcript files
  // keyed by sdkSessionId. Gemini uses it for `gemini-history.json` so the
  // conversation context comes back after restart.
  runtimeStateDir?: string;
  // Runtime-specific knobs we don't want to enumerate here pass through
  // verbatim. The runtime implementation is responsible for what it accepts.
  [key: string]: unknown;
}

// A live turn-by-turn conversation with the agent. Each query() call returns
// one of these; the caller iterates events, pushes input via the prompt
// AsyncIterable, and can interrupt mid-stream.
export interface AgentQuery extends AsyncIterable<AgentEvent> {
  interrupt(): Promise<void>;
  // Forcefully end the query and kill the underlying subprocess (Claude CLI
  // child, gemini-cli-core abort, remote runner stream). Unlike interrupt(),
  // which only asks the agent to stop the current turn and leaves the process
  // alive waiting for further input, close() guarantees the subprocess is
  // gone. resumeSession() relies on this to prevent two SDK subprocesses
  // running concurrently against the same sdkSessionId after a resume.
  close(): void;
  setMcpServers(servers: Record<string, AgentMcpServer>): Promise<AgentSetMcpServersResult>;
  mcpServerStatus(): Promise<AgentMcpServerStatus[]>;
}

// A runtime backend (Claude, Gemini, Codex). Stateless — query() spawns a
// new AgentQuery per session. The registry in runtimes/index.ts holds one
// instance per backend.
export interface AgentRuntime {
  // Stable string id; matches the SessionRuntime union in sessions.ts.
  readonly id: string;
  // Human-readable name shown in the runtime selector dropdown.
  readonly displayName: string;
  query(opts: AgentQueryOptions): AgentQuery;
}
