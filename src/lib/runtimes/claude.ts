// ClaudeRuntime — wraps @anthropic-ai/claude-agent-sdk's query() function
// as an AgentRuntime. This is the "native" runtime: the AgentQuery shape
// we expose is structurally identical to the SDK's Query, so this wrapper
// is effectively pass-through.

import { query as sdkQuery, type Query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentRuntime,
  AgentQuery,
  AgentQueryOptions,
} from "../agent-runtime";

class ClaudeAgentQuery implements AgentQuery {
  constructor(private readonly q: Query) {}

  [Symbol.asyncIterator]() {
    return this.q[Symbol.asyncIterator]();
  }

  interrupt() {
    return this.q.interrupt();
  }

  setMcpServers(servers: Parameters<Query["setMcpServers"]>[0]) {
    return this.q.setMcpServers(servers);
  }

  mcpServerStatus() {
    return this.q.mcpServerStatus();
  }
}

export const claudeRuntime: AgentRuntime = {
  id: "claude",
  displayName: "Claude (Anthropic)",
  query(opts: AgentQueryOptions): AgentQuery {
    // Opt into per-token streaming so the UI can show the agent's response
    // forming live. The SDK emits SDKPartialAssistantMessage events
    // (type: "stream_event") alongside the final SDKAssistantMessage; pumpEvents
    // forwards stream_event to the SSE clients but doesn't persist them to
    // events.jsonl (otherwise the log bloats ~30x per turn). The final
    // assistant message is still emitted and persisted normally.
    const o = (opts.options ?? {}) as Record<string, unknown>;
    const optsWithStreaming = {
      ...opts,
      options: { ...o, includePartialMessages: true },
    };
    return new ClaudeAgentQuery(
      sdkQuery(optsWithStreaming as Parameters<typeof sdkQuery>[0]),
    );
  },
};
