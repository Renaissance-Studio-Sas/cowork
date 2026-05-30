import { Hono } from "hono";
import { proxy, type ProxyBindings } from "../lib/proxy";

// Mirrors src/app/api/sessions/** — the largest group. Sessions are live agent
// runs owned by the backend (SDK subprocesses, in-memory event emitters), so
// every endpoint forwards. /:id/stream is the SSE transcript; the proxy streams
// it unbuffered.
export const sessions = new Hono<{ Bindings: ProxyBindings }>();

// ---- collection ---------------------------------------------------------
sessions.get("/", proxy); // GET /api/sessions

// ---- reads on a single session ------------------------------------------
sessions.get("/:id/history", proxy); // GET /api/sessions/:id/history
sessions.get("/:id/stream", proxy); //  GET /api/sessions/:id/stream  (SSE)

// ---- actions on a single session ----------------------------------------
sessions.post("/:id/auth-code", proxy); //      POST /api/sessions/:id/auth-code
sessions.post("/:id/auth-start", proxy); //     POST /api/sessions/:id/auth-start
sessions.post("/:id/complete", proxy); //       POST /api/sessions/:id/complete
sessions.post("/:id/force-stop", proxy); //     POST /api/sessions/:id/force-stop
sessions.post("/:id/inject-message", proxy); // POST /api/sessions/:id/inject-message
sessions.post("/:id/input", proxy); //          POST /api/sessions/:id/input
sessions.post("/:id/interrupt", proxy); //      POST /api/sessions/:id/interrupt
sessions.post("/:id/permission", proxy); //     POST /api/sessions/:id/permission
sessions.post("/:id/question", proxy); //       POST /api/sessions/:id/question
sessions.post("/:id/rename", proxy); //         POST /api/sessions/:id/rename
sessions.post("/:id/retry", proxy); //          POST /api/sessions/:id/retry
sessions.post("/:id/seen", proxy); //           POST /api/sessions/:id/seen

// delete supports both verbs (the UI POSTs; REST clients may DELETE).
sessions.delete("/:id/delete", proxy); // DELETE /api/sessions/:id/delete
sessions.post("/:id/delete", proxy); //   POST   /api/sessions/:id/delete
