// RemoteRuntime — runs the agent in a container provisioned by a separate
// session-controller daemon (cloud-agent-runner). The container exposes an
// HTTP/SSE API that wraps the same Claude Agent SDK cowork uses locally, so
// AgentEvents pass through verbatim. This file is mostly transport: provision
// container, POST options, forward /input, yield /stream.
//
// Env (read at module load):
//   AGENT_CONTROLLER_URL    e.g. http://127.0.0.1:8090   (default)
//   AGENT_CONTROLLER_TOKEN  bearer token if controller has one (optional)
//   AGENT_REMOTE_USER       identifier passed to the controller, used to pick
//                            the runner-home for OAuth + history. Default: $USER
//   WORKSPACE_ROOT          host workspace; used to rewrite cwd into the
//                            container view (/workspace).
//
// Workbench-tool proxying:
//   - cowork serializes every workbench tool (comments, AskUserQuestion,
//     session-management, planning) to JSON Schema and passes them to the
//     runner at session start. The runner registers a proxy MCP server that
//     emits a `workbench_tool_call` SSE event with a correlation id when the
//     SDK invokes a tool. This file intercepts those events (they don't
//     reach the chat UI), runs the local handler on cowork's side, and POSTs
//     the result back to /sessions/{id}/tool-result. Multiple in-flight
//     calls run concurrently — handlers are dispatched fire-and-forget and
//     resolutions race correctly because each is keyed by id.
//
// MVP caveats:
//   - canUseTool is NOT forwarded — the runner auto-allows every tool
//     (bypassPermissions). ExitPlanMode and other permission flows therefore
//     don't gate in remote mode.
//   - MCP setMcpServers / mcpServerStatus are no-ops in remote mode (no
//     chrome-bridge dynamic MCP).
//   - cwd is remapped from the laptop workspace path into /workspace inside
//     the container. Paths outside the workspace collapse to /workspace.

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

const CONTROLLER_URL = process.env.AGENT_CONTROLLER_URL ?? "http://127.0.0.1:8090";
const CONTROLLER_TOKEN = process.env.AGENT_CONTROLLER_TOKEN ?? "";
const REMOTE_USER = process.env.AGENT_REMOTE_USER ?? process.env.USER ?? "default";
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "";

interface ControllerSession {
  session_id: string;
  runner_url: string;
  runner_token: string;
  container_id: string;
}

// Provision a container via the controller. The controller blocks until the
// runner's /health is green before returning.
async function provisionContainer(opts: {
  project: string | null;
  task: string | null;
}): Promise<ControllerSession> {
  const r = await fetch(`${CONTROLLER_URL}/v1/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(CONTROLLER_TOKEN ? { authorization: `Bearer ${CONTROLLER_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      user: REMOTE_USER,
      cli: "claude",
      project: opts.project,
      task: opts.task,
    }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`controller POST /v1/sessions failed (${r.status}): ${text}`);
  }
  return r.json() as Promise<ControllerSession>;
}

async function destroyControllerSession(sessionId: string): Promise<void> {
  try {
    await fetch(`${CONTROLLER_URL}/v1/sessions/${sessionId}`, {
      method: "DELETE",
      headers: CONTROLLER_TOKEN ? { authorization: `Bearer ${CONTROLLER_TOKEN}` } : {},
    });
  } catch {
    /* best effort — controller GC catches orphans */
  }
}

// Strip non-serializable fields from cowork's options blob. Function refs
// (canUseTool, mcpServers with handlers, workbenchToolGroups) live host-side;
// canUseTool and runtime-bound MCP servers stay host-only. Workbench tools
// get their own serialized channel (see serializeWorkbenchTools below).
function serializeOptions(opts: AgentQueryOptions): Record<string, unknown> {
  const o = (opts.options ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...o };
  delete out.canUseTool;
  delete out.mcpServers;
  delete out.workbenchToolGroups;
  delete out.toolAliases;
  delete out.runtimeStateDir;
  const cwd = typeof opts.cwd === "string" ? opts.cwd : (out.cwd as string | undefined);
  out.cwd = remapPath(cwd);
  for (const k of ["model", "effort", "systemPrompt", "permissionMode", "settingSources"]) {
    if (k in opts && !(k in out)) out[k] = (opts as Record<string, unknown>)[k];
  }
  return out;
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
  // Keyed by "server/tool" so dispatchWorkbenchCall can look up the handler
  // when the runner reports a call.
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
// runner. Called fire-and-forget so concurrent calls don't serialize on each
// other — multiple in-flight handlers race freely and the runner resolves
// each pending entry by id.
async function dispatchWorkbenchCall(
  controller: ControllerSession,
  sessionId: string,
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
    await fetch(`${controller.runner_url}/sessions/${sessionId}/tool-result`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${controller.runner_token}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // The runner closed before we could deliver — likely the session ended
    // while a handler was in flight. Drop quietly; the SDK on the runner
    // side will see the tool call timeout or the parent process exit.
    console.warn(`[remote] tool-result POST failed for ${key}: ${(e as Error).message}`);
  }
}

function remapPath(p: string | undefined): string {
  if (!p) return "/workspace";
  if (WORKSPACE_ROOT && p.startsWith(WORKSPACE_ROOT)) {
    return "/workspace" + p.slice(WORKSPACE_ROOT.length);
  }
  return "/workspace";
}

// Parse SSE frames separated by \n\n. Yields { event, data } for each frame.
// The runner uses `event: done` for stream end and `event: error` for terminal
// errors; data-only frames have event = "message".
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
    try { chunk = await reader.read(); }
    catch (e) {
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

class RemoteAgentQuery implements AgentQuery {
  private readonly opts: AgentQueryOptions;
  private readonly abort = new AbortController();
  private bootPromise: Promise<{
    controller: ControllerSession;
    sessionId: string;
  }> | null = null;
  private inputDrainPromise: Promise<void> | null = null;
  private interrupted = false;
  // Local workbench tool handlers, keyed by "server/tool". Populated at boot
  // from opts.options.workbenchToolGroups; consulted whenever the runner
  // emits a workbench_tool_call event over SSE.
  private workbenchHandlers: Map<string, (args: unknown) => Promise<ToolCallResult>> = new Map();

  constructor(opts: AgentQueryOptions) { this.opts = opts; }

  private extractCreateParams(): { project: string | null; task: string | null } {
    const remote = (this.opts as unknown as { remote?: { project?: string; task?: string } }).remote;
    return {
      project: remote?.project ?? null,
      task: remote?.task ?? null,
    };
  }

  // Provision container, then POST /sessions on the runner with the
  // serialized options and (if available) the first user message so the SDK
  // starts its query immediately.
  private async boot(): Promise<{ controller: ControllerSession; sessionId: string }> {
    if (this.bootPromise) return this.bootPromise;
    this.bootPromise = (async () => {
      const controller = await provisionContainer(this.extractCreateParams());

      // Pull the first user message off the prompt iterable if one is queued.
      // cowork's startSession pushes the first message onto the InputChannel
      // before calling query(), so iter.next() resolves synchronously the
      // first time. We race with a 10ms timeout in case the channel is empty.
      let firstMessage: unknown = undefined;
      const iter = this.opts.prompt[Symbol.asyncIterator]();
      const next = await Promise.race([
        iter.next(),
        new Promise<IteratorResult<unknown>>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 10),
        ),
      ]);
      if (!next.done) firstMessage = next.value;

      const sessionId = controller.session_id;
      // Serialize workbench tools (if any) so the runner can register a proxy
      // MCP server. Hold onto the local handler map for SSE dispatch.
      const wb = serializeWorkbenchTools(this.opts);
      if (wb) this.workbenchHandlers = wb.handlers;
      const r = await fetch(`${controller.runner_url}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${controller.runner_token}`,
        },
        body: JSON.stringify({
          session_id: sessionId,
          options: serializeOptions(this.opts),
          message: firstMessage,
          workbenchTools: wb?.specs ?? [],
        }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        await destroyControllerSession(controller.session_id);
        throw new Error(`runner POST /sessions failed (${r.status}): ${text}`);
      }

      // Forward all subsequent user messages from opts.prompt to /input.
      this.inputDrainPromise = this.drainInput(controller, sessionId, iter);
      return { controller, sessionId };
    })();
    return this.bootPromise;
  }

  private async drainInput(
    controller: ControllerSession,
    sessionId: string,
    iter: AsyncIterator<unknown>,
  ): Promise<void> {
    try {
      while (!this.interrupted) {
        const next = await iter.next();
        if (next.done) break;
        try {
          await fetch(`${controller.runner_url}/sessions/${sessionId}/input`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${controller.runner_token}`,
            },
            body: JSON.stringify({ message: next.value }),
            signal: this.abort.signal,
          });
        } catch (e) {
          if (this.abort.signal.aborted) return;
          console.warn("[remote] input POST failed:", (e as Error).message);
        }
      }
    } catch (e) {
      if (!this.interrupted) {
        console.warn("[remote] input drain ended:", (e as Error).message);
      }
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    const { controller, sessionId } = await this.boot();
    const res = await fetch(`${controller.runner_url}/sessions/${sessionId}/stream`, {
      headers: {
        authorization: `Bearer ${controller.runner_token}`,
        accept: "text/event-stream",
      },
      signal: this.abort.signal,
    });
    if (!res.ok) {
      await destroyControllerSession(controller.session_id);
      throw new Error(`runner SSE returned ${res.status}`);
    }
    try {
      for await (const frame of readSse(res, this.abort.signal)) {
        if (frame.event === "done") return;
        if (frame.event === "error") {
          try { yield JSON.parse(frame.data) as AgentEvent; }
          catch {
            yield { type: "system", subtype: "error", message: frame.data } as unknown as AgentEvent;
          }
          continue;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(frame.data); }
        catch {
          yield {
            type: "system",
            subtype: "error",
            message: `malformed SSE frame: ${frame.data.slice(0, 200)}`,
          } as unknown as AgentEvent;
          continue;
        }
        // Workbench tool call → run the local handler and POST the result
        // back. Fire-and-forget so multiple parallel calls don't block the
        // SSE consumer or each other.
        if (isWorkbenchToolCall(parsed)) {
          void dispatchWorkbenchCall(controller, sessionId, parsed, this.workbenchHandlers);
          continue;
        }
        yield parsed as AgentEvent;
      }
    } finally {
      this.abort.abort();
      await destroyControllerSession(controller.session_id);
    }
  }

  // Forward an arbitrary POST to the underlying runner. Used by cowork's API
  // routes (/api/sessions/[id]/auth-code, etc.) to talk to endpoints that
  // weren't part of the AgentRuntime interface. Returns the runner's status
  // code + parsed body so the route can mirror it back to the browser.
  async relayToRunner(
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    if (!this.bootPromise) {
      throw new Error("remote runner has not been provisioned yet");
    }
    const { controller, sessionId } = await this.bootPromise;
    const r = await fetch(`${controller.runner_url}/sessions/${sessionId}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${controller.runner_token}`,
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
    return { status: r.status, body: parsed };
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    if (!this.bootPromise) {
      this.abort.abort();
      return;
    }
    try {
      const { controller, sessionId } = await this.bootPromise;
      await fetch(`${controller.runner_url}/sessions/${sessionId}/interrupt`, {
        method: "POST",
        headers: { authorization: `Bearer ${controller.runner_token}` },
      });
    } catch {
      /* best effort */
    }
    this.abort.abort();
  }

  close(): void {
    // Synchronously stop iterating runner SSE and drop any in-flight POSTs.
    // The remote runner container keeps running on its own — cowork doesn't
    // own its lifecycle here — so close() is just local cleanup.
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

export const remoteRuntime: AgentRuntime = {
  id: "remote",
  displayName: "Remote (Docker)",
  query(opts: AgentQueryOptions): AgentQuery {
    return new RemoteAgentQuery(opts);
  },
};
