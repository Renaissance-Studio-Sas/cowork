// ClaudeRuntime — wraps @anthropic-ai/claude-agent-sdk's query() function
// as an AgentRuntime. This is the "native" runtime: the AgentQuery shape
// we expose is structurally identical to the SDK's Query, so this wrapper
// is effectively pass-through.

import { query as sdkQuery, type Query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentRuntime,
  AgentQuery,
  AgentQueryOptions,
  AgentEffortLevel,
} from "../agent-runtime";

// Force the standard 200k context window for every Claude session.
//
// The account's default model resolves to Sonnet's 1M-context variant
// (alias "claude-sonnet-4-6[1m]"). The CLI enables the 1M beta whenever the
// model string matches /\[1m\]/ UNLESS CLAUDE_CODE_DISABLE_1M_CONTEXT is set
// (see SKH()/D0() in the agent CLI). 1M context is NOT included in the Max
// subscription — it bills as pay-as-you-go usage credits — so once a session's
// transcript grew past 200k tokens every turn 429'd with
// "Usage credits required for 1M context" and silently burned overage credits
// instead of auto-compacting. Disabling it makes the agent compact at 200k,
// which the subscription fully covers. The SDK CLI subprocess inherits this
// process's env, so setting it here at module load covers new + resumed runs.
process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";

// Default model for sessions that don't pin one explicitly. Without this the
// CLI falls back to the account default (Sonnet); we want Opus.
const DEFAULT_MODEL = "opus";

class ClaudeAgentQuery implements AgentQuery {
  constructor(private readonly q: Query) {}

  [Symbol.asyncIterator]() {
    return this.q[Symbol.asyncIterator]();
  }

  interrupt() {
    return this.q.interrupt();
  }

  close() {
    // SDK Query.close() terminates the underlying CLI subprocess. Safe to
    // call multiple times — the SDK guards against double-close internally.
    try {
      this.q.close();
    } catch { /* already closed or process gone */ }
  }

  setMcpServers(servers: Parameters<Query["setMcpServers"]>[0]) {
    return this.q.setMcpServers(servers);
  }

  mcpServerStatus() {
    return this.q.mcpServerStatus();
  }

  setModel(model?: string) {
    return this.q.setModel(model);
  }

  supportedModels() {
    return this.q.supportedModels();
  }

  setEffort(effort: AgentEffortLevel | null) {
    // The SDK applies effort mid-session through the flag-settings layer (the
    // same `apply_flag_settings` control request the CLI uses). `effortLevel`
    // is typed up to 'xhigh'; 'max' is accepted at runtime, so we widen the
    // cast. Passing null clears the flag layer → falls back to the default.
    return this.q.applyFlagSettings({
      effortLevel: effort as "low" | "medium" | "high" | "xhigh" | null,
    });
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
      options: {
        ...o,
        includePartialMessages: true,
        // Pin Opus unless the caller already chose a model.
        model: (o.model as string | undefined) ?? DEFAULT_MODEL,
      },
    };
    return new ClaudeAgentQuery(
      sdkQuery(optsWithStreaming as Parameters<typeof sdkQuery>[0]),
    );
  },
};
