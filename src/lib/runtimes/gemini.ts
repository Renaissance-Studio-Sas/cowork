// GeminiRuntime — implements AgentRuntime on top of @google/genai's
// generateContentStream. Text-only v0: no tool calling, no MCP servers.
// Tool-capable Gemini sessions (probably via gemini-cli-core's Core class
// or hand-rolled function-calling) are a follow-up.
//
// Auth: env vars read by @google/genai.
//   GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_CLOUD_PROJECT + GOOGLE_CLOUD_LOCATION
//   ...or GEMINI_API_KEY for the AI Studio path. See .env.local.

import { GoogleGenAI, type Content } from "@google/genai";
import { randomUUID } from "node:crypto";
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

// Default model — gemini-3.5-flash. Requires GOOGLE_CLOUD_LOCATION=global
// (see .env.local); the regional aiplatform endpoints (us-central1 etc.)
// don't carry the gemini-3.x family yet and 404. Overridable per session
// via the `model` field threaded through StartSessionParams.
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

class GeminiAgentQuery implements AgentQuery {
  private readonly ai: GoogleGenAI;
  private readonly model: string;
  private readonly input: AsyncIterable<AgentUserMessage>;
  private readonly cwd: string;
  private readonly sessionId: string;
  private readonly systemInstruction: string | undefined;
  private readonly history: Content[] = [];
  private aborted = false;

  constructor(opts: AgentQueryOptions) {
    // Empty constructor → defaults to AI Studio API key. Vertex auth is
    // auto-detected from GOOGLE_GENAI_USE_VERTEXAI + GOOGLE_CLOUD_PROJECT
    // + ADC (or GOOGLE_APPLICATION_CREDENTIALS).
    this.ai = new GoogleGenAI({});
    this.model = opts.model || DEFAULT_GEMINI_MODEL;
    this.input = opts.prompt;
    this.cwd = opts.cwd || process.cwd();
    this.sessionId = `gemini-${randomUUID().slice(0, 8)}`;

    if (typeof opts.systemPrompt === "object" && opts.systemPrompt) {
      // Claude SDK's preset shape: { type: "preset", preset: "claude_code", append: string }
      // We honor only the `append` text — "preset" doesn't translate to Gemini.
      this.systemInstruction = opts.systemPrompt.append;
    } else if (typeof opts.systemPrompt === "string") {
      this.systemInstruction = opts.systemPrompt;
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    // Init event so pumpEvents picks up sessionId + model. Same shape Claude
    // SDK emits at session start.
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
      if (this.aborted) break;

      const text = extractUserText(userMsg);
      if (!text) continue;

      this.history.push({ role: "user", parts: [{ text }] });

      let accumulated = "";
      const turnUuid = randomUUID();
      const messageId = `msg_${Date.now()}`;
      try {
        const stream = await this.ai.models.generateContentStream({
          model: this.model,
          contents: this.history,
          ...(this.systemInstruction
            ? { config: { systemInstruction: this.systemInstruction } }
            : {}),
        });

        for await (const chunk of stream) {
          if (this.aborted) break;
          const t = chunk.text;
          if (!t) continue;
          accumulated += t;
          // Emit a stream_event delta per chunk in the Claude SDK's
          // SDKPartialAssistantMessage shape so the UI's streaming code
          // doesn't need a runtime-specific branch. The chat renderer
          // accumulates `event.delta.text` into an in-progress bubble.
          // pumpEvents skips stream_event for persistence — only the final
          // assistant message below is logged.
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

        // Final assistant message — replaces the in-progress bubble in the
        // UI and is the record persisted to events.jsonl / pushed to history.
        yield {
          type: "assistant",
          session_id: this.sessionId,
          parent_tool_use_id: null,
          message: {
            id: messageId,
            role: "assistant",
            type: "message",
            model: this.model,
            content: [{ type: "text", text: accumulated }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {},
          },
        } as unknown as AgentEvent;

        this.history.push({ role: "model", parts: [{ text: accumulated }] });

        yield {
          type: "result",
          subtype: "success",
          session_id: this.sessionId,
          is_error: false,
          duration_ms: 0,
          duration_api_ms: 0,
          num_turns: Math.ceil(this.history.length / 2),
          result: accumulated,
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        } as unknown as AgentEvent;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[gemini-runtime] generateContentStream failed:`, errorMsg);
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
    this.aborted = true;
  }

  // No MCP support in v0. Gemini sessions silently no-op when MCP servers
  // are pushed (chrome_connect etc.) so callers don't crash.
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
