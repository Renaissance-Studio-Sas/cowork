import { Hono } from "hono";
import { proxy, type ProxyBindings } from "../lib/proxy";

// Mirrors src/app/api/comments/** — comment storage lives in the cloud backend
// (per-task .comments.json files), so every endpoint is forwarded.
export const comments = new Hono<{ Bindings: ProxyBindings }>();

// Static path before the param route so `/counts` never matches `/:id`.
comments.get("/counts", proxy); // GET    /api/comments/counts

comments.get("/", proxy); //         GET    /api/comments
comments.post("/", proxy); //        POST   /api/comments

comments.delete("/:id", proxy); //   DELETE /api/comments/:id
comments.patch("/:id", proxy); //    PATCH  /api/comments/:id
