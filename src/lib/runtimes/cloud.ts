// CloudRuntime — runs the agent in a Cloudflare Container, fronted by the
// cloud-agent worker at `<gateway>/api/agent/*`. Same `@anthropic-ai/claude-
// agent-sdk` runner image as the local Docker MVP, so AgentEvents stream
// through verbatim.
//
// Auth: reads the user's `__gateway_session` cookie from `~/.rw/credentials.json`
// at module load (same file `rw fetch` uses). No env var needed — `rw auth login`
// is the only setup step. If the cookie file is missing the runtime errors at
// boot rather than at request-time so the failure surfaces clearly in the UI.
//
// MVP caveats (matches design.html "Open items"):
//   - Workspace is empty inside the container apart from a default `CLAUDE.md`
//     baked into the image. No project/task context, no file sync — `cwd` is
//     ignored.
//   - canUseTool is NOT forwarded; the runner uses `bypassPermissions`.
//
// Workbench-tool proxying mirrors remote.ts (the local Docker runtime):
//   - cowork serializes every workbench tool (comments, AskUserQuestion,
//     session-management, planning) to JSON Schema and passes them to the
//     runner at session start. The runner registers a proxy MCP server that
//     emits a `workbench_tool_call` SSE event with a correlation id when the
//     SDK invokes a tool. This file intercepts those events (they don't
//     reach the chat UI), runs the local handler on cowork's side, and POSTs
//     the result back to /sessions/{id}/tool-result via the gateway. Multiple
//     in-flight calls run concurrently — handlers are dispatched
//     fire-and-forget and resolutions race correctly because each is keyed
//     by id.
//   - Resume after a 5-min idle hibernate is NOT yet supported — the container
//     dies and the SDK transcript with it.
//
// Env (read at module load, both optional):
//   RW_GATEWAY_URL        override gateway base (default: production gateway
//                         from credentials.json)
//   RW_CREDENTIALS_PATH   override credentials.json path (default: ~/.rw/
//                         credentials.json)

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type {
  AgentRuntime,
  AgentQuery,
  AgentQueryOptions,
  AgentEvent,
  AgentMcpServer,
  AgentSetMcpServersResult,
  AgentMcpServerStatus,
} from "../agent-runtime";
import type { WorkbenchTool, ToolCallResult } from "../workbench-tools/types";

interface RwCredentialsEnv {
  gateway: string;
  cookie: string;
  email: string;
}

interface RwCredentialsFile {
  envs?: Record<string, RwCredentialsEnv | undefined>;
}

function loadRwCredentials(): { gateway: string; cookie: string } {
  const path = process.env.RW_CREDENTIALS_PATH ?? join(homedir(), ".rw", "credentials.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(
      `cloud runtime: couldn't read ${path} — run \`rw auth login\` first. ${(e as Error).message}`,
    );
  }
  let parsed: RwCredentialsFile;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`cloud runtime: ${path} is not valid JSON: ${(e as Error).message}`);
  }
  const prod = parsed.envs?.production;
  if (!prod?.gateway || !prod?.cookie) {
    throw new Error(`cloud runtime: ${path} has no production env — run \`rw auth login\``);
  }
  const gateway = process.env.RW_GATEWAY_URL ?? prod.gateway;
  return { gateway: gateway.replace(/\/$/, ""), cookie: prod.cookie };
}

// Cached at module init. The cookie has a 7-day Max-Age; if it expires the
// gateway returns 401 and the user re-runs `rw auth login`. We don't poll
// for refresh — `rw fetch` doesn't either, and that's the established UX.
let CREDENTIALS: { gateway: string; cookie: string } | null = null;
function getCredentials(): { gateway: string; cookie: string } {
  if (CREDENTIALS) return CREDENTIALS;
  CREDENTIALS = loadRwCredentials();
  return CREDENTIALS;
}

function authHeader(): string {
  // The cookie field stores ONLY the value of __gateway_session — wrap it in
  // the cookie header format the worker expects.
  return `__gateway_session=${getCredentials().cookie}`;
}

// Strip non-serializable fields from cowork's options blob. Same shape as
// remote.ts but we also drop `cwd` since the cloud workspace doesn't map
// to anything on the laptop.
function serializeOptions(opts: AgentQueryOptions): Record<string, unknown> {
  const o = (opts.options ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...o };
  delete out.canUseTool;
  delete out.mcpServers;
  delete out.workbenchToolGroups;
  delete out.toolAliases;
  delete out.runtimeStateDir;
  delete out.cwd;
  for (const k of ["model", "effort", "systemPrompt", "permissionMode", "settingSources"]) {
    if (k in opts && !(k in out)) out[k] = (opts as Record<string, unknown>)[k];
  }
  return out;
}

// Parse SSE frames separated by \n\n. Yields { event, data } for each frame.
// The runner uses `event: done` for stream end and `event: error` for terminal
// errors; data-only frames have event = "message". Lines starting with `:`
// are SSE comments (heartbeats) and are skipped.
async function* readSse(
  res: Response,
  abort: AbortSignal,
): AsyncGenerator<{ event: string; data: string }> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (e) {
      if (abort.aborted) return;
      throw e;
    }
    if (chunk.done) return;
    buffer += decoder.decode(chunk.value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let evType = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) evType = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length) yield { event: evType, data: dataLines.join("\n") };
    }
  }
}

interface CloudSession {
  sessionId: string;
  gateway: string;
}

// One workbench tool descriptor as it travels over the wire to the runner.
// The runner uses zod v4's fromJSONSchema to reconstruct the field-level
// types it needs to register a proxy with the Claude SDK's tool() helper.
interface WorkbenchToolSpec {
  server: string;
  name: string;
  description: string;
  inputSchema: unknown;
  alwaysLoad?: boolean;
}

// Build the WorkbenchToolSpec[] payload from cowork's workbenchToolGroups.
// Returns null if there are no groups so the runner can skip the proxy MCP
// server entirely.
function serializeWorkbenchTools(opts: AgentQueryOptions): {
  specs: WorkbenchToolSpec[];
  handlers: Map<string, (args: unknown) => Promise<ToolCallResult>>;
} | null {
  const groups = (opts as unknown as {
    options?: { workbenchToolGroups?: Array<{ name: string; tools: WorkbenchTool[] }> };
  }).options?.workbenchToolGroups;
  if (!groups?.length) return null;

  const specs: WorkbenchToolSpec[] = [];
  const handlers = new Map<string, (args: unknown) => Promise<ToolCallResult>>();
  for (const group of groups) {
    for (const t of group.tools) {
      const objectSchema = z.object(t.schema);
      const inputSchema = z.toJSONSchema(objectSchema, { target: "draft-7" });
      specs.push({
        server: group.name,
        name: t.name,
        description: t.description,
        inputSchema,
        alwaysLoad: t.alwaysLoad,
      });
      handlers.set(`${group.name}/${t.name}`, t.handler);
    }
  }
  return { specs, handlers };
}

interface WorkbenchToolCallEvent {
  type: "workbench_tool_call";
  id: string;
  server: string;
  tool: string;
  arguments: unknown;
}

function isWorkbenchToolCall(ev: unknown): ev is WorkbenchToolCallEvent {
  return (
    !!ev
    && typeof ev === "object"
    && (ev as { type?: string }).type === "workbench_tool_call"
    && typeof (ev as WorkbenchToolCallEvent).id === "string"
  );
}

// Dispatch one workbench tool call locally and POST the result back to the
// runner (via the gateway). Called fire-and-forget so concurrent calls don't
// serialize on each other — multiple in-flight handlers race freely and the
// runner resolves each pending entry by id.
async function dispatchWorkbenchCall(
  session: CloudSession,
  ev: WorkbenchToolCallEvent,
  handlers: Map<string, (args: unknown) => Promise<ToolCallResult>>,
): Promise<void> {
  const key = `${ev.server}/${ev.tool}`;
  const handler = handlers.get(key);
  let payload: { id: string; result?: ToolCallResult; error?: string };
  if (!handler) {
    payload = { id: ev.id, error: `unknown workbench tool: ${key}` };
  } else {
    try {
      const result = await handler(ev.arguments);
      payload = { id: ev.id, result };
    } catch (err) {
      payload = { id: ev.id, error: err instanceof Error ? err.message : String(err) };
    }
  }
  try {
    await fetch(
      `${session.gateway}/api/agent/sessions/${session.sessionId}/tool-result`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: authHeader(),
        },
        body: JSON.stringify(payload),
      },
    );
  } catch (e) {
    // The runner closed before we could deliver — likely the session ended
    // while a handler was in flight. Drop quietly; the SDK on the runner
    // side will see the tool call timeout or the parent process exit.
    console.warn(`[cloud] tool-result POST failed for ${key}: ${(e as Error).message}`);
  }
}

async function destroyCloudSession(s: CloudSession): Promise<void> {
  try {
    await fetch(`${s.gateway}/api/agent/sessions/${s.sessionId}`, {
      method: "DELETE",
      headers: { cookie: authHeader() },
    });
  } catch {
    /* best effort — DO's 5min idle reaper catches orphans */
  }
}

class CloudAgentQuery implements AgentQuery {
  private readonly opts: AgentQueryOptions;
  private readonly abort = new AbortController();
  private bootPromise: Promise<CloudSession> | null = null;
  private inputDrainPromise: Promise<void> | null = null;
  private interrupted = false;
  // Local workbench tool handlers, keyed by "server/tool". Populated at boot
  // from opts.options.workbenchToolGroups; consulted whenever the runner
  // emits a workbench_tool_call event over SSE.
  private workbenchHandlers: Map<string, (args: unknown) => Promise<ToolCallResult>> = new Map();

  constructor(opts: AgentQueryOptions) {
    this.opts = opts;
  }

  // POST /api/agent/sessions creates the DO + container AND starts the SDK
  // query in one step (cloud-agent doesn't have a separate "provision" step
  // like the local controller). We send the first user message in the same
  // POST so the SDK isn't sitting idle for a follow-up /input.
  private async boot(): Promise<CloudSession> {
    if (this.bootPromise) return this.bootPromise;
    this.bootPromise = (async () => {
      const { gateway } = getCredentials();

      // Pull the first user message off the prompt iterable if one is queued.
      // cowork's startSession pushes the first message onto the InputChannel
      // before calling query(), so iter.next() resolves synchronously the
      // first time. Race with a 10ms timeout in case the channel is empty.
      let firstMessage: unknown = undefined;
      const iter = this.opts.prompt[Symbol.asyncIterator]();
      const next = await Promise.race([
        iter.next(),
        new Promise<IteratorResult<unknown>>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 10),
        ),
      ]);
      if (!next.done) firstMessage = next.value;

      // Serialize workbench tools (if any) so the runner can register a proxy
      // MCP server. Hold onto the local handler map for SSE dispatch.
      const wb = serializeWorkbenchTools(this.opts);
      if (wb) this.workbenchHandlers = wb.handlers;

      const r = await fetch(`${gateway}/api/agent/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: authHeader(),
        },
        body: JSON.stringify({
          label: "cowork",
          options: serializeOptions(this.opts),
          message: firstMessage,
          workbenchTools: wb?.specs ?? [],
        }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`cloud-agent POST /sessions failed (${r.status}): ${text}`);
      }
      const body = (await r.json()) as { sessionId: string };
      const session: CloudSession = { sessionId: body.sessionId, gateway };

      // Forward subsequent user messages from opts.prompt to /input.
      this.inputDrainPromise = this.drainInput(session, iter);
      return session;
    })();
    return this.bootPromise;
  }

  private async drainInput(session: CloudSession, iter: AsyncIterator<unknown>): Promise<void> {
    try {
      while (!this.interrupted) {
        const next = await iter.next();
        if (next.done) break;
        try {
          await fetch(`${session.gateway}/api/agent/sessions/${session.sessionId}/input`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: authHeader(),
            },
            body: JSON.stringify({ message: next.value }),
            signal: this.abort.signal,
          });
        } catch (e) {
          if (this.abort.signal.aborted) return;
          console.warn("[cloud] input POST failed:", (e as Error).message);
        }
      }
    } catch (e) {
      if (!this.interrupted) {
        console.warn("[cloud] input drain ended:", (e as Error).message);
      }
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    const session = await this.boot();
    const res = await fetch(
      `${session.gateway}/api/agent/sessions/${session.sessionId}/stream`,
      {
        headers: {
          cookie: authHeader(),
          accept: "text/event-stream",
        },
        signal: this.abort.signal,
      },
    );
    if (!res.ok) {
      await destroyCloudSession(session);
      throw new Error(`cloud-agent SSE returned ${res.status}`);
    }
    try {
      for await (const frame of readSse(res, this.abort.signal)) {
        if (frame.event === "done") return;
        if (frame.event === "error") {
          try {
            yield JSON.parse(frame.data) as AgentEvent;
          } catch {
            yield {
              type: "system",
              subtype: "error",
              message: frame.data,
            } as unknown as AgentEvent;
          }
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(frame.data);
        } catch {
          yield {
            type: "system",
            subtype: "error",
            message: `malformed SSE frame: ${frame.data.slice(0, 200)}`,
          } as unknown as AgentEvent;
          continue;
        }
        // Workbench tool call → run the local handler and POST the result
        // back via the gateway. Fire-and-forget so multiple parallel calls
        // don't block the SSE consumer or each other.
        if (isWorkbenchToolCall(parsed)) {
          void dispatchWorkbenchCall(session, parsed, this.workbenchHandlers);
          continue;
        }
        yield parsed as AgentEvent;
      }
    } finally {
      this.abort.abort();
      await destroyCloudSession(session);
    }
  }

  // Forward an arbitrary POST to the underlying runner. Used by cowork's API
  // routes (/api/sessions/[id]/auth-code etc.) to talk to endpoints that
  // aren't part of the AgentRuntime interface — currently auth-code, but
  // also tool-result if/when workbench tools are wired up. The gateway's
  // worker routes /api/agent/sessions/:id/<path> straight through the DO to
  // the in-container runner, so we just append the path.
  async relayToRunner(
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    if (!this.bootPromise) {
      throw new Error("cloud runner has not been provisioned yet");
    }
    const session = await this.bootPromise;
    const r = await fetch(
      `${session.gateway}/api/agent/sessions/${session.sessionId}${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: authHeader(),
        },
        body: JSON.stringify(body),
      },
    );
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw text */
    }
    return { status: r.status, body: parsed };
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    if (!this.bootPromise) {
      this.abort.abort();
      return;
    }
    try {
      const session = await this.bootPromise;
      await fetch(
        `${session.gateway}/api/agent/sessions/${session.sessionId}/interrupt`,
        {
          method: "POST",
          headers: { cookie: authHeader() },
        },
      );
    } catch {
      /* best effort */
    }
    this.abort.abort();
  }

  close(): void {
    // The DO + container live on Cloudflare and self-destruct on 5min idle —
    // cowork doesn't own that lifecycle. close() is local cleanup only.
    this.interrupted = true;
    this.abort.abort();
  }

  async setMcpServers(_servers: Record<string, AgentMcpServer>): Promise<AgentSetMcpServersResult> {
    return {} as AgentSetMcpServersResult;
  }

  async mcpServerStatus(): Promise<AgentMcpServerStatus[]> {
    return [];
  }
}

export const cloudRuntime: AgentRuntime = {
  id: "cloud",
  displayName: "Claude (Cloud)",
  query(opts: AgentQueryOptions): AgentQuery {
    return new CloudAgentQuery(opts);
  },
};
