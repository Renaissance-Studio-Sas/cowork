// GeminiRuntime — implements AgentRuntime on top of @google/gemini-cli-core.
//
// We use the high-level GeminiClient.sendMessageStream rather than the
// lower-level GeminiChat. The client drives the full agent loop
// (model call → tool execution → continue) and emits a typed event
// stream we translate into our AgentEvent shape. Without this, a tool
// call requested by the model wouldn't actually execute — sendMessage
// at the chat level is one round-trip with the LLM, not a loop.
//
// Auth: env vars read by gemini-cli-core's getAuthTypeFromEnv():
//   GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_CLOUD_PROJECT + GOOGLE_CLOUD_LOCATION
// resolves to AuthType.USE_VERTEX_AI with ADC. gemini-3.5-flash requires
// GOOGLE_CLOUD_LOCATION=global (see .env.local) — regional endpoints 404
// for the 3.x family.

import { randomUUID } from "node:crypto";
import {
  Config,
  AuthType,
  ApprovalMode,
  GeminiEventType,
  Scheduler,
  type GeminiClient,
  type GeminiChat,
  type ServerGeminiStreamEvent,
  type Turn,
  type CompletedToolCall,
  type ToolCallRequestInfo,
} from "@google/gemini-cli-core";
import type {
  AgentRuntime,
  AgentQuery,
  AgentQueryOptions,
  AgentEvent,
  AgentUserMessage,
  AgentMcpServer,
  AgentSetMcpServersResult,
  AgentMcpServerStatus,
} from "../agent-runtime";
import type { WorkbenchTool } from "../workbench-tools/types";
import { registerWorkbenchToolsInGemini } from "./gemini-tool-adapter";

const DEFAULT_MODEL = "gemini-3.5-flash";

class GeminiAgentQuery implements AgentQuery {
  private readonly input: AsyncIterable<AgentUserMessage>;
  private readonly cwd: string;
  private readonly model: string;
  private readonly sessionId: string;
  private readonly systemInstruction: string | undefined;
  private readonly abort = new AbortController();
  private readonly workbenchToolGroups: Array<{ name: string; tools: WorkbenchTool[] }>;

  // Lazy: bootstrap is async (refreshAuth → initialize → startChat) so we
  // set up on first iteration rather than in the sync AgentRuntime
  // constructor.
  private config: Config | null = null;
  private client: GeminiClient | null = null;
  // `chat` is started for its side-effect of populating the client's
  // active chat session; sendMessageStream uses it implicitly via the
  // client. Kept on the instance for future inspection / resume work.
  private chat: GeminiChat | null = null;
  // Drives tool execution between model turns. cli-core's
  // sendMessageStream sets turn.pendingToolCalls but doesn't execute
  // them — we feed them to the scheduler, then send the responses
  // back as the next request.
  private scheduler: Scheduler | null = null;

  constructor(opts: AgentQueryOptions) {
    this.input = opts.prompt;
    // sessions.ts builds Claude-SDK-shaped options: { prompt, options: { cwd,
    // model, workbenchToolGroups, systemPrompt, … } }. Read from the nested
    // `options` first, fall back to top-level for direct AgentQueryOptions
    // callers.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nested = (opts as any).options as Record<string, unknown> | undefined;
    const get = <T>(key: string): T | undefined =>
      (nested?.[key] as T | undefined) ?? (opts as unknown as Record<string, T>)[key];

    this.cwd = get<string>("cwd") || process.cwd();
    this.model = get<string>("model") || DEFAULT_MODEL;
    this.sessionId = `gemini-${randomUUID().slice(0, 8)}`;
    this.workbenchToolGroups = get<typeof this.workbenchToolGroups>("workbenchToolGroups") ?? [];

    const sysPrompt = get<AgentQueryOptions["systemPrompt"]>("systemPrompt");
    if (typeof sysPrompt === "object" && sysPrompt) {
      this.systemInstruction = sysPrompt.append;
    } else if (typeof sysPrompt === "string") {
      this.systemInstruction = sysPrompt;
    }
  }

  private async bootstrap(): Promise<void> {
    if (this.client) return;
    this.config = new Config({
      sessionId: this.sessionId,
      clientName: "cowork",
      model: this.model,
      cwd: this.cwd,
      targetDir: this.cwd,
      debugMode: false,
      // Disable telemetry — gemini-cli-core has clearcut/usage hooks
      // intended for the CLI; cowork isn't the CLI.
      usageStatisticsEnabled: false,
      // YOLO mode = auto-approve every tool call. cowork's permission
      // model is "bypassPermissions" by default (matches the Claude
      // runtime), and we don't have an interactive confirm UI to call
      // back into. Without this, the scheduler refuses tool execution
      // with "requires user confirmation, which is not supported in
      // non-interactive mode." Plan-mode-style approvals can be plumbed
      // later via canUseTool when we add that wiring.
      approvalMode: ApprovalMode.YOLO,
    });
    await this.config.refreshAuth(AuthType.USE_VERTEX_AI);
    await this.config.initialize();

    // Register cowork's workbench tools into the Config's ToolRegistry so
    // they're visible to the agent. Done before startChat() so the chat's
    // initial tools snapshot includes them.
    for (const group of this.workbenchToolGroups) {
      registerWorkbenchToolsInGemini(this.config, group.tools);
    }

    this.client = this.config.getGeminiClient();
    await this.client.initialize();
    // startChat builds the GeminiChat with tools pulled from the registry
    // (in the Vertex-API wire shape, which we'd otherwise have to assemble
    // ourselves). It also wires the onModelChanged callback for tool
    // re-resolution if the model is swapped mid-session.
    this.chat = await this.client.startChat();
    if (this.systemInstruction) {
      this.chat.setSystemInstruction(this.systemInstruction);
    }

    // Scheduler executes pending tool calls between model turns. cowork
    // doesn't ship an editor UI, so getPreferredEditor returns undefined
    // (the scheduler falls back to its no-confirm path for tools that
    // would otherwise require an editor pick).
    this.scheduler = new Scheduler({
      context: this.config,
      messageBus: this.config.getMessageBus(),
      getPreferredEditor: () => undefined,
      schedulerId: `cowork-${this.sessionId}`,
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    try {
      await this.bootstrap();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[gemini-runtime] bootstrap failed:`, errorMsg);
      yield initEvent(this.sessionId, this.cwd, this.model);
      yield resultErrorEvent(this.sessionId, `gemini-cli-core bootstrap failed: ${errorMsg}`);
      return;
    }

    yield initEvent(this.sessionId, this.cwd, this.model);

    for await (const userMsg of this.input) {
      if (this.abort.signal.aborted) break;
      const text = extractUserText(userMsg);
      if (!text) continue;

      const turnUuid = randomUUID();
      const promptId = `prompt_${Date.now()}`;
      let accumulated = "";
      // Tracks tool_use IDs we've emitted, so subsequent tool_result
      // messages reference the matching id. cli-core uses its own callId;
      // we generate a stable mapping per turn.
      const callIdToToolUseId = new Map<string, string>();
      // Cap how many model↔tool round-trips we'll do per user message.
      // cli-core has its own MAX_TURNS (in the hundreds) but we want a
      // tighter belt-and-braces here too so a runaway agent can't loop
      // forever on the user's nickel.
      const MAX_TOOL_ROUNDS = 25;

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let request: any = [{ text }];
        let rounds = 0;

        while (true) {
          if (this.abort.signal.aborted) break;
          if (++rounds > MAX_TOOL_ROUNDS) {
            yield {
              type: "system",
              subtype: "error",
              message: `Exceeded ${MAX_TOOL_ROUNDS} tool-execution rounds in one turn — aborting`,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any;
            break;
          }

          const stream = this.client!.sendMessageStream(
            request,
            this.abort.signal,
            promptId,
          );

          // Manual iteration so we can capture the AsyncGenerator's return
          // value (the Turn instance). `for await … of stream` discards it.
          const iter = stream[Symbol.asyncIterator]();
          let turn: Turn | undefined;
          // Buffer per-round text + tool_uses so the final assistant
          // message for the round is ONE Claude-shaped message with all
          // content parts. Emitting tool_use as its own assistant message
          // would clear the UI's streaming text bubble (which has been
          // showing the model's text via stream_event deltas) with no
          // replacement text content — the user sees the agent's text
          // appear briefly then vanish.
          let turnText = "";
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const turnToolUses: Array<{ type: "tool_use"; id: string; name: string; input: any }> = [];

          // eslint-disable-next-line no-constant-condition
          while (true) {
            const r = await iter.next();
            if (r.done) {
              turn = r.value;
              break;
            }
            const ev = r.value;
            // Content events: stream the delta to the UI for live-rendering,
            // and accumulate into the round's text buffer.
            if (ev.type === GeminiEventType.Content) {
              const text = (ev as { value?: string }).value;
              if (text) {
                turnText += text;
                accumulated += text;
                yield {
                  type: "stream_event",
                  uuid: turnUuid,
                  session_id: this.sessionId,
                  parent_tool_use_id: null,
                  event: {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text },
                  },
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any;
              }
              continue;
            }
            // Tool-call requests: buffer; we'll emit one consolidated
            // assistant message with [text, tool_uses...] when the stream
            // ends.
            if (ev.type === GeminiEventType.ToolCallRequest) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const req = (ev as any).value as { callId: string; name: string; args: Record<string, unknown> };
              const toolUseId = `toolu_${randomUUID().slice(0, 12)}`;
              callIdToToolUseId.set(req.callId, toolUseId);
              turnToolUses.push({ type: "tool_use", id: toolUseId, name: req.name, input: req.args });
              continue;
            }
            // Other event types (Error, etc.) → translate normally.
            for (const out of translateEvent(ev, this.sessionId, this.model, turnUuid, callIdToToolUseId)) {
              yield out;
            }
          }

          // End-of-round consolidation: emit ONE assistant message with the
          // text + tool_use content parts. The persisted text replaces the
          // UI's streaming bubble cleanly. Skip if no text and no tools
          // (rare — the model emitted nothing this round).
          if (turnText || turnToolUses.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const content: any[] = [];
            if (turnText) content.push({ type: "text", text: turnText });
            for (const tu of turnToolUses) content.push(tu);
            yield {
              type: "assistant",
              session_id: this.sessionId,
              parent_tool_use_id: null,
              message: {
                id: `msg_${Date.now()}`,
                role: "assistant",
                type: "message",
                model: this.model,
                content,
                stop_reason: turnToolUses.length > 0 ? "tool_use" : "end_turn",
                stop_sequence: null,
                usage: {},
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any;
          }

          // No pending tool calls → the agent finished this turn.
          const pending = turn?.pendingToolCalls ?? [];
          if (pending.length === 0) break;

          // Execute the pending tool calls via the scheduler. It walks
          // through validation → confirmation → execution → result. For
          // cowork's permission model (bypassPermissions), the
          // confirmation step auto-allows.
          const completed = await this.scheduler!.schedule(
            pending as ToolCallRequestInfo[],
            this.abort.signal,
          );

          // Surface tool_result events to the UI as Claude-shaped user
          // messages, mirroring what the Claude SDK does. Each call's
          // toolUseId was registered when we buffered the ToolCallRequest.
          for (const c of completed) {
            yield toolResultEventFromCompleted(c, callIdToToolUseId, this.sessionId);
          }

          // Build the next request from each completed call's responseParts.
          // cli-core expects the conversation to alternate functionCall
          // (already in chat history from the prior Turn) ↔ functionResponse.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const nextRequest: any[] = [];
          for (const c of completed) {
            const parts = (c as { response?: { responseParts?: unknown[] } }).response?.responseParts ?? [];
            for (const p of parts) nextRequest.push(p);
          }
          if (nextRequest.length === 0) break;
          request = nextRequest;
        }

        yield resultSuccessEvent(this.sessionId, accumulated);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[gemini-runtime] sendMessageStream failed:`, errorMsg);
        yield resultErrorEvent(this.sessionId, errorMsg);
      }
    }
  }

  async interrupt(): Promise<void> {
    this.abort.abort();
  }

  // Step: gemini-cli MCP integration wiring is its own piece of work; today
  // setMcpServers is a no-op so chrome_connect from a Gemini session doesn't
  // crash. Chrome support in gemini-cli-core is its own follow-up.
  async setMcpServers(_servers: Record<string, AgentMcpServer>): Promise<AgentSetMcpServersResult> {
    return { added: [], removed: [], errors: {} };
  }

  async mcpServerStatus(): Promise<AgentMcpServerStatus[]> {
    return [];
  }
}

export const geminiRuntime: AgentRuntime = {
  id: "gemini",
  displayName: "Gemini (Google)",
  query(opts: AgentQueryOptions): AgentQuery {
    return new GeminiAgentQuery(opts);
  },
};

// Translate one ServerGeminiStreamEvent (cli-core's typed event union)
// into zero or more AgentEvents (Claude SDK-shaped, which the UI and
// pumpEvents already speak). cli-core's loop emits Content for text
// deltas, ToolCallRequest when the model asks to invoke a tool, and
// ToolCallResponse when execution completes — we map each to the
// corresponding Claude-shaped message.
function translateEvent(
  ev: ServerGeminiStreamEvent,
  sessionId: string,
  model: string,
  turnUuid: string,
  callIdToToolUseId: Map<string, string>,
): AgentEvent[] {
  switch (ev.type) {
    case GeminiEventType.Content: {
      // Text delta — emit as stream_event for incremental UI rendering.
      const text = (ev as { value?: string }).value;
      if (!text) return [];
      return [{
        type: "stream_event",
        uuid: turnUuid,
        session_id: sessionId,
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any];
    }
    case GeminiEventType.ToolCallRequest: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req = (ev as any).value as { callId: string; name: string; args: Record<string, unknown> };
      const toolUseId = `toolu_${randomUUID().slice(0, 12)}`;
      callIdToToolUseId.set(req.callId, toolUseId);
      return [{
        type: "assistant",
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          id: `msg_${Date.now()}`,
          role: "assistant",
          type: "message",
          model,
          content: [{ type: "tool_use", id: toolUseId, name: req.name, input: req.args }],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: {},
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any];
    }
    case GeminiEventType.ToolCallResponse: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp = (ev as any).value as {
        callId: string;
        responseParts?: Array<{ text?: string; functionResponse?: { response?: unknown } }>;
        error?: Error;
      };
      const toolUseId = callIdToToolUseId.get(resp.callId) ?? `toolu_${randomUUID().slice(0, 12)}`;
      const text = resp.responseParts
        ?.map((p) => {
          if (typeof p.text === "string") return p.text;
          if (p.functionResponse?.response) return JSON.stringify(p.functionResponse.response);
          return "";
        })
        .filter(Boolean)
        .join("\n") ?? (resp.error ? String(resp.error.message ?? resp.error) : "");
      return [{
        type: "user",
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: toolUseId,
            content: text,
            is_error: !!resp.error,
          }],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any];
    }
    case GeminiEventType.Thought:
    case GeminiEventType.Citation:
    case GeminiEventType.Retry:
    case GeminiEventType.Finished:
    case GeminiEventType.ChatCompressed:
    case GeminiEventType.ModelInfo:
      // Silent — these are flow control / metadata cli-core uses
      // internally. Could be surfaced as system events in the future.
      return [];
    case GeminiEventType.Error: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = (ev as any).value as { error?: unknown };
      const message = v?.error ? String(v.error) : "Unknown error";
      return [{
        type: "system",
        subtype: "error",
        message,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any];
    }
    default:
      return [];
  }
}

// Translate a scheduler-completed tool call into a Claude-shaped user/
// tool_result message. The toolUseId comes from the map populated when we
// translated the ToolCallRequest earlier in the stream.
function toolResultEventFromCompleted(
  c: CompletedToolCall,
  callIdToToolUseId: Map<string, string>,
  sessionId: string,
): AgentEvent {
  const callId = c.request?.callId;
  const toolUseId = (callId && callIdToToolUseId.get(callId)) ?? `toolu_${randomUUID().slice(0, 12)}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp = (c as any).response as { responseParts?: Array<{ text?: string; functionResponse?: { response?: unknown } }>; error?: Error } | undefined;
  const text = resp?.responseParts
    ?.map((p) => {
      if (typeof p.text === "string") return p.text;
      if (p.functionResponse?.response) return JSON.stringify(p.functionResponse.response);
      return "";
    })
    .filter(Boolean)
    .join("\n") ?? (resp?.error ? String(resp.error.message ?? resp.error) : "");
  return {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: toolUseId,
        content: text,
        is_error: !!resp?.error,
      }],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function initEvent(sessionId: string, cwd: string, model: string): AgentEvent {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd,
    model,
    tools: [],
    mcp_servers: [],
    slash_commands: [],
    permissionMode: "bypassPermissions",
    apiKeySource: "env",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function resultSuccessEvent(sessionId: string, text: string): AgentEvent {
  return {
    type: "result",
    subtype: "success",
    session_id: sessionId,
    is_error: false,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    result: text,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function resultErrorEvent(sessionId: string, errorMsg: string): AgentEvent {
  return {
    type: "result",
    subtype: "error",
    session_id: sessionId,
    is_error: true,
    error: errorMsg,
    result: errorMsg,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function extractUserText(msg: AgentUserMessage): string {
  const c = (msg as { message?: { content?: unknown } }).message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return (c as Array<{ type?: string; text?: string }>)
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
  }
  return "";
}
