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
import fs from "node:fs/promises";
import path from "node:path";
import {
  Config,
  AuthType,
  ApprovalMode,
  GeminiEventType,
  Scheduler,
  MCPServerConfig,
  getCoreSystemPrompt,
  type GeminiClient,
  type GeminiChat,
  type ServerGeminiStreamEvent,
  type Turn,
  type CompletedToolCall,
  type ToolCallRequestInfo,
} from "@google/gemini-cli-core";
import { getMCPServerStatus, MCPServerStatus } from "@google/gemini-cli-core/dist/src/tools/mcp-client.js";
import type {
  AgentRuntime,
  AgentQuery,
  AgentQueryOptions,
  AgentEvent,
  AgentUserMessage,
  AgentMcpServer,
  AgentSetMcpServersResult,
  AgentMcpServerStatus,
  AgentModelInfo,
  AgentEffortLevel,
  AgentCanUseTool,
  AgentPermissionResult,
} from "../agent-runtime";
import type { WorkbenchTool } from "../workbench-tools/types";
import { registerWorkbenchToolsInGemini } from "./gemini-tool-adapter";

// Pinned to gemini-3.5-flash. cli-core has an auto-routing alias
// ("auto-gemini-2.5") that engages ModelRouterService to pick per-turn,
// but for now we want the predictable cost/latency of flash for every
// turn. Switch to auto-routing later if/when we want adaptive picking.
// Overridable per session via StartSessionParams.model.
const DEFAULT_MODEL = "gemini-3.5-flash";

class GeminiAgentQuery implements AgentQuery {
  private readonly input: AsyncIterable<AgentUserMessage>;
  private readonly cwd: string;
  private readonly model: string;
  private readonly sessionId: string;
  private readonly systemInstruction: string | undefined;
  private readonly abort = new AbortController();
  private readonly workbenchToolGroups: Array<{ name: string; tools: WorkbenchTool[] }>;
  // Where to read/write `gemini-history.json` for restart-survival. Optional —
  // when absent, the session is effectively single-process-lifetime.
  private readonly runtimeStateDir: string | undefined;
  // Optional pre-tool-execution hook. cowork passes its `canUseTool`
  // callback here. It's called BEFORE each pending tool call is handed
  // to the Scheduler. Allows cowork to deny tools (synthesizes a
  // "denied" tool_result) or async-park a call awaiting user approval
  // (e.g. plan-mode flows). When unset, every call auto-allows — same
  // shape as the Claude runtime's default.
  private readonly canUseTool: AgentCanUseTool | undefined;

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
    const nested = (opts as any).options as Record<string, unknown> | undefined;
    const get = <T>(key: string): T | undefined =>
      (nested?.[key] as T | undefined) ?? (opts as unknown as Record<string, T>)[key];

    this.cwd = get<string>("cwd") || process.cwd();
    this.model = get<string>("model") || DEFAULT_MODEL;
    this.sessionId = `gemini-${randomUUID().slice(0, 8)}`;
    this.workbenchToolGroups = get<typeof this.workbenchToolGroups>("workbenchToolGroups") ?? [];
    this.runtimeStateDir = get<string>("runtimeStateDir");
    this.canUseTool = get<AgentCanUseTool>("canUseTool");

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
      // YOLO mode at the scheduler level (cli-core auto-approves every
      // tool call rather than refusing with "requires user confirmation").
      // The actual cowork-side approval gate is our checkPermission() above
      // the scheduler — it runs BEFORE we hand tools to the scheduler,
      // calls into AgentQueryOptions.canUseTool, and either allows,
      // denies, or async-parks (plan-mode-style approvals). YOLO here
      // means "if it reached the scheduler, cowork already approved."
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
    // client.initialize() calls startChat() internally and stores the
    // resulting GeminiChat on client.chat — that's the chat instance
    // sendMessageStream will use. We must NOT call startChat() externally
    // (it returns a fresh chat but doesn't replace client.chat, so we'd
    // end up reading/writing history on a chat that the model never sees).
    await this.client.initialize();
    this.chat = this.client.getChat();
    if (this.systemInstruction) {
      // Mirror Claude SDK's `{ preset, append }` semantics: keep the
      // gemini-cli-core default system prompt and append cowork's context
      // onto it, rather than replacing it. setSystemInstruction is a
      // wholesale replace, so we recompute the default the same way
      // GeminiClient.startChat does (client.js:255) and concatenate.
      const base = getCoreSystemPrompt(this.config, this.config.getSystemInstructionMemory());
      this.chat.setSystemInstruction(`${base}\n\n${this.systemInstruction}`);
    }

    // Reload prior conversation history from disk if this session has
    // run before (server restart, or user re-opened a stopped session).
    // Without this, the model starts fresh each turn — we observed it
    // returning empty responses to "hello?" because the implicit
    // "[Server restarted — please continue]" prompt has no context.
    const priorHistory = await this.loadHistory();
    if (priorHistory && priorHistory.length > 0) {
      // gemini-cli-core 0.44 dropped setHistory's `{ silent }` option; it now
      // takes the history array only.
      this.chat.setHistory(priorHistory as any);
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
      // Track if the stream errored — used to emit resultErrorEvent instead
      // of resultSuccessEvent when the turn ends with no content.
      let streamError: string | null = null;
      // Tracks tool_use IDs we've emitted, so subsequent tool_result
      // messages reference the matching id. cli-core uses its own callId;
      // we generate a stable mapping per turn.
      const callIdToToolUseId = new Map<string, string>();
      // Cap how many model↔tool round-trips we'll do per user message.
      // Set generously — 1000 — because a long agent session can run
      // hundreds of tool calls (codebase exploration + edits + builds +
      // tests). cli-core's own MAX_TURNS is 100 internally but that's
      // for its recursive continuation; we count round trips. The cap is
      // just belt-and-braces against a model that's literally looping
      // on the same call forever; when we hit it we surface a clear
      // error in the chat so the user knows why the session stopped.
      const MAX_TOOL_ROUNDS = 1000;

      try {
        let request: any = [{ text }];
        let rounds = 0;

        while (true) {
          if (this.abort.signal.aborted) break;
          if (++rounds > MAX_TOOL_ROUNDS) {
            yield {
              type: "system",
              subtype: "error",
              message: `Exceeded ${MAX_TOOL_ROUNDS} tool-execution rounds in one turn — aborting`,
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
          const turnToolUses: Array<{ type: "tool_use"; id: string; name: string; input: any }> = [];

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
                } as any;
              }
              continue;
            }
            // Tool-call requests: buffer; we'll emit one consolidated
            // assistant message with [text, tool_uses...] when the stream
            // ends.
            if (ev.type === GeminiEventType.ToolCallRequest) {
              const req = (ev as any).value as { callId: string; name: string; args: Record<string, unknown> };
              const toolUseId = `toolu_${randomUUID().slice(0, 12)}`;
              callIdToToolUseId.set(req.callId, toolUseId);
              turnToolUses.push({ type: "tool_use", id: toolUseId, name: req.name, input: req.args });
              continue;
            }
            // Track error events so we can emit resultErrorEvent at the end.
            if (ev.type === GeminiEventType.Error) {
              const v = (ev as any).value as { error?: unknown };
              if (v?.error) {
                if (v.error instanceof Error) {
                  streamError = v.error.message;
                } else if (typeof v.error === "object" && v.error !== null) {
                  const errObj = v.error as Record<string, unknown>;
                  if (typeof errObj.message === "string") {
                    streamError = errObj.message;
                  } else {
                    try {
                      streamError = JSON.stringify(v.error);
                    } catch {
                      streamError = "[Error object could not be serialized]";
                    }
                  }
                } else {
                  streamError = String(v.error);
                }
              } else {
                streamError = "Unknown error";
              }
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
            } as any;
          }

          // No pending tool calls → the agent finished this turn.
          const pending = turn?.pendingToolCalls ?? [];
          if (pending.length === 0) break;

          // Pre-execution canUseTool gate: ask cowork (deny/allow/park).
          // Calls that get denied are synthesized into denial tool_results
          // and never reach the scheduler. Calls that get allowed (with
          // possibly updated input) get passed through.
          const toSchedule: ToolCallRequestInfo[] = [];
          const synthesizedResults: any[] = [];
          for (const call of pending) {
            const c = call as ToolCallRequestInfo;
            const toolUseId = callIdToToolUseId.get(c.callId) ?? c.callId;
            const decision = await this.checkPermission(c.name, c.args, toolUseId);
            if (decision.behavior === "deny") {
              // The scheduler will never run this — synthesize a
              // tool_result for the model + the UI so the conversation
              // can continue. Keep the conversation valid: feed a
              // functionResponse back to the model on the next round so
              // its function_call has a matching response.
              const denyMsg = decision.message ?? "Tool call denied by user";
              synthesizedResults.push({
                callId: c.callId,
                responseText: denyMsg,
                isError: true,
              });
              yield {
                type: "user",
                session_id: this.sessionId,
                parent_tool_use_id: null,
                message: {
                  role: "user",
                  content: [{
                    type: "tool_result",
                    tool_use_id: toolUseId,
                    content: denyMsg,
                    is_error: true,
                  }],
                },
              } as any;
              continue;
            }
            // allow — possibly with modified input
            const args = (decision as any).updatedInput ?? c.args;
            toSchedule.push({ ...c, args });
          }

          // Execute the (possibly filtered) tool calls via the scheduler.
          const completed = toSchedule.length > 0
            ? await this.scheduler!.schedule(toSchedule, this.abort.signal)
            : [];

          // Surface tool_result events to the UI as Claude-shaped user
          // messages, mirroring what the Claude SDK does. Each call's
          // toolUseId was registered when we buffered the ToolCallRequest.
          for (const c of completed) {
            yield toolResultEventFromCompleted(c, callIdToToolUseId, this.sessionId);
          }

          // Build the next request from each completed call's responseParts.
          // cli-core expects the conversation to alternate functionCall
          // (already in chat history from the prior Turn) ↔ functionResponse.
          const nextRequest: any[] = [];
          for (const c of completed) {
            const parts = (c as { response?: { responseParts?: unknown[] } }).response?.responseParts ?? [];
            for (const p of parts) nextRequest.push(p);
          }
          // Append synthesized functionResponse Parts for denied calls so
          // the model's functionCall → functionResponse pairing stays valid.
          // Without these, Vertex rejects the next request with a
          // "function_call without matching function_response" error.
          for (const denied of synthesizedResults) {
            // Look up the original call's name from pending — we need it
            // for the functionResponse part. (Vertex's schema requires
            // name to match the originating functionCall.)
            const orig = pending.find(
              (p) => (p as ToolCallRequestInfo).callId === denied.callId,
            ) as ToolCallRequestInfo | undefined;
            nextRequest.push({
              functionResponse: {
                name: orig?.name ?? "unknown",
                response: { error: denied.responseText },
              },
            });
          }
          if (nextRequest.length === 0) break;
          request = nextRequest;
        }

        // Persist conversation history after the user's turn fully resolves
        // (all model rounds + tool executions for THIS user message). Saving
        // mid-loop would leave the file in an inconsistent state if the
        // server died between a tool call and its response.
        await this.saveHistory();

        // If the stream errored and we got no content, emit an error result.
        if (streamError && !accumulated) {
          yield resultErrorEvent(this.sessionId, streamError);
        } else {
          yield resultSuccessEvent(this.sessionId, accumulated);
        }
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

  close(): void {
    // No long-lived subprocess to kill — gemini-cli-core runs in-process.
    // Aborting drops any in-flight model call and tool execution, which is
    // the equivalent terminal cleanup for this runtime.
    this.abort.abort();
  }

  // Run the optional canUseTool hook with a synthesized options object
  // shaped like what the Claude SDK passes. Returns the cowork-supplied
  // PermissionResult, or auto-allow when no hook is set. The promise
  // returned by canUseTool may resolve synchronously (auto-allow/deny)
  // or asynchronously (parked awaiting user UI approval, e.g. plan-mode);
  // either way we just await it.
  private async checkPermission(
    toolName: string,
    args: Record<string, unknown>,
    toolUseId: string,
  ): Promise<AgentPermissionResult> {
    if (!this.canUseTool) {
      return { behavior: "allow", updatedInput: args };
    }
    try {
      // Claude SDK's options has more fields (sessionId, etc.); cowork's
      // buildCanUseTool only reads toolUseID, so a minimal object suffices.
      return await this.canUseTool(toolName, args, { toolUseID: toolUseId } as any);
    } catch (err) {
      console.warn("[gemini-runtime] canUseTool threw:", err);
      return { behavior: "allow", updatedInput: args };
    }
  }

  // Load Gemini chat history from disk. Returns undefined when there's no
  // runtimeStateDir, no history file (fresh session), or the file is
  // unparseable. Errors are intentionally swallowed: an unrecoverable
  // history file shouldn't block the session from starting — the agent
  // just begins fresh.
  private async loadHistory(): Promise<any[] | undefined> {
    if (!this.runtimeStateDir) return undefined;
    try {
      const raw = await fs.readFile(path.join(this.runtimeStateDir, "gemini-history.json"), "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  // Persist current Gemini chat history atomically (write to tmp + rename)
  // so a crash mid-write never leaves a half-written JSON.
  private async saveHistory(): Promise<void> {
    if (!this.runtimeStateDir || !this.chat) return;
    try {
      const history = this.chat.getHistory();
      const filePath = path.join(this.runtimeStateDir, "gemini-history.json");
      const tmpPath = filePath + ".tmp";
      await fs.writeFile(tmpPath, JSON.stringify(history, null, 2));
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      console.warn("[gemini-runtime] failed to persist history:", err);
    }
  }

  // Step: gemini-cli MCP integration wiring translated from Claude shapes to MCPServerConfig.
  async setMcpServers(servers: Record<string, AgentMcpServer>): Promise<AgentSetMcpServersResult> {
    const added: string[] = [];
    const removed: string[] = [];
    const errors: Record<string, string> = {};

    try {
      // gemini-cli-core doesn't export McpClientManager's type from its public
      // entrypoint; declare the slice of it we drive here.
      const mcpManager = this.config?.getMcpClientManager() as
        | {
            stop(): Promise<void>;
            allServerConfigs?: { clear(): void };
            startConfiguredMcpServers(): Promise<void>;
            getLastError?(name: string): string | undefined;
          }
        | undefined;
      if (!mcpManager) {
        throw new Error("McpClientManager not initialized");
      }

      // 1. Identify which servers are currently active vs new ones.
      const currentServers = this.config?.getMcpServers() || {};
      const currentKeys = Object.keys(currentServers);
      const newKeys = Object.keys(servers);

      for (const key of currentKeys) {
        if (!newKeys.includes(key)) {
          removed.push(key);
        }
      }
      for (const key of newKeys) {
        if (!currentKeys.includes(key)) {
          added.push(key);
        }
      }

      // 2. Stop all current clients so we have a clean slate.
      await mcpManager.stop();
      if (mcpManager.allServerConfigs) {
        mcpManager.allServerConfigs.clear();
      }

      // 3. Translate Claude-shaped servers into Gemini-shaped MCPServerConfig.
      const translated: Record<string, MCPServerConfig> = {};
      for (const [name, server] of Object.entries(servers)) {
        if (server.type === "stdio") {
          translated[name] = new MCPServerConfig(
            server.command,
            server.args,
            server.env,
          );
        } else if (server.type === "sse") {
          translated[name] = new MCPServerConfig(
            undefined, // command
            undefined, // args
            undefined, // env
            undefined, // cwd
            server.url, // url
            undefined, // httpUrl
            undefined, // headers
            undefined, // tcp
            "sse", // type
          );
        } else if (server.type === "http") {
          translated[name] = new MCPServerConfig(
            undefined, // command
            undefined, // args
            undefined, // env
            undefined, // cwd
            undefined, // url
            server.url, // httpUrl
            server.headers, // headers
            undefined, // tcp
            "http", // type
          );
        }
      }

      // 4. Update config and start configured servers
      this.config!.setMcpServers(translated);
      await mcpManager.startConfiguredMcpServers();

      // 5. Check if any server failed to start or connect
      for (const name of Object.keys(translated)) {
        const status = getMCPServerStatus(name);
        if (status === MCPServerStatus.DISCONNECTED) {
          const err = mcpManager.getLastError?.(name) || "Failed to connect to MCP server";
          errors[name] = err;
        }
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[gemini-runtime] setMcpServers failed:", msg);
      errors["global"] = msg;
    }

    return { added, removed, errors };
  }

  async mcpServerStatus(): Promise<AgentMcpServerStatus[]> {
    const servers = this.config?.getMcpServers() || {};
    const statuses: AgentMcpServerStatus[] = [];

    for (const name of Object.keys(servers)) {
      const status = getMCPServerStatus(name);
      // Map Gemini's MCPServerStatus to Claude's "connected" | "failed" | "needs-auth" | "pending" | "disabled"
      let mappedStatus: "connected" | "failed" | "needs-auth" | "pending" | "disabled" = "pending";
      if (status === MCPServerStatus.CONNECTED) {
        mappedStatus = "connected";
      } else if (status === MCPServerStatus.DISCONNECTED) {
        mappedStatus = "failed";
      } else if (status === MCPServerStatus.CONNECTING) {
        mappedStatus = "pending";
      } else if (status === MCPServerStatus.DISABLED) {
        mappedStatus = "disabled";
      }
      statuses.push({ name, status: mappedStatus });
    }

    return statuses;
  }

  // Gemini pins its own model (chosen at query() time); no mid-session switch.
  async setModel(): Promise<void> {}
  async supportedModels(): Promise<AgentModelInfo[]> { return []; }
  async setEffort(_effort: AgentEffortLevel | null): Promise<void> {}
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
      } as any];
    }
    case GeminiEventType.ToolCallRequest: {
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
      } as any];
    }
    case GeminiEventType.ToolCallResponse: {
      const resp = (ev as any).value as {
        callId: string;
        responseParts?: Array<{ text?: string; functionResponse?: { response?: unknown } }>;
        error?: Error;
      };
      const toolUseId = callIdToToolUseId.get(resp.callId) ?? `toolu_${randomUUID().slice(0, 12)}`;
      let text = resp.responseParts
        ?.map((p) => {
          if (typeof p.text === "string") return p.text;
          if (p.functionResponse?.response) return JSON.stringify(p.functionResponse.response);
          return "";
        })
        .filter(Boolean)
        .join("\n") ?? (resp.error ? String(resp.error.message ?? resp.error) : "");
      if (text.includes("permission_required")) {
        text += "\n\nTip: Claude in Chrome uses a per-domain permission model. If this domain is not yet approved, you will see this error. When using browser_batch, the batch is instantly aborted on failure. To request/surface the permission approval flow, try navigating directly via a standalone tool call (e.g. using the navigate tool directly on this tab). This will trigger the permission pop-up which you can then approve in Chrome.";
      }
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
      const v = (ev as any).value as { error?: unknown };
      let message = "Unknown error";
      if (v?.error) {
        if (v.error instanceof Error) {
          message = v.error.message;
        } else if (typeof v.error === "object" && v.error !== null) {
          // Try to extract message property, otherwise JSON stringify
          const errObj = v.error as Record<string, unknown>;
          if (typeof errObj.message === "string") {
            message = errObj.message;
          } else {
            try {
              message = JSON.stringify(v.error);
            } catch {
              message = "[Error object could not be serialized]";
            }
          }
        } else {
          message = String(v.error);
        }
      }
      return [{
        type: "system",
        subtype: "error",
        message,
        session_id: sessionId,
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
  const resp = (c as any).response as { responseParts?: Array<{ text?: string; functionResponse?: { response?: unknown } }>; error?: Error } | undefined;
  let text = resp?.responseParts
    ?.map((p) => {
      if (typeof p.text === "string") return p.text;
      if (p.functionResponse?.response) return JSON.stringify(p.functionResponse.response);
      return "";
    })
    .filter(Boolean)
    .join("\n") ?? (resp?.error ? String(resp.error.message ?? resp.error) : "");
  if (text.includes("permission_required")) {
    text += "\n\nTip: Claude in Chrome uses a per-domain permission model. If this domain is not yet approved, you will see this error. When using browser_batch, the batch is instantly aborted on failure. To request/surface the permission approval flow, try navigating directly via a standalone tool call (e.g. using the navigate tool directly on this tab). This will trigger the permission pop-up which you can then approve in Chrome.";
  }
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
