import { getSession, restoreSession } from "@/lib/sessions";
import { getPreviewSession } from "@/lib/preview/preview-session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Default number of recent messages to send on initial connection
const INITIAL_MESSAGE_LIMIT = 50;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);

  // If session isn't in memory (typical after a server restart), restore it
  // from disk so the SSE can replay history and pick up future events from a
  // subsequent resume. Without this, the SSE 404s on first load and the
  // client falls back to a one-shot history fetch — meaning new messages the
  // user sends never appear until they reload.
  let s = getSession(id);
  if (!s) {
    const project = url.searchParams.get("project");
    const task = url.searchParams.get("task");
    if (project !== null && task !== null) {
      s = (await restoreSession(project, task, id)) ?? undefined;
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

      // Replay recent history so new clients see the transcript.
      // Send metadata first so client knows total count and can load more.
      const total = s.history.length;
      const startIdx = Math.max(0, total - initialLimit);
      const initialHistory = s.history.slice(startIdx);
      const hasMore = startIdx > 0;

      sendEvent("state", { state: s.state });
      // Send history metadata so client can implement "load more"
      sendEvent("history_meta", { total, loaded: initialHistory.length, hasMore, offset: total - initialHistory.length });
      for (const msg of initialHistory) sendEvent("message", msg);

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

      // Replay the current inline-preview binding (if any).
      const ps = getPreviewSession(id);
      if (ps) sendEvent("preview_session", ps);

      const onEvent = (msg: unknown) => sendEvent("message", msg);
      const onState = (state: string) => sendEvent("state", { state });
      const onFileChanged = (data: { path: string }) => sendEvent("file_changed", data);
      const onPermissionRequest = (data: unknown) => sendEvent("permission_request", data);
      const onPermissionResolved = (data: unknown) => sendEvent("permission_resolved", data);
      const onQuestionRequest = (data: unknown) => sendEvent("question_request", data);
      const onQuestionResolved = (data: unknown) => sendEvent("question_resolved", data);
      const onCompletionRequest = (data: unknown) => sendEvent("completion_request", data);
      const onCompletionResolved = (data: unknown) => sendEvent("completion_resolved", data);
      const onCompletedChanged = (data: unknown) => sendEvent("completed_changed", data);
      const onPreviewSession = (data: unknown) => sendEvent("preview_session", data);
      s.events.on("event", onEvent);
      s.events.on("state", onState);
      s.events.on("file_changed", onFileChanged);
      s.events.on("permission_request", onPermissionRequest);
      s.events.on("permission_resolved", onPermissionResolved);
      s.events.on("question_request", onQuestionRequest);
      s.events.on("question_resolved", onQuestionResolved);
      s.events.on("completion_request", onCompletionRequest);
      s.events.on("completion_resolved", onCompletionResolved);
      s.events.on("completed_changed", onCompletedChanged);
      s.events.on("preview_session", onPreviewSession);

      const heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(": ping\n\n"));
      }, 15000);

      cleanup = () => {
        clearInterval(heartbeat);
        s.events.off("event", onEvent);
        s.events.off("state", onState);
        s.events.off("file_changed", onFileChanged);
        s.events.off("permission_request", onPermissionRequest);
        s.events.off("permission_resolved", onPermissionResolved);
        s.events.off("question_request", onQuestionRequest);
        s.events.off("question_resolved", onQuestionResolved);
        s.events.off("completion_request", onCompletionRequest);
        s.events.off("completion_resolved", onCompletionResolved);
        s.events.off("completed_changed", onCompletedChanged);
        s.events.off("preview_session", onPreviewSession);
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
}
