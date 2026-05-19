import { subscribeFileChanges } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Multiplexed file_changed stream. One connection per (project, task) instead
// of one per live session — browsers cap concurrent HTTP/1.1 connections at
// ~6, so opening an SSE per session exhausted the pool when a task had
// multiple live sessions.
export async function GET(req: Request) {
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

      const unsubscribe = subscribeFileChanges(project, task, (data) => {
        sendEvent("file_changed", data);
      });

      const heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(": ping\n\n"));
      }, 15000);

      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
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
}
