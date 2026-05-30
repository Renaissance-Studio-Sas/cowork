import { Hono } from "hono";
import { proxy, type ProxyBindings } from "../lib/proxy";

// Mirrors src/app/api/file-events/stream — a Server-Sent Events stream of file
// changes from the backend. The proxy streams text/event-stream unbuffered.
export const fileEvents = new Hono<{ Bindings: ProxyBindings }>();

fileEvents.get("/stream", proxy); // GET /api/file-events/stream
