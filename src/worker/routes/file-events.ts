import { Hono } from "hono";
import { proxy, type ProxyBindings } from "../lib/proxy";

// Mirrors src/server/routes/file-events.ts — a Server-Sent Events stream of
// file changes and open-artifact requests, scoped to one workspace at a time
// (passed via `workspace=` query). The proxy streams text/event-stream
// unbuffered so the SSE flows verbatim.
export const fileEvents = new Hono<{ Bindings: ProxyBindings }>();

fileEvents.get("/stream", proxy); // GET /api/file-events/stream
