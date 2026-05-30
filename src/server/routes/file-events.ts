import { Hono } from "hono";
import { subscribeFileChanges, subscribeOpenArtifact } from "@/lib/sessions";

export const fileEvents = new Hono();

// Multiplexed file_changed stream. One connection per (project, task) instead
// of one per live session — browsers cap concurrent HTTP/1.1 connections at
// ~6, so opening an SSE per session exhausted the pool when a task had
// multiple live sessions.
fileEvents.get("/stream", async (c) => {
  const req = c.req.raw;
  const url = new URL(req.url);
  const project = url.searchParams.get("project") ?? "";
  const task = url.searchParams.get("task") ?? "";
  if (!project) return new Response("missing project", { status: 400 });

  const encoder = new TextEncoder();
  let cleanup: () => void = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (chunk: Uint8Array) => {
        try { controller.enqueue(chunk); } catch { /* closed */ }
      };
      const sendEvent = (event: string, data: unknown) => {
        safeEnqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const unsubscribeFiles = subscribeFileChanges(project, task, (data) => {
        sendEvent("file_changed", data);
      });
      const unsubscribeOpen = subscribeOpenArtifact(project, task, (data) => {
        sendEvent("open_artifact", data);
      });

      const heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(": ping\n\n"));
      }, 15000);

      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribeFiles();
        unsubscribeOpen();
        try { controller.close(); } catch { /* already closed */ }
      };

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
