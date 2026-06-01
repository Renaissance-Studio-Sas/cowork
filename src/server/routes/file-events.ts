import { Hono } from "hono";
import { subscribeFileChanges, subscribeOpenArtifact } from "@/lib/sessions";
import { decodeWorkspacePath } from "@/lib/routes";

export const fileEvents = new Hono();

// Multiplexed file_changed + open_artifact stream. One connection per workspace
// instead of one per live session — browsers cap concurrent HTTP/1.1
// connections at ~6, so opening an SSE per session exhausted the pool when a
// workspace had multiple live sessions.
//
// Workspace is passed as `workspace=` query param (slug-chain, URI-encoded
// per segment, joined with `/`).
fileEvents.get("/stream", async (c) => {
  const req = c.req.raw;
  const url = new URL(req.url);
  const workspaceRaw = url.searchParams.get("workspace") ?? "";
  if (!workspaceRaw) return new Response("missing workspace", { status: 400 });
  const workspacePath = decodeWorkspacePath(workspaceRaw);

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

      const unsubscribeFiles = subscribeFileChanges(workspacePath, (data: { path: string; sessionId: string }) => {
        sendEvent("file_changed", data);
      });
      const unsubscribeOpen = subscribeOpenArtifact(workspacePath, (data: { path: string; sessionId: string }) => {
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
