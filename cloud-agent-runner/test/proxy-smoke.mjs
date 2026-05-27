// End-to-end smoke test for the workbench-tool reverse-call proxy.
//
// Boots a local controller as a child, provisions a runner container via the
// controller, then drives the workbench proxy directly via the runner's
// `dryRun` mode + `/test-invoke` endpoint (no model invocation, no Anthropic
// auth required). Validates:
//   1. Single round-trip — emit workbench_tool_call SSE event, POST a result
//      back, the original /test-invoke call returns the result.
//   2. Parallel calls — fire N invocations of the same tool concurrently with
//      distinct args; expect N distinct SSE events; deliver results in REVERSE
//      order; verify each /test-invoke returns its OWN result (no mixups).
//
// Designed to run as one foreground Bash call so the controller child lives
// for the duration of the test then dies cleanly.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const CTRL_PORT = process.env.TEST_CTRL_PORT ?? "8095";
const CTRL_URL = `http://127.0.0.1:${CTRL_PORT}`;
const CTRL_TOKEN = "smoke-test-token";

function log(label, ...args) { console.log(`[${label}]`, ...args); }

async function http(url, init = {}) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* keep raw */ }
  return { status: r.status, ok: r.ok, body, raw: text };
}

async function waitForHealth(url, label, headers = {}, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { headers });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Async queue of workbench_tool_call events the SSE stream observes.
// Tests `waitForCall(matcher)` to pop the next event matching a predicate.
class CallQueue {
  constructor() {
    this.buffered = [];
    this.waiters = []; // { match, resolve }
  }
  push(ev) {
    for (let i = 0; i < this.waiters.length; i++) {
      if (this.waiters[i].match(ev)) {
        const { resolve } = this.waiters.splice(i, 1)[0];
        resolve(ev);
        return;
      }
    }
    this.buffered.push(ev);
  }
  waitFor(match, timeoutMs = 5000) {
    for (let i = 0; i < this.buffered.length; i++) {
      if (match(this.buffered[i])) {
        return Promise.resolve(this.buffered.splice(i, 1)[0]);
      }
    }
    return new Promise((resolve, reject) => {
      const entry = { match, resolve };
      this.waiters.push(entry);
      setTimeout(() => {
        const idx = this.waiters.indexOf(entry);
        if (idx !== -1) {
          this.waiters.splice(idx, 1);
          reject(new Error(`waitForCall timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });
  }
}

async function readSseLoop(res, queue, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    let chunk;
    try { chunk = await reader.read(); }
    catch { return; }
    if (chunk.done) return;
    buffer += decoder.decode(chunk.value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        try {
          const ev = JSON.parse(data);
          if (ev?.type === "workbench_tool_call") queue.push(ev);
        } catch { /* ignore non-JSON frames */ }
      }
    }
  }
}

async function main() {
  log("test", `repo=${REPO_ROOT} ctrl=${CTRL_URL}`);

  const controller = spawn("node", ["controller/src/server.mjs"], {
    cwd: path.join(REPO_ROOT, "cloud-agent-runner"),
    env: {
      ...process.env,
      PORT: CTRL_PORT,
      AGENT_CONTROLLER_TOKEN: CTRL_TOKEN,
      DOCKER_IMAGE: "rowads-agent-runner:latest",
      WORKSPACE_DIR: REPO_ROOT,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  controller.stdout.on("data", (d) => process.stdout.write(`[ctrl] ${d}`));
  controller.stderr.on("data", (d) => process.stderr.write(`[ctrl-err] ${d}`));

  let sessionId = null;
  let stop = () => { /* set after SSE starts */ };
  try {
    await waitForHealth(`${CTRL_URL}/v1/health`, "controller", {
      authorization: `Bearer ${CTRL_TOKEN}`,
    });
    log("test", "controller is up");

    const create = await http(`${CTRL_URL}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CTRL_TOKEN}` },
      body: JSON.stringify({ user: "smoke", project: "test", task: "proxy-smoke", cli: "claude" }),
    });
    if (!create.ok) throw new Error(`POST /v1/sessions ${create.status}: ${create.raw}`);
    const { session_id, runner_url, runner_token, container_id } = create.body;
    sessionId = session_id;
    log("test", `session=${session_id.slice(0, 8)} runner=${runner_url} container=${container_id.slice(0, 12)}`);

    // Two test tools — distinct shapes so we exercise schema reconstruction.
    const workbenchTools = [
      {
        server: "workbench-test",
        name: "echo",
        description: "Echo back the message you receive.",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
      {
        server: "workbench-test",
        name: "ping",
        description: "Trivial ping with an integer index.",
        inputSchema: {
          type: "object",
          properties: { idx: { type: "integer" } },
          required: ["idx"],
          additionalProperties: false,
        },
      },
    ];

    const start = await http(`${runner_url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${runner_token}` },
      body: JSON.stringify({ session_id, dryRun: true, workbenchTools }),
    });
    if (!start.ok) throw new Error(`POST /sessions ${start.status}: ${start.raw}`);
    log("test", "runner session started (dryRun=true)");

    // Subscribe SSE.
    const queue = new CallQueue();
    const abort = new AbortController();
    stop = () => abort.abort();
    const sseRes = await fetch(`${runner_url}/sessions/${session_id}/stream`, {
      headers: { authorization: `Bearer ${runner_token}` },
      signal: abort.signal,
    });
    if (!sseRes.ok) throw new Error(`SSE stream returned ${sseRes.status}`);
    const ssePump = readSseLoop(sseRes, queue, abort.signal);

    // ─── Test 1 — single round-trip ───────────────────────────────────────
    log("test", "case 1: single round-trip");
    const invoke1 = http(`${runner_url}/sessions/${session_id}/test-invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${runner_token}` },
      body: JSON.stringify({ server: "workbench-test", tool: "echo", arguments: { message: "hello" } }),
    });
    const ev1 = await queue.waitFor((ev) => ev.tool === "echo");
    if (ev1.arguments?.message !== "hello") {
      throw new Error(`echo got wrong args: ${JSON.stringify(ev1.arguments)}`);
    }
    const r1 = await http(`${runner_url}/sessions/${session_id}/tool-result`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${runner_token}` },
      body: JSON.stringify({
        id: ev1.id,
        result: { content: [{ type: "text", text: "echoed:hello" }] },
      }),
    });
    if (r1.status !== 204) throw new Error(`tool-result ${r1.status}: ${r1.raw}`);
    const inv1 = await invoke1;
    const txt1 = inv1.body?.result?.content?.[0]?.text;
    if (txt1 !== "echoed:hello") {
      throw new Error(`single round-trip mismatch: got ${JSON.stringify(inv1.body)}`);
    }
    log("test", "  PASS — single round-trip");

    // ─── Test 2 — N parallel calls, results delivered in reverse order ───
    const N = 5;
    log("test", `case 2: ${N} parallel calls, results delivered in reverse order`);
    const invokes = [];
    for (let i = 0; i < N; i++) {
      invokes.push(
        http(`${runner_url}/sessions/${session_id}/test-invoke`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${runner_token}` },
          body: JSON.stringify({ server: "workbench-test", tool: "ping", arguments: { idx: i } }),
        }),
      );
    }
    // Collect N SSE events keyed by idx.
    const idxToCall = new Map();
    for (let i = 0; i < N; i++) {
      const ev = await queue.waitFor((e) => e.tool === "ping" && !idxToCall.has(e.arguments?.idx), 10_000);
      idxToCall.set(ev.arguments.idx, ev);
    }
    if (idxToCall.size !== N) throw new Error(`expected ${N} unique idx, got ${idxToCall.size}`);
    const ids = [...idxToCall.values()].map((e) => e.id);
    if (new Set(ids).size !== N) throw new Error("UUIDs not unique");
    log("test", `  saw ${N} distinct tool_call events`);
    // POST results in REVERSE order — exercises the id-keyed pending Map.
    for (let i = N - 1; i >= 0; i--) {
      const ev = idxToCall.get(i);
      const r = await http(`${runner_url}/sessions/${session_id}/tool-result`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${runner_token}` },
        body: JSON.stringify({
          id: ev.id,
          result: { content: [{ type: "text", text: `pong-${i}` }] },
        }),
      });
      if (r.status !== 204) throw new Error(`tool-result for idx=${i} ${r.status}: ${r.raw}`);
    }
    const results = await Promise.all(invokes);
    for (let i = 0; i < N; i++) {
      const txt = results[i].body?.result?.content?.[0]?.text;
      if (txt !== `pong-${i}`) {
        throw new Error(`parallel mismatch at i=${i}: got ${txt}, want pong-${i}`);
      }
    }
    log("test", `  PASS — ${N} parallel calls resolved with correct args ↔ result mapping`);

    // ─── Test 3 — late /tool-result returns 410 Gone ──────────────────────
    log("test", "case 3: tool-result for unknown id returns 410");
    const r3 = await http(`${runner_url}/sessions/${session_id}/tool-result`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${runner_token}` },
      body: JSON.stringify({ id: "not-a-real-id", result: { content: [] } }),
    });
    if (r3.status !== 410) throw new Error(`expected 410, got ${r3.status}: ${r3.raw}`);
    log("test", "  PASS — stale tool-result returns 410");

    abort.abort();
    await ssePump.catch(() => { /* expected on abort */ });
    log("test", "ALL CHECKS PASSED");
  } finally {
    stop();
    if (sessionId) {
      try {
        await http(`${CTRL_URL}/v1/sessions/${sessionId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${CTRL_TOKEN}` },
        });
      } catch { /* best effort */ }
    }
    controller.kill("SIGTERM");
    await sleep(300);
    if (!controller.killed) controller.kill("SIGKILL");
  }
}

main().catch((e) => {
  console.error("[test] FAIL:", e.message);
  process.exit(1);
});
