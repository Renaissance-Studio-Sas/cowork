# Gemini runtime parity

Status: **proposed** — to be implemented as a follow-up.
Owner: TBD.
Sibling: [chrome-mcp-per-session.md](./chrome-mcp-per-session.md).

## The problem

Today's `GeminiRuntime` in `src/lib/runtimes/gemini.ts` is **text-only**. It
wraps `@google/genai`'s `generateContentStream` directly and stubs out
everything else. A Gemini session can hold a conversation that reads the
project/task system prompt but **cannot do work**:

- No tool calling (no `tools` passed to `generateContent`, no function-call
  response handling, no agent loop).
- `setMcpServers()` and `mcpServerStatus()` return empty no-ops. So
  `chrome_connect` from a Gemini session reports success but actually
  registers nothing — the agent is told the bridge is wired and then can't
  invoke any MCP tool.
- No `canUseTool` flow — no permission requests, no ExitPlanMode approval.
- No subagent / task delegation.
- No slash commands.
- Resume across server restart is partial — `sessionId` persists in
  `meta.json` but the in-memory `history: Content[]` doesn't reload.

This means the only useful Gemini session today is a chat with no
side effects. It proves the runtime abstraction works; it isn't a tool we'd
hand a real task to.

## Why gemini-cli-core, not hand-rolled

`@google/gemini-cli-core` ships the agent loop the `gemini` CLI uses: tool
registry, MCP client, function-calling, OAuth, sandboxing modes, the
whole rig. Re-implementing function-calling on raw `@google/genai` is
several weeks of work that ends in something we'd have to maintain against
Gemini's evolving function-call protocol. gemini-cli-core is Google-owned
and tracks the protocol — we should buy, not build.

Exports we'd lean on (sampled from `@google/gemini-cli-core`'s `dist/index.d.ts`):

- `Config` / `ConfigSchema` / `ConfigSource` — central config object
- `GeminiChat` — chat session with history + tool dispatch
- `Turn` — single agent turn (tool call → tool result → continuation)
- `ToolRegistry` + `ALL_BUILTIN_TOOL_NAMES` — built-in tools (file ops, shell, web)
- `McpClient`, `MCPServerConfig`, `MCPServerStatus`, `mcpServerRequiresOAuth`
- `CoreEvent` + `coreEvents` (event emitter) — what `Turn` emits as it runs
- `AgentSession`, `AgentTerminateMode`

The Claude SDK and gemini-cli-core have different shapes; that's the cost
of buying. The translation tax lives in `runtimes/gemini.ts` only.

## What needs to be built

### 1. New `GeminiRuntime` body (replaces today's runtimes/gemini.ts)

Sketch:

```ts
import { Config, GeminiChat, Turn, ToolRegistry, McpClient,
         coreEvents, type MCPServerConfig } from "@google/gemini-cli-core";

class GeminiAgentQuery implements AgentQuery {
  private chat: GeminiChat;
  private mcpClients: Map<string, McpClient>;
  // ...

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    // 1. yield system:init (sessionId, model, registered tool names, etc.)
    // 2. for each user message in this.input:
    //    a. start a Turn via this.chat.sendMessageStream(...)
    //    b. subscribe to coreEvents — translate each into an AgentEvent
    //       (stream_event for token deltas; assistant for final text;
    //       tool_use / tool_result for function calls; result for end-of-turn)
    //    c. await turn completion
  }

  async setMcpServers(servers: Record<string, AgentMcpServer>): Promise<...> {
    // Translate Claude-SDK-shaped McpServerConfig (stdio | sse | http | sdk)
    // into gemini-cli-core's MCPServerConfig shape (similar but not identical).
    // Connect via McpClient, register tools into ToolRegistry, return
    // { added, removed, errors }.
  }

  async mcpServerStatus() {
    // Read from this.mcpClients — return [{ name, status }].
  }

  async interrupt() {
    // gemini-cli-core's Turn has cancellation — use whatever AbortSignal it
    // accepts. Today we just flip an aborted flag and let the generator
    // observe it; replace with proper Turn cancellation.
  }
}
```

### 2. Translation layer at the event boundary

`coreEvents` / `CoreEvent` shape ≠ Claude SDK's `SDKMessage` shape. The
runtime layer translates:

| gemini-cli-core event | AgentEvent emitted |
|---|---|
| `Turn` content_block_delta (text token) | `stream_event` with `event.delta.type = "text_delta"` |
| `Turn` final text | `assistant` with `content: [{ type: "text", text: full }]` |
| `Turn` tool call | `assistant` with `content: [{ type: "tool_use", id, name, input }]` |
| Tool result | `user` with `content: [{ type: "tool_result", tool_use_id, content }]` |
| Turn end | `result` with `subtype: "success"` (or `"error"`) |

The UI already renders all these — no UI changes needed.

### 3. Tool registry seeding

When the runtime spawns, register cowork's static MCP servers
(workbench-comments, workbench-session, claude-in-chrome, planning) into
gemini-cli-core's `ToolRegistry` via the McpClient path. The Claude
equivalent today is the `mcpServers` field in query options.

### 4. Permission flow

Plug `canUseTool` (from `AgentQueryOptions`) into gemini-cli-core's
permission hook. gemini-cli-core has its own permission system (`ALLOWED_*`
priorities visible in the exports); the wiring goes here. ExitPlanMode-style
parking of a tool-use awaiting user approval must still work.

### 5. Resume

gemini-cli-core's `GeminiChat` has its own history representation; persist
it to disk (sibling format to Claude SDK's transcript .jsonl) and reload on
`resumeSession`. Cowork already manages `sdkSessionId` per session — extend
the relocation logic in `fs.ts` to handle the Gemini transcript path too.

## Out of scope (for this task)

- Switching to gemini-cli-core's own session resume protocol (we use our
  own session model).
- Sandboxing modes — gemini-cli-core supports running tools in containers /
  with restricted filesystems. Cowork doesn't sandbox at all today;
  carrying gemini-cli-core's sandbox over is a separate decision.
- OAuth-based Gemini auth (`LOGIN_WITH_GOOGLE`). Today we use ADC via
  Vertex; leave that.

## Files that will change

- `src/lib/runtimes/gemini.ts` — rewrite using gemini-cli-core
- `src/lib/runtimes/index.ts` — unchanged (the registry just imports
  the new geminiRuntime)
- `package.json` — `@google/gemini-cli-core` already installed; nothing
  to add unless its peer deps require it
- `src/lib/fs.ts` — extend `relocateSdkTranscripts` to handle Gemini's
  transcript file shape (if we adopt one)
- `src/lib/sessions.ts` — minor: the `canUseTool` callback that goes into
  `AgentQueryOptions` needs to be honored by GeminiAgentQuery; no change
  to its caller signature

## Risks / unknowns

- **gemini-cli-core's surface is large and evolves.** Its API isn't
  stable across releases the way `@google/genai` is. Pin the version,
  isolate the dependency to runtimes/gemini.ts, and write a thin facade
  so a major-version upgrade hits one file.
- **MCP server config shapes don't translate 1:1.** Claude SDK's
  `McpServerConfig` has 4 variants (stdio, sse, http, sdk). gemini-cli-core's
  `MCPServerConfig` will accept stdio/sse/http; the SDK-instance variant
  (used for in-process MCPs like `buildCommentsMcp()`) won't translate —
  we'd need to either expose those as stdio adapters or skip them in
  Gemini sessions.
- **Tool-use event shape differences.** Claude content parts include
  `type: "tool_use"` / `type: "tool_result"`; gemini-cli-core emits
  function calls and tool results differently. The translation table in
  §2 needs verification against gemini-cli-core's actual `CoreEvent` types.
- **Permission semantics.** Claude SDK's `PermissionResult` is
  `{ behavior: "allow" | "deny", ... }`; gemini-cli-core has priority
  tiers (`ALLOWED_TOOLS_FLAG_PRIORITY`, `ALWAYS_ALLOW_PRIORITY`, …).
  Mapping the two is small but easy to get subtly wrong.

## Acceptance criteria

- A Gemini session can call MCP tools — `chrome_connect` in a Gemini
  session actually registers the bridge, and `tabs_context_mcp` returns
  real tabs.
- A Gemini session can read project files via the cowork session-MCP
  filesystem tools (or gemini-cli-core's built-in file tools, whichever
  is wired).
- ExitPlanMode-style approval works (the session parks awaiting the
  user's Approve/Deny click, then continues).
- Resume after server restart picks up Gemini conversation history.
- Existing Claude sessions continue to work unchanged.
- Streaming (`stream_event`) still works.

## Suggested implementation order

1. Stand up a parallel `GeminiCliRuntime` (don't replace the existing one
   yet) so the two can be A/B'd. Register it as a third runtime id
   (`gemini-cli`) in `runtimes/index.ts`.
2. Wire text-only chat through it — prove the gemini-cli-core glue
   works without any tools.
3. Add streaming (translate `coreEvents` deltas → `stream_event`).
4. Add MCP server registration (start with one static server like
   workbench-comments).
5. Add `canUseTool` plumbing.
6. Add resume.
7. Swap `runtimes/index.ts` so `"gemini"` points to the new runtime;
   delete the old text-only impl.
