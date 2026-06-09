import { Hono, type Context } from "hono";
import {
  listAllSessions,
  readSessionHistory,
  getSession,
  restoreSession,
  relayRemoteRunner,
  markSessionCompleted,
  markSessionBacklog,
  resolveCompletionSuggestion,
  deleteSession,
  forceStop,
  injectSystemMessage,
  sendInput,
  sendInputWithFiles,
  interrupt,
  setSessionModel,
  listSessionModels,
  setSessionEffort,
  resolvePermission,
  resolveQuestion,
  renameSession,
  retrySession,
  markSessionSeen,
  type FileAttachmentInfo,
} from "@/lib/sessions";
import type { EffortLevel } from "@/lib/types";
import { extractTodosFromMessages } from "@/lib/todos";
import { isVisibleSDKMessage } from "@/components/chat/utils";
import { decodeWorkspacePath } from "@/lib/routes";

export const sessions = new Hono();

// Helper used everywhere a workspace is read from the request. Clients pass
// the slug-chain in a `workspace=` query param (URI-encoded per segment,
// joined with `/`). Body-borne paths are also supported via the alternate
// callsite (e.g. for /input which already carries JSON body).
function workspacePathFromQuery(c: Context): string[] | null {
  const raw = c.req.query("workspace");
  if (raw === undefined || raw === null) return null;
  return decodeWorkspacePath(raw);
}

// Pull a workspace path out of a parsed JSON body. Accepts either an array
// (preferred) or a slash-joined string (fallback for symmetry with the query
// helper). Returns null when neither is present.
function workspacePathFromBody(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.workspace)) return b.workspace as string[];
  if (typeof b.workspace === "string") return decodeWorkspacePath(b.workspace);
  return null;
}

// ---- collection ---------------------------------------------------------
sessions.get("/", async (c) => {
  return c.json({ sessions: await listAllSessions() });
});

// ---- reads on a single session ------------------------------------------
sessions.get("/:id/history", async (c) => {
  const id = c.req.param("id");
  const url = new URL(c.req.raw.url);
  const workspacePath = workspacePathFromQuery(c);
  if (!workspacePath) {
    return c.json({ error: "workspace required" }, 400);
  }

  // Pagination parameters for lazy loading
  // limit: how many messages to return (default: all)
  // offset: skip this many messages from the END (for loading older messages)
  // When offset=0, limit=50: returns the last 50 messages
  // When offset=50, limit=50: returns messages 50-100 from the end (older)
  const limitStr = url.searchParams.get("limit");
  const offsetStr = url.searchParams.get("offset");
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;
  const offset = offsetStr ? parseInt(offsetStr, 10) : 0;

  const result = await readSessionHistory(workspacePath, id, limit, offset);
  if (!result) return c.json({ error: "not found" }, 404);
  return c.json(result);
});

// Default number of recent VISIBLE messages to send on initial connection.
// Visible = rendered as a bubble/card/pill — tool calls (chips) and
// tool_result echoes (hidden) don't count, otherwise tool-heavy turns would
// send a 50-event page that renders almost nothing.
const INITIAL_MESSAGE_LIMIT = 50;

sessions.get("/:id/stream", async (c) => {
  const req = c.req.raw;
  const id = c.req.param("id");
  const url = new URL(req.url);

  // If session isn't in memory (typical after a server restart), restore it
  // from disk so the SSE can replay history and pick up future events from a
  // subsequent resume. Without this, the SSE 404s on first load and the
  // client falls back to a one-shot history fetch — meaning new messages the
  // user sends never appear until they reload.
  let s = getSession(id);
  if (!s) {
    const workspacePath = workspacePathFromQuery(c);
    if (workspacePath) {
      s = (await restoreSession(workspacePath, id)) ?? undefined;
    }
  }
  if (!s) return new Response("not found", { status: 404 });

  // Check for pagination params (for initial history)
  const limitStr = url.searchParams.get("limit");
  const initialLimit = limitStr ? parseInt(limitStr, 10) : INITIAL_MESSAGE_LIMIT;

  const encoder = new TextEncoder();
  let cleanup: () => void = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (chunk: Uint8Array) => {
        try { controller.enqueue(chunk); } catch { /* stream closed */ }
      };
      const sendEvent = (event: string, data: unknown) => {
        safeEnqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // Replay recent history so new clients see the transcript. Pagination
      // is by visible-message count (see fileRead in cloud-events.ts): walk
      // back from the end including every event, until `initialLimit` visible
      // messages have been collected.
      const history = s.history;
      const total = history.reduce<number>((n, e) => n + (isVisibleSDKMessage(e) ? 1 : 0), 0);
      let startIdx = history.length;
      let visibleSeen = 0;
      while (startIdx > 0 && visibleSeen < initialLimit) {
        startIdx--;
        if (isVisibleSDKMessage(history[startIdx])) visibleSeen++;
      }
      let hasMore = false;
      for (let k = startIdx - 1; k >= 0; k--) {
        if (isVisibleSDKMessage(history[k])) { hasMore = true; break; }
      }
      const initialHistory = history.slice(startIdx);

      sendEvent("state", { state: s.state });
      // Send history metadata so client can implement "load more". `total` is
      // visible-only; `loaded` is event-count for the page (matches client
      // `messages.length`, used as `offset` on the next load-more request).
      sendEvent("history_meta", { total, loaded: initialHistory.length, hasMore, offset: history.length - initialHistory.length });
      // Derive the todo list from the FULL history (not the truncated initial
      // window) and send it as a snapshot. The chat transcript is paginated, so
      // a client deriving todos from only the loaded messages would miss any
      // TodoWrite/TaskCreate/TaskUpdate calls in older, not-yet-loaded messages.
      sendEvent("todos", extractTodosFromMessages(s.history));
      for (const msg of initialHistory) sendEvent("message", msg);
      // If a turn is mid-stream, replay the text that streamed before this
      // client connected so the in-progress bubble matches the live one.
      // Must come AFTER the message replay — those messages clear the
      // client's streamingText buffer as they render.
      if (s.streamingText) {
        sendEvent("stream_snapshot", { text: s.streamingText });
      }

      // Replay any in-flight permission requests so a late-joining client
      // sees the pending approval card immediately (e.g. user navigates to
      // the session URL after the agent has already asked).
      for (const [toolUseId, pending] of s.pendingPermissions) {
        sendEvent("permission_request", {
          toolUseId,
          toolName: pending.toolName,
          input: pending.input,
        });
      }
      // Same idea for AskUserQuestion — show the card immediately so the
      // user doesn't have to interact-then-refresh to see what's pending.
      // The `?? []` guards against sessions that landed in the registry
      // before pendingQuestions was added to RuntimeSession (the in-memory
      // map survives HMR via globalThis.__wb_session_registry, so adding a
      // new field to the type doesn't retroactively populate it).
      for (const [questionId, pending] of (s.pendingQuestions ?? [])) {
        sendEvent("question_request", { questionId, questions: pending.questions });
      }
      // Same for parked completion suggestions, plus the current completed flag
      // so the header badge renders immediately on load.
      for (const [requestId, pending] of (s.pendingCompletions ?? [])) {
        sendEvent("completion_request", { requestId, reason: pending.reason ?? null });
      }
      sendEvent("completed_changed", { completed: !!s.completed });
      sendEvent("backlog_changed", { backlog: !!s.backlog });
      // Replay the last known subscription rate-limit snapshot so the usage
      // indicator renders immediately on load, before the next turn refreshes it.
      if (s.rateLimit) sendEvent("rate_limit", s.rateLimit);

      const onEvent = (msg: unknown) => sendEvent("message", msg);
      const onTodos = (todos: unknown) => sendEvent("todos", todos);
      const onRateLimit = (info: unknown) => sendEvent("rate_limit", info);
      const onState = (state: string) => sendEvent("state", { state });
      const onFileChanged = (data: { path: string }) => sendEvent("file_changed", data);
      const onPermissionRequest = (data: unknown) => sendEvent("permission_request", data);
      const onPermissionResolved = (data: unknown) => sendEvent("permission_resolved", data);
      const onQuestionRequest = (data: unknown) => sendEvent("question_request", data);
      const onQuestionResolved = (data: unknown) => sendEvent("question_resolved", data);
      const onCompletionRequest = (data: unknown) => sendEvent("completion_request", data);
      const onCompletionResolved = (data: unknown) => sendEvent("completion_resolved", data);
      const onCompletedChanged = (data: unknown) => sendEvent("completed_changed", data);
      const onBacklogChanged = (data: unknown) => sendEvent("backlog_changed", data);
      s.events.on("event", onEvent);
      s.events.on("todos", onTodos);
      s.events.on("rate_limit", onRateLimit);
      s.events.on("state", onState);
      s.events.on("file_changed", onFileChanged);
      s.events.on("permission_request", onPermissionRequest);
      s.events.on("permission_resolved", onPermissionResolved);
      s.events.on("question_request", onQuestionRequest);
      s.events.on("question_resolved", onQuestionResolved);
      s.events.on("completion_request", onCompletionRequest);
      s.events.on("completion_resolved", onCompletionResolved);
      s.events.on("completed_changed", onCompletedChanged);
      s.events.on("backlog_changed", onBacklogChanged);

      const heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(": ping\n\n"));
      }, 15000);

      cleanup = () => {
        clearInterval(heartbeat);
        s.events.off("event", onEvent);
        s.events.off("todos", onTodos);
        s.events.off("rate_limit", onRateLimit);
        s.events.off("state", onState);
        s.events.off("file_changed", onFileChanged);
        s.events.off("permission_request", onPermissionRequest);
        s.events.off("permission_resolved", onPermissionResolved);
        s.events.off("question_request", onQuestionRequest);
        s.events.off("question_resolved", onQuestionResolved);
        s.events.off("completion_request", onCompletionRequest);
        s.events.off("completion_resolved", onCompletionResolved);
        s.events.off("completed_changed", onCompletedChanged);
        s.events.off("backlog_changed", onBacklogChanged);
        try { controller.close(); } catch { /* already closed */ }
      };

      // Browser tab closed → request is aborted → we clean up.
      req.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() { cleanup(); },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

// ---- actions on a single session ----------------------------------------

// Forward an OAuth code the user pasted in the chat UI into the runner's
// `claude setup-token` subprocess. On success the runner writes
// `.credentials.json` into the bind-mounted ~/.claude (so all future
// containers inherit auth too) and restarts the SDK with the cached first
// message — events resume on the existing SSE stream.
sessions.post("/:id/auth-code", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.raw.json().catch(() => ({})) as { code?: string };
  if (typeof body.code !== "string" || !body.code.trim()) {
    return c.json({ error: "missing `code`" }, 400);
  }
  const r = await relayRemoteRunner(id, "/auth-code", { code: body.code.trim() });
  if (!r) {
    return c.json(
      { error: "session is not remote, not live, or doesn't support runner relay" },
      404,
    );
  }
  return c.json(r.body, r.status as 200);
});

// Trigger the runner's `claude setup-token` flow proactively. Used by the UI
// when the user types `/login` even though no auth error has fired yet — e.g.
// to refresh credentials or after a re-auth on the host side.
//
// Auto-triggered auth (when the SDK throws "Not logged in") happens entirely
// inside the runner without this route — the SSE stream gets the
// `auth_required` event directly.
sessions.post("/:id/auth-start", async (c) => {
  const id = c.req.param("id");
  const r = await relayRemoteRunner(id, "/auth-start", {});
  if (!r) {
    return c.json(
      { error: "session is not remote, not live, or doesn't support runner relay" },
      404,
    );
  }
  return c.json(r.body, r.status as 200);
});

// POST /api/sessions/:id/complete
// Body shapes:
//   { workspace: string[] | "slug/chain", completed: boolean }
//     → manual mark/unmark (user clicked the button)
//   { workspace, completed: boolean, requestId: string }
//     → resolve an agent suggest_session_complete request; `completed` is the
//       user's decision (true = approve + mark complete, false = dismiss).
sessions.post("/:id/complete", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.raw.json() as {
    workspace?: string | string[];
    completed?: boolean;
    requestId?: string;
  };

  if (typeof body.completed !== "boolean") {
    return c.json({ error: "`completed` (boolean) is required" }, 400);
  }
  const workspacePath = workspacePathFromBody(body);
  if (!workspacePath) {
    return c.json({ error: "workspace is required" }, 400);
  }

  // If this resolves an agent suggestion, unblock the parked tool handler
  // first. The handler returns "approved" / "dismissed" to the model based on
  // the boolean. The mark itself still happens below so the on-disk flag is
  // up to date even if the suggestion was already cleared.
  if (body.requestId) {
    resolveCompletionSuggestion(id, body.requestId, body.completed);
  }

  const ok = await markSessionCompleted(workspacePath, id, body.completed);
  if (!ok) {
    return c.json({ error: "session not found" }, 404);
  }
  return c.json({ ok: true });
});

// POST /api/sessions/:id/backlog
// Body: { workspace: string[] | "slug/chain", backlog: boolean }
// Move a session to/from the backlog — its completion is waiting on something
// external. Backlog sessions move out of "Active Sessions" into the separate
// "Backlog" list in the sidebar.
sessions.post("/:id/backlog", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.raw.json() as {
    workspace?: string | string[];
    backlog?: boolean;
  };

  if (typeof body.backlog !== "boolean") {
    return c.json({ error: "`backlog` (boolean) is required" }, 400);
  }
  const workspacePath = workspacePathFromBody(body);
  if (!workspacePath) {
    return c.json({ error: "workspace is required" }, 400);
  }

  const ok = await markSessionBacklog(workspacePath, id, body.backlog);
  if (!ok) {
    return c.json({ error: "session not found" }, 404);
  }
  return c.json({ ok: true });
});

sessions.post("/:id/force-stop", async (c) => {
  const id = c.req.param("id");
  const ok = forceStop(id);
  if (!ok) return c.json({ error: "session not found" }, 404);
  return c.json({ ok: true });
});

// Inject a system message into the session's event stream. Used for
// confirmation messages (e.g., when a plan is approved).
sessions.post("/:id/inject-message", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.raw.json() as { message?: string };

  if (!body.message || typeof body.message !== "string") {
    return c.json({ error: "message required" }, 400);
  }

  const ok = injectSystemMessage(id, body.message);
  if (!ok) {
    return c.json({ error: "session not found" }, 404);
  }

  return c.json({ ok: true });
});

sessions.post("/:id/input", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.raw.json();
  if (!body.message || typeof body.message !== "string") {
    return c.json({ error: "message required" }, 400);
  }

  const workspacePath = workspacePathFromBody(body);
  const files = body.files as FileAttachmentInfo[] | undefined;
  const openArtifact = typeof body.openArtifact === "string" && body.openArtifact.length > 0
    ? body.openArtifact
    : undefined;

  // If session isn't in memory, try to restore it from disk
  if (!getSession(id) && workspacePath) {
    await restoreSession(workspacePath, id);
  }

  // Use extended function if files are provided
  let ok: boolean;
  if (files && files.length > 0 && workspacePath) {
    ok = await sendInputWithFiles(id, body.message, files, workspacePath, openArtifact);
  } else {
    ok = await sendInput(id, body.message, openArtifact);
  }

  if (!ok) return c.json({ error: "session not found or failed to resume" }, 404);
  return c.json({ ok: true });
});

sessions.post("/:id/interrupt", async (c) => {
  const id = c.req.param("id");
  const ok = await interrupt(id);
  if (!ok) return c.json({ error: "session not found" }, 404);
  return c.json({ ok: true });
});

// List the models this session can switch to (the runtime's live model list).
// Empty array when the runtime pins its own model or the agent process isn't
// alive to answer — the UI then just shows the current model, non-editable.
sessions.get("/:id/models", async (c) => {
  const id = c.req.param("id");
  const models = await listSessionModels(id);
  return c.json({ models });
});

// Switch the model used for subsequent turns. Body: { model: string | null }
// (null clears the pin → runtime default). Only allowed when the session isn't
// actively generating — switching mid-turn would race the in-flight response.
sessions.post("/:id/model", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.raw.json().catch(() => ({})) as { model?: string | null };
  if (!("model" in body) || (typeof body.model !== "string" && body.model !== null)) {
    return c.json({ error: "body must include `model` (string or null)" }, 400);
  }
  const ok = await setSessionModel(id, body.model);
  if (!ok) {
    return c.json(
      { error: "session not found, or it is currently running (stop it first to change the model)" },
      409,
    );
  }
  return c.json({ ok: true, model: body.model });
});

// Switch the thinking/reasoning effort for subsequent turns. Body:
// { effort: "low"|"medium"|"high"|"xhigh"|"max"|null } (null → runtime default).
// Only allowed when the session isn't actively generating.
sessions.post("/:id/effort", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.raw.json().catch(() => ({})) as { effort?: string | null };
  const VALID = ["low", "medium", "high", "xhigh", "max"];
  if (!("effort" in body) || (body.effort !== null && !VALID.includes(body.effort as string))) {
    return c.json(
      { error: "body must include `effort` (one of low|medium|high|xhigh|max, or null)" },
      400,
    );
  }
  const ok = await setSessionEffort(id, body.effort as EffortLevel | null);
  if (!ok) {
    return c.json(
      { error: "session not found, or it is currently running (stop it first to change the effort)" },
      409,
    );
  }
  return c.json({ ok: true, effort: body.effort });
});

// Resolve a tool-use approval the agent's `canUseTool` callback is awaiting.
// Body shape:
//   { toolUseId: string,
//     behavior: "allow" | "deny",
//     message?: string,           // deny reason / guidance for the model
//     updatedInput?: object }     // allow with edits to the tool input
//
// Today the only tool we gate through this is ExitPlanMode — the agent
// finishes a plan and the UI shows an Approve/Deny card. On Approve the SDK
// transitions out of plan mode and the agent starts executing.
sessions.post("/:id/permission", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.raw.json() as {
    toolUseId?: string;
    behavior?: "allow" | "deny";
    message?: string;
    updatedInput?: Record<string, unknown>;
  };

  if (!body.toolUseId || (body.behavior !== "allow" && body.behavior !== "deny")) {
    return c.json(
      { error: "body must include `toolUseId` and `behavior` ('allow' | 'deny')" },
      400,
    );
  }

  const result = body.behavior === "allow"
    ? { behavior: "allow" as const, updatedInput: body.updatedInput ?? {} }
    : { behavior: "deny" as const, message: body.message ?? "User denied.", interrupt: false };

  const ok = resolvePermission(id, body.toolUseId, result);
  if (!ok) {
    return c.json(
      { error: "no pending permission for that toolUseId (already resolved, session not in memory, or wrong id)" },
      404,
    );
  }
  return c.json({ ok: true });
});

// Resolve a pending AskUserQuestion the agent's tool handler is awaiting.
// Body shape (answer):
//   { questionId: string,
//     answers: Array<{ selected?: string[]; other?: string }> }
// Body shape (refuse):
//   { questionId: string, refused: true }
//
// `selected` is the labels of the options the user picked. `other` is the
// free text from the auto-provided "Other" input. When `refused: true`, the
// user dismissed the prompt and the agent gets a "user declined to answer"
// result instead of selections.
sessions.post("/:id/question", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.raw.json() as {
    questionId?: string;
    answers?: Array<{ selected?: string[]; other?: string }>;
    refused?: boolean;
  };

  if (!body.questionId) {
    return c.json(
      { error: "body must include `questionId`" },
      400,
    );
  }
  if (!body.refused && !Array.isArray(body.answers)) {
    return c.json(
      { error: "body must include `answers` (array) or `refused: true`" },
      400,
    );
  }

  const payload = body.refused ? null : body.answers!;
  const ok = resolveQuestion(id, body.questionId, payload);
  if (!ok) {
    return c.json(
      { error: "no pending question for that questionId (already answered, session not in memory, or wrong id)" },
      404,
    );
  }
  return c.json({ ok: true });
});

// POST /api/sessions/:id/rename
// Body: { workspace: string[] | "slug/chain", name: string }
// Renames a session (works for both live and stopped sessions)
sessions.post("/:id/rename", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.raw.json();
  const workspacePath = workspacePathFromBody(body);
  const { name } = body;

  if (!workspacePath) {
    return c.json({ error: "workspace is required" }, 400);
  }
  if (!name || typeof name !== "string" || !name.trim()) {
    return c.json({ error: "name is required" }, 400);
  }

  const ok = await renameSession(workspacePath, id, name);
  if (!ok) {
    return c.json(
      { error: "session not found" },
      404,
    );
  }

  return c.json({ ok: true });
});

sessions.post("/:id/retry", async (c) => {
  const id = c.req.param("id");
  const success = await retrySession(id);
  if (!success) {
    return new Response("Session not found or not in error state", { status: 404 });
  }
  return Response.json({ success: true });
});

// POST /api/sessions/:id/seen
// Body: { workspace: string[] | "slug/chain" }
// Marks the session as seen by the user.
sessions.post("/:id/seen", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.raw.json();
  const workspacePath = workspacePathFromBody(body);

  if (!workspacePath) {
    return c.json({ error: "workspace is required" }, 400);
  }

  const ok = await markSessionSeen(workspacePath, id);
  if (!ok) {
    return c.json({ error: "session not found" }, 404);
  }

  return c.json({ ok: true });
});

// delete supports both verbs (the UI POSTs; REST clients may DELETE).
// DELETE /api/sessions/:id/delete  or  POST /api/sessions/:id/delete
// Body: { workspace: string[] | "slug/chain" }
// Deletes a stopped session.
async function handleDelete(c: Context) {
  const id = c.req.param("id")!;
  const body = await c.req.raw.json();
  const workspacePath = workspacePathFromBody(body);

  if (!workspacePath) {
    return c.json({ error: "workspace is required" }, 400);
  }

  const ok = await deleteSession(workspacePath, id);
  if (!ok) {
    return c.json(
      { error: "Session not found or is actively running" },
      404,
    );
  }

  return c.json({ ok: true });
}

sessions.delete("/:id/delete", handleDelete);
sessions.post("/:id/delete", handleDelete);
