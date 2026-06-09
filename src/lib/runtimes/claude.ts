// ClaudeRuntime — wraps @anthropic-ai/claude-agent-sdk's query() function
// as an AgentRuntime. This is the "native" runtime: the AgentQuery shape
// we expose is structurally identical to the SDK's Query.
//
// Subscription→API fallback (mirrors the cloud-agent runner, in-process here):
// when the user's Claude subscription hits its usage limit mid-session, fail
// over to an Anthropic API key (ANTHROPIC_FALLBACK_API_KEY) and keep working,
// switching back when the limit window resets. The lever is the SDK's per-query
// `env`: the API key in ANTHROPIC_API_KEY beats the local OAuth credentials, so
// we rebuild the query with the key in `env` (and `resume` the conversation,
// replaying the failed turn). Per-query `env` means we never mutate the dev
// server's global process.env, so concurrent sessions don't interfere. Gated on
// the key being set — absent, this is a pure passthrough (zero behavior change).

import { query as sdkQuery, type Query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentRuntime,
  AgentQuery,
  AgentQueryOptions,
  AgentEffortLevel,
  AgentEvent,
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

type CredentialMode = "subscription" | "api";

function fallbackApiKey(): string | null {
  const k = process.env.ANTHROPIC_FALLBACK_API_KEY?.trim();
  return k ? k : null;
}
function fallbackMaxUsd(): number | null {
  const v = Number(process.env.ANTHROPIC_FALLBACK_MAX_USD);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// True if a result event is a usage/rate cap. The subscription max-out arrives
// as a result with is_error + api_error_status 429 (message e.g. "You've hit
// your session limit · resets 11:30pm"); we also match a few text variants.
function isQuotaResult(ev: unknown): boolean {
  const e = ev as { type?: string; is_error?: boolean; api_error_status?: number; result?: unknown };
  if (!e || e.type !== "result" || !e.is_error) return false;
  if (e.api_error_status === 429) return true;
  const t = typeof e.result === "string" ? e.result : "";
  return /usage limit|rate limit|session limit|limit reached|reached your.*limit|too many requests|quota/i.test(t);
}

// Build the subprocess env for a credential mode. We spread process.env (so
// HOME — and thus the OAuth credentials path — plus CLAUDE_CODE_DISABLE_1M_CONTEXT
// are preserved) and only toggle ANTHROPIC_API_KEY.
function buildEnv(mode: CredentialMode, key: string | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  if (mode === "api" && key) env.ANTHROPIC_API_KEY = key;
  else delete env.ANTHROPIC_API_KEY;
  return env;
}

function providerSwitchedEvent(provider: CredentialMode, message: string, resetsAt?: number | null): AgentEvent {
  return { type: "system", subtype: "provider_switched", provider, resetsAt: resetsAt ?? null, message } as unknown as AgentEvent;
}

// A minimal async-iterable message channel we feed to the SDK as `prompt`. We
// pump cowork's opts.prompt into the active channel so we can swap the inner
// query (on a provider switch) without cowork noticing — it keeps pushing to
// one opts.prompt; we forward to whichever channel is live.
class InputChannel {
  private queue: unknown[] = [];
  private resolvers: ((r: IteratorResult<unknown>) => void)[] = [];
  private done = false;
  push(m: unknown) {
    if (this.done) return;
    const r = this.resolvers.shift();
    if (r) r({ value: m, done: false });
    else this.queue.push(m);
  }
  end() {
    this.done = true;
    const r = this.resolvers.shift();
    if (r) r({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: (): Promise<IteratorResult<unknown>> => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift(), done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((res) => this.resolvers.push(res));
      },
    };
  }
}

// Simple passthrough used when the fallback is disabled — preserves the exact
// prior behavior (no channel indirection, no rebuild machinery).
class PassthroughQuery implements AgentQuery {
  constructor(private readonly q: Query) {}
  [Symbol.asyncIterator]() { return this.q[Symbol.asyncIterator](); }
  interrupt() { return this.q.interrupt(); }
  close() { try { this.q.close(); } catch { /* already closed */ } }
  setMcpServers(servers: Parameters<Query["setMcpServers"]>[0]) { return this.q.setMcpServers(servers); }
  mcpServerStatus() { return this.q.mcpServerStatus(); }
  setModel(model?: string) { return this.q.setModel(model); }
  supportedModels() { return this.q.supportedModels(); }
  setEffort(effort: AgentEffortLevel | null) {
    return this.q.applyFlagSettings({ effortLevel: effort as "low" | "medium" | "high" | "xhigh" | null });
  }
}

// Fallback-aware query: owns the inner SDK Query and rebuilds it (with a
// different credential `env` + `resume`) on a provider switch. The control flow
// mirrors the cloud-agent runner: detect quota on the result → switch to API,
// resume + replay the failed turn; switch back on the next turn once the window
// resets (or immediately when the spend cap latches).
class FallbackClaudeQuery implements AgentQuery {
  private readonly source: AsyncIterable<unknown>;
  private readonly baseOptions: Record<string, unknown>;
  private readonly key = fallbackApiKey();
  private readonly maxUsd = fallbackMaxUsd();
  private mode: CredentialMode = "subscription";
  private channel = new InputChannel();
  private inner: Query;
  private sdkSessionId: string | null = null;
  private lastUserMessage: unknown = undefined;
  private resetsAt: number | null = null;
  private apiSpendUsd = 0;
  private capped = false;
  private pendingNote: AgentEvent | null = null;
  private simulateQuota = process.env.COWORK_SIMULATE_QUOTA === "1";
  private closed = false;

  constructor(opts: AgentQueryOptions) {
    this.source = opts.prompt as AsyncIterable<unknown>;
    const o = (opts.options ?? {}) as Record<string, unknown>;
    this.baseOptions = {
      ...o,
      includePartialMessages: true,
      model: (o.model as string | undefined) ?? DEFAULT_MODEL,
    };
    this.inner = this.build({});
    void this.pump();
  }

  private build({ resume, replay }: { resume?: string | null; replay?: unknown }): Query {
    const channel = new InputChannel();
    if (replay !== undefined && replay !== null) channel.push(replay);
    this.channel = channel;
    const options: Record<string, unknown> = { ...this.baseOptions, env: buildEnv(this.mode, this.key) };
    if (resume) options.resume = resume;
    return sdkQuery({ prompt: channel as AsyncIterable<never>, options } as Parameters<typeof sdkQuery>[0]);
  }

  // Rebuild the inner query, closing the previous one to release its CLI
  // subprocess. The async-iterator generation guard (this.inner !== myInner)
  // handles the old loop ending after the close.
  private rebuild(args: { resume?: string | null; replay?: unknown }): void {
    const old = this.inner;
    this.inner = this.build(args);
    try { old?.close?.(); } catch { /* already gone */ }
  }

  private normalizeReset(r: number): number {
    return r < 1e12 ? r * 1000 : r;
  }
  private windowReset(): boolean {
    if (this.capped) return true; // cap latched → get off the API key
    if (this.resetsAt == null) return false; // unknown → stay on key (no flapping)
    return Date.now() >= this.normalizeReset(this.resetsAt);
  }

  // Forward cowork's messages to the live channel; on a new turn, flip back to
  // the subscription first if the window reset (or the cap latched).
  private async pump(): Promise<void> {
    try {
      for await (const msg of this.source) {
        if (this.closed) break;
        this.lastUserMessage = msg;
        if (this.mode === "api" && this.windowReset()) {
          const reason = this.capped ? "cap" : "reset";
          this.mode = "subscription";
          this.resetsAt = null;
          this.pendingNote = providerSwitchedEvent(
            "subscription",
            reason === "cap"
              ? "Back on your Claude subscription (API fallback spend cap was reached)."
              : "Your Claude subscription window has reset — switched back to it.",
          );
          this.rebuild({ resume: this.sdkSessionId, replay: msg });
        } else {
          this.channel.push(msg);
        }
      }
      this.channel.end();
    } catch { /* source aborted/ended */ }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
    while (true) {
      if (this.pendingNote) { const n = this.pendingNote; this.pendingNote = null; yield n; }
      const myInner = this.inner;
      let switched = false;
      try {
        for await (const ev of myInner) {
          const e = ev as { type?: string; subtype?: string; session_id?: string; total_cost_usd?: number; rate_limit_info?: { resetsAt?: number } };
          if (e?.type === "system" && e.subtype === "init" && e.session_id) this.sdkSessionId = e.session_id;
          else if (e?.type === "result" && e.session_id && !this.sdkSessionId) this.sdkSessionId = e.session_id;

          if (e?.type === "rate_limit_event") {
            if (e.rate_limit_info?.resetsAt != null) this.resetsAt = e.rate_limit_info.resetsAt;
            yield ev as AgentEvent;
            continue;
          }

          const canSwitch = !!this.key && this.mode !== "api" && !this.capped;
          const simulate = canSwitch && this.simulateQuota && e?.type === "result";
          if (canSwitch && (simulate || isQuotaResult(ev))) {
            if (simulate) this.simulateQuota = false;
            yield providerSwitchedEvent(
              "api",
              "Claude subscription usage limit reached — switched to the Anthropic API key to keep going. I'll switch back to your subscription once it resets.",
              this.resetsAt,
            );
            this.mode = "api";
            this.rebuild({ resume: this.sdkSessionId, replay: this.lastUserMessage });
            switched = true;
            break; // don't emit the quota result; iterate the new query
          }

          if (e?.type === "result" && this.mode === "api" && typeof e.total_cost_usd === "number") {
            this.apiSpendUsd += e.total_cost_usd;
            if (this.maxUsd && !this.capped && this.apiSpendUsd >= this.maxUsd) {
              this.capped = true;
              yield providerSwitchedEvent(
                "subscription",
                `Anthropic API fallback spend cap ($${this.maxUsd}) reached — won't bill the API key further this session. Falling back to your subscription on the next turn.`,
              );
            }
          }

          yield ev as AgentEvent;
        }
      } catch (err) {
        // A rebuild closed this query out from under us — the new one owns the
        // session, so swallow the cancellation. Otherwise it's a real error.
        if (this.inner === myInner) throw err;
      }
      if (switched) continue;            // quota switch — iterate the new query
      if (this.inner !== myInner) continue; // pump switched back — iterate the new query
      break;                              // inner ended and wasn't replaced
    }
  }

  interrupt() { return this.inner.interrupt(); }
  close() { this.closed = true; try { this.inner.close(); } catch { /* already closed */ } }
  setMcpServers(servers: Parameters<Query["setMcpServers"]>[0]) { return this.inner.setMcpServers(servers); }
  mcpServerStatus() { return this.inner.mcpServerStatus(); }
  setModel(model?: string) { return this.inner.setModel(model); }
  supportedModels() { return this.inner.supportedModels(); }
  setEffort(effort: AgentEffortLevel | null) {
    return this.inner.applyFlagSettings({ effortLevel: effort as "low" | "medium" | "high" | "xhigh" | null });
  }
}

export const claudeRuntime: AgentRuntime = {
  id: "claude",
  displayName: "Claude (Anthropic)",
  query(opts: AgentQueryOptions): AgentQuery {
    // When no fallback key is configured (and we're not simulating), stay on the
    // simple passthrough — identical behavior to before this feature.
    if (!fallbackApiKey() && process.env.COWORK_SIMULATE_QUOTA !== "1") {
      const o = (opts.options ?? {}) as Record<string, unknown>;
      const optsWithStreaming = {
        ...opts,
        options: { ...o, includePartialMessages: true, model: (o.model as string | undefined) ?? DEFAULT_MODEL },
      };
      return new PassthroughQuery(sdkQuery(optsWithStreaming as Parameters<typeof sdkQuery>[0]));
    }
    return new FallbackClaudeQuery(opts);
  },
};
