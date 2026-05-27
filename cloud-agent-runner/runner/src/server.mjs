// Session runner — runs inside the container.
//
// One container = one running query. URL scheme follows design.html
// (§ Session manager): /sessions, /sessions/{id}/input, etc. The session_id
// is whatever the first POST /sessions returns; the runner doesn't validate
// it across calls because the container is single-tenant.
//
// API surface:
//   GET    /health
//   POST   /sessions                    { options, message? } -> { session_id }
//   POST   /sessions/:id/input          { message }           -> 202
//   GET    /sessions/:id/stream         SSE of AgentEvent JSON
//   POST   /sessions/:id/interrupt                            -> 204
//   DELETE /sessions/:id                                      -> 204
//   GET    /sessions/:id                snapshot
//
// Auth: Bearer ${RUNNER_TOKEN}. The container exposes 8080; the controller
// publishes that to a random localhost port on the host.

import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as nodePty from "node-pty";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const TOKEN = process.env.RUNNER_TOKEN ?? "";
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS ?? `${15 * 60 * 1000}`, 10);

if (!TOKEN) {
  console.warn("[runner] WARNING: RUNNER_TOKEN is empty — all requests will be accepted");
}

class InputChannel {
  constructor() {
    this.queue = [];
    this.waiters = [];
    this.closed = false;
  }
  push(msg) {
    if (this.closed) return;
    if (this.waiters.length) {
      const w = this.waiters.shift();
      w({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
  }
  close() {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() { return this; }
  next() {
    if (this.queue.length) {
      return Promise.resolve({ value: this.queue.shift(), done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  return() {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }
}

const sessions = new Map();
let lastActivity = Date.now();
function touch() { lastActivity = Date.now(); }

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": buf.length,
  });
  res.end(buf);
}

function noContent(res, status = 204) {
  res.writeHead(status);
  res.end();
}

// Push an arbitrary JSON event into the SSE stream + replay ring. Used for
// workbench tool proxy calls and other non-SDK signals. Mirrors what the SDK
// event loop does so a late subscriber sees the call even if it joined after.
function emitInternalEvent(entry, event) {
  const enc = JSON.stringify(event);
  entry.events.push(enc);
  entry.eventBytes += enc.length;
  while (entry.events.length > 5000 || entry.eventBytes > 5_000_000) {
    const dropped = entry.events.shift();
    entry.eventBytes -= dropped.length;
  }
  for (const sub of entry.subscribers) {
    try { sub.write(`data: ${enc}\n\n`); } catch { /* sub gone */ }
  }
}

// Reconstruct a zod raw shape from JSON Schema using zod v4's fromJSONSchema.
// Cowork serializes each workbench tool's schema with z.toJSONSchema; the
// roundtrip preserves the field-level types the Claude SDK uses to generate
// the schema the model sees. If the top-level isn't a ZodObject (shouldn't
// happen for our tools, but be defensive), wrap in a single `args` field so
// the SDK still accepts it.
function jsonSchemaToZodShape(inputSchema) {
  const reconstructed = z.fromJSONSchema(inputSchema);
  // zod v4 ZodObject exposes its raw shape on `.shape` (and the internal
  // `_def.shape()` returns the same map). We prefer `.shape` for stability.
  if (reconstructed && typeof reconstructed === "object" && "shape" in reconstructed) {
    return reconstructed.shape;
  }
  return { args: reconstructed };
}

// Emit a `workbench_tool_call` SSE event and await the matching
// `/tool-result` POST. Shared between the SDK-driven proxy MCP server (below)
// and the test endpoint that lets the harness drive the proxy without
// involving the model. Both paths register the same kind of pending entry
// keyed by UUID; the resolver runs whichever lands first.
function proxyToolCall(entry, serverName, toolName, args, timeoutMs = 10 * 60 * 1000) {
  const callId = randomUUID();
  const promise = new Promise((resolve, reject) => {
    entry.pendingCalls.set(callId, { resolve, reject, requestedAt: Date.now() });
  });
  emitInternalEvent(entry, {
    type: "workbench_tool_call",
    id: callId,
    server: serverName,
    tool: toolName,
    arguments: args,
  });
  const timer = setTimeout(() => {
    const pending = entry.pendingCalls.get(callId);
    if (pending) {
      entry.pendingCalls.delete(callId);
      pending.reject(new Error(`workbench tool ${serverName}/${toolName} timed out after ${timeoutMs}ms`));
    }
  }, timeoutMs);
  return promise.finally(() => clearTimeout(timer));
}

// Build an in-process MCP server that proxies every call to the cowork
// frontend over SSE. Each invocation gets a UUID; the cowork side dispatches
// the real handler and POSTs the result back to /sessions/{id}/tool-result.
// Multiple in-flight calls are supported — they live in `entry.pendingCalls`
// keyed by id, so resolutions race correctly.
function buildWorkbenchProxyServers(entry, workbenchTools) {
  // Group by server name so each maps to one createSdkMcpServer. Also
  // remember every (server, tool) pair on the entry so the test-invoke
  // endpoint knows which tools the proxy is registered for.
  const byServer = new Map();
  for (const spec of workbenchTools) {
    if (!byServer.has(spec.server)) byServer.set(spec.server, []);
    byServer.get(spec.server).push(spec);
    entry.proxyTools.add(`${spec.server}/${spec.name}`);
  }
  const mcpServers = {};
  for (const [serverName, specs] of byServer) {
    const tools = specs.map((spec) => {
      const shape = jsonSchemaToZodShape(spec.inputSchema ?? { type: "object", properties: {} });
      return tool(
        spec.name,
        spec.description ?? "",
        shape,
        async (args) => proxyToolCall(entry, serverName, spec.name, args),
        spec.alwaysLoad ? { alwaysLoad: true } : undefined,
      );
    });
    mcpServers[serverName] = createSdkMcpServer({
      name: serverName,
      version: "0.1.0",
      tools,
    });
  }
  return mcpServers;
}

// True if the SDK error looks like the "not logged in" / "/login" message the
// Claude CLI emits when there's no usable credential. We pattern-match a few
// variants so a phrasing tweak upstream doesn't silently break the auth flow.
function isAuthError(msg) {
  if (typeof msg !== "string") return false;
  return /not logged in|please run \/login|sign in with your claude\.ai/i.test(msg);
}

// Sentinel exception thrown from inside runQueryLoop when we spot an auth
// error in an SDK `result` event. pumpEvents catches it and pivots into the
// recovery flow rather than tearing the container down.
class AuthRequired extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthRequired";
  }
}

// Inspect an SDK event for the auth-failure pattern. The SDK doesn't *throw*
// when auth fails — it ends the turn with a `result` event carrying
// `is_error: true` and `result: "Not logged in · Please run /login"` (and a
// synthetic empty assistant message earlier). We detect both shapes so a
// future variant still hits the recovery path.
function detectAuthError(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "result" && event.is_error && typeof event.result === "string") {
    if (isAuthError(event.result)) return event.result;
  }
  if (event.type === "system" && event.subtype === "error" && typeof event.message === "string") {
    if (isAuthError(event.message)) return event.message;
  }
  return null;
}

// Pump the SDK iterator into the session's event ring + SSE subscribers.
// Returns when the iterator completes (success), throws AuthRequired if we
// see the "Not logged in" pattern on a result event, or rethrows on iterator
// error. Factored out so it can be called once at session start and again
// after the auth flow restarts the query.
async function runQueryLoop(entry) {
  for await (const ev of entry.q) {
    // Auth errors don't throw — they end the turn with a result event whose
    // is_error is true. Detect BEFORE emitting so subscribers never see the
    // "Not logged in" result (which would otherwise drive cowork's state
    // machine to "error" and hide the auth card behind an error banner).
    // The recovery path emits auth_pending/auth_required in its place.
    const authMsg = detectAuthError(ev);
    if (authMsg) throw new AuthRequired(authMsg);
    touch();
    const enc = JSON.stringify(ev);
    entry.events.push(enc);
    entry.eventBytes += enc.length;
    // Bounded replay buffer: drop oldest beyond 5000 events / 5 MB.
    while (entry.events.length > 5000 || entry.eventBytes > 5_000_000) {
      const dropped = entry.events.shift();
      entry.eventBytes -= dropped.length;
    }
    for (const sub of entry.subscribers) {
      try { sub.write(`data: ${enc}\n\n`); } catch { /* sub gone */ }
    }
  }
}

// Spawn `claude setup-token` interactively, capture the OAuth URL it prints,
// and emit an `auth_required` event so cowork's UI can render the link + a
// code-paste field. Subsequent POST /sessions/{id}/auth-code calls pipe the
// pasted code to the subprocess's stdin. When setup-token exits cleanly,
// `.credentials.json` lands in the bind-mounted ~/.claude and we emit
// `auth_done` + restart the SDK query with the cached first message.
function beginAuthFlow(entry) {
  // Don't stack flows — if one is already running, the SSE replay will show
  // the existing auth_required event to any reconnecting client.
  if (entry.authProcess) return;
  // `claude setup-token` only prints the OAuth URL + accepts the pasted code
  // when stdout is a real TTY. util-linux `script` failed to forward stdin
  // from a Node pipe to the child's PTY (its own stdin must be a TTY for
  // that). node-pty gives us a true PTY pair: stdout we read via onData,
  // stdin we write via child.write() — and the writes go through the master
  // FD straight to the slave the CLI reads from. 10000 cols prevents the
  // OAuth URL from wrapping at 80; otherwise the regex grabs only the
  // first 80 chars and the user gets "Missing redirect_uri parameter".
  // `claude auth login` (not `setup-token`) — auth login requests the full
  // OAuth scopes the SDK needs (sessions:claude_code, mcp_servers, profile,
  // …) AND persists credentials to ~/.claude/.credentials.json on success.
  // setup-token prints an inference-only token meant for export via
  // CLAUDE_CODE_OAUTH_TOKEN; it doesn't persist and its narrow scope makes
  // the SDK fail again on the next turn. We bind-mount ~/.claude/, so the
  // credentials.json write lands on the host and every future container
  // boots already authenticated.
  const child = nodePty.spawn("claude", ["auth", "login"], {
    name: "xterm-256color",
    cols: 10000,
    rows: 200,
    cwd: process.cwd(),
    env: process.env,
  });
  entry.authProcess = child;
  let urlSeen = false;
  let lastUrl = null;
  let urlBuffer = "";
  let lastErrorEmittedAt = 0;
  // setup-token's "Invalid code" error message — emitted when the user pastes
  // a bad/incomplete OAuth code. setup-token does NOT exit on this; it sits at
  // a "Press Enter to retry" sub-prompt waiting for the user to acknowledge,
  // then returns to the "Paste code here" prompt. Without intervention the
  // runner just hangs forever from cowork's POV. We:
  //   1. write \r so setup-token cycles back to the paste prompt
  //   2. emit a fresh `auth_required` event so the UI re-shows the card with
  //      the SAME url (the OAuth state in the url is still valid — only the
  //      code the user typed was wrong)
  //   3. throttle to one error/2s so a chatty prompt re-render doesn't spam
  //      the chat with duplicate cards
  const OAUTH_ERROR_RE = /OAuth error|Invalid code|Please make sure the full code/i;
  child.onData((data) => {
    urlBuffer += data;
    if (urlBuffer.length > 16_000) urlBuffer = urlBuffer.slice(-8_000);
    if (!urlSeen) {
      const match = urlBuffer.match(/https:\/\/[^\s\x1b]+/);
      if (match) {
        urlSeen = true;
        lastUrl = match[0];
        emitInternalEvent(entry, {
          type: "system",
          subtype: "auth_required",
          url: match[0],
          message: "Claude Code needs to log in. Visit the URL, sign in, and paste the code back here.",
        });
      }
    }
    if (urlSeen && lastUrl && OAUTH_ERROR_RE.test(data)) {
      const now = Date.now();
      if (now - lastErrorEmittedAt > 2000) {
        lastErrorEmittedAt = now;
        // Don't auto-press Enter here — earlier we did, but the timing
        // raced with setup-token's UI rendering and sometimes caused a
        // clean-but-credentialless exit. Instead, the /auth-code handler
        // prepends \r to every code it sends so the prompt is dismissed
        // exactly when the user supplies the new code.
        emitInternalEvent(entry, {
          type: "system",
          subtype: "auth_required",
          url: lastUrl,
          message: "That code didn't match — try again with the URL above.",
        });
      }
    }
  });
  child.onExit(async ({ exitCode }) => {
    entry.authProcess = null;
    // Dump the full PTY transcript so we can debug what setup-token actually
    // produced — invaluable when "auth_done" fires but the new SDK still
    // says "Not logged in". Lives in /tmp inside the container.
    // Dump to the bind-mounted ~/.claude/ so we can read it on the host
    // AFTER the container exits — /tmp dies with the container.
    const debugPath = `${process.env.HOME}/.claude/.cowork-setup-token-debug.txt`;
    try {
      const fs = await import("node:fs/promises");
      await fs.writeFile(debugPath,
        `exit=${exitCode}\nat=${new Date().toISOString()}\n\n--- raw with ANSI ---\n${urlBuffer}\n\n--- ANSI-stripped ---\n${urlBuffer.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")}`);
      console.log(`[runner] setup-token transcript saved to ${debugPath} (exit=${exitCode}, ${urlBuffer.length} bytes)`);
    } catch (e) {
      console.warn(`[runner] failed to save setup-token transcript: ${e instanceof Error ? e.message : e}`);
    }
    // `claude auth login` writes ~/.claude/.credentials.json itself on
    // success — no token capture needed. We just check exit code AND look
    // for "Login successful" in the captured output. If we see it, restart
    // the SDK; the next claude subprocess reads .credentials.json and
    // auths. If "Login successful" isn't there, the exit is a no-op (user
    // dismissed, or auth login printed something we don't recognize) —
    // surface a failure so the UI re-shows the card.
    const cleanBuf = urlBuffer.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    const loginOk = /Login successful/i.test(cleanBuf);
    if (exitCode === 0 && loginOk) {
      emitInternalEvent(entry, {
        type: "system",
        subtype: "auth_done",
        message: "Authenticated. Resuming the session…",
      });
      try { await restartQuery(entry); }
      catch (err) {
        emitInternalEvent(entry, {
          type: "system",
          subtype: "error",
          message: `restart after auth failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        finishEntry(entry);
      }
    } else {
      emitInternalEvent(entry, {
        type: "system",
        subtype: "auth_failed",
        message: `claude auth login exited ${exitCode}${loginOk ? "" : " (no 'Login successful' marker)"}. Output tail: ${cleanBuf.slice(-400)}`,
      });
      // Don't finish the entry — the user can submit /login again. A fresh
      // attempt will spawn a new claude auth login subprocess.
    }
  });
}

// Restart the SDK query against the cached startBody. Replays the original
// first message so the agent sees the same prompt it failed on. The previous
// `entry.q` is dead at this point (the iterator threw), so we install a new
// InputChannel + new Query. pumpEvents resumes by calling runQueryLoop again.
async function restartQuery(entry) {
  const body = entry.startBody;
  if (!body) throw new Error("missing startBody — cannot restart");
  const input = new InputChannel();
  entry.input = input;
  if (body.message) input.push(body.message);
  // mcpServers in the original options blob held the workbench proxies (real
  // closures) — those are still wired to the same `entry`, so re-running with
  // the SAME options preserves the proxy MCP. We don't re-build them.
  entry.q = query({ prompt: input, options: entry.options });
  entry.done = false;
  void pumpEvents(entry);
}

// Close out the session's SSE subscribers and mark done. Called once when the
// session truly ends (non-auth error or natural completion).
function finishEntry(entry) {
  entry.done = true;
  for (const sub of entry.subscribers) {
    try { sub.write(`event: done\ndata: {}\n\n`); sub.end(); } catch { /* sub gone */ }
  }
  entry.subscribers.clear();
}

// Iterate the SDK once, intercepting auth errors to start the recovery flow
// instead of tearing down the container. Called at session start and after
// every successful auth restart.
async function pumpEvents(entry) {
  try {
    await runQueryLoop(entry);
    // Iterator completed cleanly — terminal.
    finishEntry(entry);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isAuthError(msg)) {
      // Don't terminate — surface an inline auth flow and hold the container.
      emitInternalEvent(entry, {
        type: "system",
        subtype: "auth_pending",
        message: msg,
      });
      beginAuthFlow(entry);
      return;
    }
    entry.error = msg;
    const enc = JSON.stringify({ type: "system", subtype: "error", message: msg });
    entry.events.push(enc);
    for (const sub of entry.subscribers) {
      try { sub.write(`event: error\ndata: ${enc}\n\n`); } catch { /* sub gone */ }
    }
    finishEntry(entry);
  }
}

function startSession(body) {
  const id = body.session_id ?? randomUUID();
  const input = new InputChannel();

  const options = { ...(body.options ?? {}) };
  // Per-token streaming so cowork can render incremental text.
  options.includePartialMessages = true;
  if (!options.permissionMode) options.permissionMode = "bypassPermissions";

  const entry = {
    id,
    input,
    options,
    events: [],
    eventBytes: 0,
    subscribers: new Set(),
    done: false,
    error: null,
    startedAt: Date.now(),
    q: null,
    // In-flight workbench tool calls awaiting a POST /tool-result from cowork.
    // Keyed by the UUID we emit in the workbench_tool_call event.
    pendingCalls: new Map(),
    // Set of "server/tool" pairs the proxy is registered for. Used by the
    // /test-invoke endpoint so it can refuse calls to unregistered tools.
    proxyTools: new Set(),
    dryRun: !!body.dryRun,
    // Cached so restartQuery() (after auth recovery) can replay the original
    // first message + options without cowork having to resend.
    startBody: body,
    authProcess: null,
  };
  sessions.set(id, entry);

  // Wire workbench tool proxies BEFORE the SDK starts so they're visible at
  // turn 1. Merges into whatever mcpServers the caller passed in options.
  if (Array.isArray(body.workbenchTools) && body.workbenchTools.length > 0) {
    const proxies = buildWorkbenchProxyServers(entry, body.workbenchTools);
    options.mcpServers = { ...(options.mcpServers ?? {}), ...proxies };
  }

  // `dryRun` skips the SDK entirely — the session exists only to exercise
  // the proxy mechanism via the /test-invoke endpoint. Used by the local
  // test harness when no Anthropic auth is available.
  if (entry.dryRun) {
    return id;
  }

  // Push the initial user message (if any) before starting the query so the
  // SDK doesn't sit idle waiting for input.
  if (body.message) input.push(body.message);

  entry.q = query({ prompt: input, options });
  void pumpEvents(entry);

  return id;
}

function attachStream(req, res, entry) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
  });
  for (const enc of entry.events) {
    res.write(`data: ${enc}\n\n`);
  }
  if (entry.done) {
    res.write(`event: done\ndata: {}\n\n`);
    res.end();
    return;
  }
  entry.subscribers.add(res);
  const ping = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch { /* gone */ }
  }, 25_000);
  req.on("close", () => {
    clearInterval(ping);
    entry.subscribers.delete(res);
  });
}

const ROUTES = [
  { method: "GET", re: /^\/health$/, handler: async (_req, res) => {
    json(res, 200, {
      ok: true,
      active_sessions: sessions.size,
      sdk: "@anthropic-ai/claude-agent-sdk",
      uptime_s: Math.round(process.uptime()),
    });
  }},
  { method: "POST", re: /^\/sessions$/, handler: async (req, res) => {
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: "invalid json" }); }
    const id = startSession(body);
    touch();
    json(res, 200, { session_id: id });
  }},
  { method: "GET", re: /^\/sessions$/, handler: async (_req, res) => {
    json(res, 200, {
      sessions: [...sessions.values()].map((s) => ({
        id: s.id,
        done: s.done,
        startedAt: new Date(s.startedAt).toISOString(),
        error: s.error,
      })),
    });
  }},
  { method: "GET", re: /^\/sessions\/([^/]+)$/, handler: async (_req, res, m) => {
    const entry = sessions.get(m[1]);
    if (!entry) return json(res, 404, { error: "unknown session" });
    json(res, 200, {
      id: entry.id,
      done: entry.done,
      startedAt: new Date(entry.startedAt).toISOString(),
      error: entry.error,
    });
  }},
  { method: "GET", re: /^\/sessions\/([^/]+)\/stream$/, handler: async (req, res, m) => {
    const entry = sessions.get(m[1]);
    if (!entry) return json(res, 404, { error: "unknown session" });
    attachStream(req, res, entry);
  }},
  { method: "POST", re: /^\/sessions\/([^/]+)\/input$/, handler: async (req, res, m) => {
    const entry = sessions.get(m[1]);
    if (!entry) return json(res, 404, { error: "unknown session" });
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: "invalid json" }); }
    const msg = body.message ?? body;  // accept either {message: ...} or the SDKUserMessage directly
    entry.input.push(msg);
    touch();
    noContent(res, 202);
  }},
  // Manually re-trigger the auth flow even if no SDK error has fired yet.
  // The UI's `/login` slash command lands here when the user wants to update
  // credentials proactively. Spawns claude setup-token if one isn't already
  // running; emits `auth_required` with the URL via SSE.
  { method: "POST", re: /^\/sessions\/([^/]+)\/auth-start$/, handler: async (_req, res, m) => {
    const entry = sessions.get(m[1]);
    if (!entry) return json(res, 404, { error: "unknown session" });
    if (entry.authProcess) {
      return json(res, 200, { status: "already running" });
    }
    beginAuthFlow(entry);
    touch();
    json(res, 202, { status: "started" });
  }},
  // Forward the OAuth code the user pasted in cowork's UI into the
  // setup-token subprocess's stdin. The CLI uses ink (React-for-terminal)
  // which reads via setRawMode(true) — icrnl is off, so we MUST send \r
  // (the literal Enter keycode the terminal would emit on a real keypress).
  // Sending \n alone gets buffered and never submits. Returns 409 if no
  // auth flow is in progress so the UI can react (e.g. show "expired").
  { method: "POST", re: /^\/sessions\/([^/]+)\/auth-code$/, handler: async (req, res, m) => {
    const entry = sessions.get(m[1]);
    if (!entry) return json(res, 404, { error: "unknown session" });
    if (!entry.authProcess) return json(res, 409, { error: "no auth flow in progress" });
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: "invalid json" }); }
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!code) return json(res, 400, { error: "missing code" });
    try {
      // node-pty's write() goes through the PTY master FD directly to the
      // slave the CLI reads from. `\r` is the literal Enter keycode the
      // terminal driver delivers when a real user presses Return (icrnl
      // converts to \n in cooked mode, but ink puts the input in raw mode
      // where \r is what the keypress reader expects).
      //
      // Leading \r dismisses any "Press Enter to retry" sub-prompt that
      // setup-token may be sitting on after a previously-bad code. If we're
      // at the regular "Paste code here >" prompt instead, the extra \r is
      // harmless (just an empty line which setup-token re-prompts on).
      entry.authProcess.write("\r" + code + "\r");
    } catch (e) {
      return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
    // Tell cowork the code was queued. The UI uses this to optimistically
    // dismiss the AuthCard and flip the session back to "Working" without
    // waiting for setup-token to confirm — which can take a few seconds and
    // makes the Submit button feel hung. If setup-token rejects the code,
    // `auth_failed` follows and the UI re-surfaces the card.
    emitInternalEvent(entry, {
      type: "system",
      subtype: "auth_submitted",
      message: "Code received — exchanging with Anthropic…",
    });
    touch();
    noContent(res, 202);
  }},
  // Resolve a workbench tool proxy call. Body: { id, result?, error? }. The
  // `result` is forwarded verbatim to the SDK as the tool's CallToolResult;
  // `error` rejects the in-flight handler so the SDK surfaces it as a tool
  // error. Idempotent: a stale POST after the call already resolved (or
  // timed out) returns 410 Gone — no-op rather than 404, so cowork can
  // distinguish unknown-session from already-resolved.
  { method: "POST", re: /^\/sessions\/([^/]+)\/tool-result$/, handler: async (req, res, m) => {
    const entry = sessions.get(m[1]);
    if (!entry) return json(res, 404, { error: "unknown session" });
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: "invalid json" }); }
    if (!body.id) return json(res, 400, { error: "missing id" });
    const pending = entry.pendingCalls.get(body.id);
    if (!pending) return json(res, 410, { error: "call no longer pending" });
    entry.pendingCalls.delete(body.id);
    if (body.error) {
      pending.reject(new Error(String(body.error)));
    } else {
      pending.resolve(body.result ?? { content: [{ type: "text", text: "" }] });
    }
    touch();
    noContent(res, 204);
  }},
  { method: "POST", re: /^\/sessions\/([^/]+)\/interrupt$/, handler: async (_req, res, m) => {
    const entry = sessions.get(m[1]);
    if (!entry) return json(res, 404, { error: "unknown session" });
    if (!entry.q) return noContent(res); // dryRun — nothing to interrupt
    try { await entry.q.interrupt(); } catch (e) {
      return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
    noContent(res);
  }},
  // Test-only: drive the workbench proxy without involving the SDK. Emits a
  // workbench_tool_call SSE event as if the model had called the tool, waits
  // for the matching /tool-result POST, and returns the resolved result.
  // Lets the harness verify the proxy mechanism end-to-end (including
  // parallel calls) on hosts without Anthropic auth.
  { method: "POST", re: /^\/sessions\/([^/]+)\/test-invoke$/, handler: async (req, res, m) => {
    const entry = sessions.get(m[1]);
    if (!entry) return json(res, 404, { error: "unknown session" });
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: "invalid json" }); }
    if (!body.server || !body.tool) return json(res, 400, { error: "server and tool required" });
    const key = `${body.server}/${body.tool}`;
    if (!entry.proxyTools.has(key)) {
      return json(res, 404, { error: `proxy tool ${key} not registered` });
    }
    touch();
    try {
      const timeoutMs = typeof body.timeout_ms === "number" ? body.timeout_ms : 30_000;
      const result = await proxyToolCall(entry, body.server, body.tool, body.arguments ?? {}, timeoutMs);
      json(res, 200, { result });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }},
  { method: "DELETE", re: /^\/sessions\/([^/]+)$/, handler: async (_req, res, m) => {
    const entry = sessions.get(m[1]);
    if (!entry) return noContent(res);
    try { entry.input.close(); } catch { /* ignore */ }
    if (entry.q) {
      try { await entry.q.interrupt(); } catch { /* ignore */ }
    }
    sessions.delete(m[1]);
    noContent(res);
  }},
];

const server = http.createServer(async (req, res) => {
  if (TOKEN) {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${TOKEN}`) return json(res, 401, { error: "unauthorized" });
  }
  const url = new URL(req.url ?? "/", "http://x");
  for (const r of ROUTES) {
    const m = url.pathname.match(r.re);
    if (m && req.method === r.method) {
      try { return await r.handler(req, res, m); }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[runner] handler error:", msg);
        return json(res, 500, { error: msg });
      }
    }
  }
  json(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[runner] listening on 0.0.0.0:${PORT}`);
});

setInterval(() => {
  if (sessions.size === 0) return;
  if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
    console.log(`[runner] idle for ${Math.round((Date.now() - lastActivity) / 1000)}s — exiting`);
    process.exit(0);
  }
}, 60_000).unref();

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[runner] received ${sig}, shutting down`);
    for (const entry of sessions.values()) {
      try { entry.input.close(); } catch { /* ignore */ }
      for (const sub of entry.subscribers) {
        try { sub.end(); } catch { /* ignore */ }
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
