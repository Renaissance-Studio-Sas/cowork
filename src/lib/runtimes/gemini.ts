// GeminiRuntime — implements AgentRuntime on top of @google/gemini-cli-core's
// Config + GeminiChat. Replaces the earlier raw @google/genai adapter so
// Gemini sessions can grow into tool calling, MCP, and the agent loop
// without rewriting the runtime layer. See docs/gemini-runtime-parity.md
// for the staged plan.
//
// Step 1 (this file as it stands): plain text chat + streaming.
// Subsequent steps add:
//   - tool calling + MCP (via Config's ToolRegistry + McpClient)
//   - canUseTool / ExitPlanMode plumbing
//   - resume (persist + reload GeminiChat history)
//
// Auth: env vars read by @google/gemini-cli-core's getAuthTypeFromEnv():
//   GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_CLOUD_PROJECT + GOOGLE_CLOUD_LOCATION
// resolves to AuthType.USE_VERTEX_AI with ADC. gemini-3.5-flash requires
// GOOGLE_CLOUD_LOCATION=global (see .env.local) — regional endpoints 404
// for the 3.x family.

import { randomUUID } from "node:crypto";
import {
  Config,
  GeminiChat,
  AuthType,
  LlmRole,
  StreamEventType,
  type StreamEvent as CliStreamEvent,
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

  // Lazy: Config + GeminiChat bootstrap is async (refreshAuth → initialize)
  // so we set up on first iteration rather than in the constructor (which
  // is sync per AgentRuntime contract).
  private config: Config | null = null;
  private chat: GeminiChat | null = null;

  constructor(opts: AgentQueryOptions) {
    this.input = opts.prompt;
    // sessions.ts builds Claude-SDK-shaped options: { prompt, options: { cwd,
    // model, workbenchToolGroups, systemPrompt, … } }. Read from the nested
    // `options` first, fall back to top-level for direct AgentQueryOptions
    // callers. Without this read, the Gemini adapter was silently
    // ignoring tool registration AND the model override.
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
    if (this.chat) return;
    // Config is gemini-cli-core's central AgentLoopContext — it owns the
    // tool registry, MCP client manager, content generator, etc.
    this.config = new Config({
      sessionId: this.sessionId,
      clientName: "cowork",
      model: this.model,
      cwd: this.cwd,
      targetDir: this.cwd,
      debugMode: false,
      // Disable telemetry collection for cowork sessions — gemini-cli-core
      // has clearcut/usage stats hooks intended for the CLI; cowork isn't
      // the CLI and shouldn't ship anonymous usage to Google's pipelines.
      usageStatisticsEnabled: false,
    });
    // refreshAuth reads GOOGLE_GENAI_USE_VERTEXAI / GOOGLE_CLOUD_PROJECT
    // from env and wires the content generator for Vertex.
    await this.config.refreshAuth(AuthType.USE_VERTEX_AI);
    // initialize() builds the tool registry (empty by default), MCP client
    // manager, etc.
    await this.config.initialize();

    // Register cowork's workbench tools into gemini-cli-core's ToolRegistry
    // so the agent can call them (comments, planning, email, session). The
    // Claude-specific chrome_connect/disconnect tools are not in this set —
    // gemini-cli-core needs its own Chrome integration (out of scope).
    for (const group of this.workbenchToolGroups) {
      registerWorkbenchToolsInGemini(this.config, group.tools);
    }

    // GeminiChat takes its tool list at construction time — registering in
    // ToolRegistry alone doesn't propagate. The chat expects the Vertex
    // tools shape: `[{ functionDeclarations: [...] }]`, not raw Tool[].
    // Pull FunctionDeclarations from the registry, wrap, feed in.
    // (Matches what gemini-cli-core's own Client.startChat does.)
    const toolDeclarations = this.config.getToolRegistry().getFunctionDeclarations();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = [{ functionDeclarations: toolDeclarations }] as any[];
    this.chat = new GeminiChat(this.config, this.systemInstruction, tools, []);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    try {
      await this.bootstrap();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[gemini-runtime] bootstrap failed:`, errorMsg);
      yield {
        type: "system",
        subtype: "init",
        session_id: this.sessionId,
        cwd: this.cwd,
        model: this.model,
        tools: [],
        mcp_servers: [],
        slash_commands: [],
        permissionMode: "bypassPermissions",
        apiKeySource: "env",
      } as unknown as AgentEvent;
      yield {
        type: "result",
        subtype: "error",
        session_id: this.sessionId,
        is_error: true,
        error: `gemini-cli-core bootstrap failed: ${errorMsg}`,
        result: errorMsg,
      } as unknown as AgentEvent;
      return;
    }

    yield {
      type: "system",
      subtype: "init",
      session_id: this.sessionId,
      cwd: this.cwd,
      model: this.model,
      tools: [],
      mcp_servers: [],
      slash_commands: [],
      permissionMode: "bypassPermissions",
      apiKeySource: "env",
    } as unknown as AgentEvent;

    for await (const userMsg of this.input) {
      if (this.abort.signal.aborted) break;
      const text = extractUserText(userMsg);
      if (!text) continue;

      let accumulated = "";
      const turnUuid = randomUUID();
      const promptId = `prompt_${Date.now()}`;
      try {
        const stream = await this.chat!.sendMessageStream(
          { model: this.model, isChatModel: true },
          [{ text }],
          promptId,
          this.abort.signal,
          LlmRole.MAIN,
        );

        for await (const ev of stream as AsyncGenerator<CliStreamEvent>) {
          if (this.abort.signal.aborted) break;
          if (ev.type !== StreamEventType.CHUNK) continue;
          // ev.value is a @google/genai GenerateContentResponse — same
          // shape we already handle in the text-only adapter. Extract
          // text from the first candidate's parts.
          const resp = ev.value as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
          const parts = resp.candidates?.[0]?.content?.parts ?? [];
          for (const p of parts) {
            const t = p?.text;
            if (typeof t !== "string" || !t) continue;
            accumulated += t;
            yield {
              type: "stream_event",
              uuid: turnUuid,
              session_id: this.sessionId,
              parent_tool_use_id: null,
              event: {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: t },
              },
            } as unknown as AgentEvent;
          }
        }

        // Final assistant message with the full accumulated text.
        yield {
          type: "assistant",
          session_id: this.sessionId,
          parent_tool_use_id: null,
          message: {
            id: `msg_${Date.now()}`,
            role: "assistant",
            type: "message",
            model: this.model,
            content: [{ type: "text", text: accumulated }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {},
          },
        } as unknown as AgentEvent;

        yield {
          type: "result",
          subtype: "success",
          session_id: this.sessionId,
          is_error: false,
          duration_ms: 0,
          duration_api_ms: 0,
          num_turns: 1,
          result: accumulated,
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        } as unknown as AgentEvent;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[gemini-runtime] sendMessageStream failed:`, errorMsg);
        yield {
          type: "result",
          subtype: "error",
          session_id: this.sessionId,
          is_error: true,
          error: errorMsg,
          result: errorMsg,
        } as unknown as AgentEvent;
      }
    }
  }

  async interrupt(): Promise<void> {
    this.abort.abort();
  }

  // Step 4 will hook MCP wiring up through Config's mcpClientManager.
  // Step 1 ships as no-op so chrome_connect in a gemini-cli session
  // doesn't crash.
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
