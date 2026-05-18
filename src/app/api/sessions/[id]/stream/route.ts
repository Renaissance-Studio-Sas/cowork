import { getSession } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const s = getSession(id);
  if (!s) return new Response("not found", { status: 404 });

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

      // Replay history so new clients see the full transcript.
      sendEvent("state", { state: s.state });
      for (const msg of s.history) sendEvent("message", msg);

      const onEvent = (msg: unknown) => sendEvent("message", msg);
      const onState = (state: string) => sendEvent("state", { state });
      const onFileChanged = (data: { path: string }) => sendEvent("file_changed", data);
      s.events.on("event", onEvent);
      s.events.on("state", onState);
      s.events.on("file_changed", onFileChanged);

      const heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(": ping\n\n"));
      }, 15000);

      cleanup = () => {
        clearInterval(heartbeat);
        s.events.off("event", onEvent);
        s.events.off("state", onState);
        s.events.off("file_changed", onFileChanged);
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
