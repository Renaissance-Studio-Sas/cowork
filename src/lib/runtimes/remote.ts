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
// MVP caveats:
//   - workbench tools (comments, AskUserQuestion, completion-suggest) and
//     canUseTool approvals are NOT forwarded. Remote agents run in
//     bypassPermissions without those tools. Sessions that need them
//     should use runtime: "claude".
//   - MCP setMcpServers / mcpServerStatus are no-ops in remote mode.
//   - cwd is remapped from the laptop workspace path into /workspace inside
//     the container. Paths outside the workspace collapse to /workspace.

import type {
  AgentRuntime,
  AgentQuery,
  AgentQueryOptions,
  AgentEvent,
  AgentMcpServer,
  AgentSetMcpServersResult,
  AgentMcpServerStatus,
} from "../agent-runtime";

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
// forwarding them would require bidirectional RPC and is out of MVP scope.
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
        try { yield JSON.parse(frame.data) as AgentEvent; }
        catch {
          yield {
            type: "system",
            subtype: "error",
            message: `malformed SSE frame: ${frame.data.slice(0, 200)}`,
          } as unknown as AgentEvent;
        }
      }
    } finally {
      this.abort.abort();
      await destroyControllerSession(controller.session_id);
    }
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
