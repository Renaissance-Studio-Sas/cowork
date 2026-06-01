import { Hono } from "hono";
import { proxy, type ProxyBindings } from "../lib/proxy";

// Mirrors src/server/routes/comments.ts. Comment storage lives in the cloud
// backend (per-workspace `.comments.json` files), so every endpoint is
// forwarded. The workspace identifier travels as a `workspace=` query param —
// the proxy preserves the query string verbatim, so no Worker-side logic is
// needed beyond the static method/path mapping.
export const comments = new Hono<{ Bindings: ProxyBindings }>();

// Static path before the param route so `/counts` never matches `/:id`.
comments.get("/counts", proxy); // GET    /api/comments/counts

comments.get("/", proxy); //         GET    /api/comments
comments.post("/", proxy); //        POST   /api/comments

comments.delete("/:id", proxy); //   DELETE /api/comments/:id
comments.patch("/:id", proxy); //    PATCH  /api/comments/:id
