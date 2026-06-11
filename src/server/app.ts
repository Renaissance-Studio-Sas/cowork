import { Hono } from "hono";
import { comments } from "./routes/comments";
import { workspace } from "./routes/workspace";
import { files } from "./routes/files";
import { plan } from "./routes/plan";
import { fileEvents } from "./routes/file-events";
import { workspaces } from "./routes/workspaces";
import { sessions } from "./routes/sessions";
import { listDefaultModels } from "@/lib/sessions";

// Builds the Node Hono app with the API mounted under /api/*. Kept separate from
// the server entry (index.ts) so the route tree can be imported in tests or
// reused without starting a listener.
//
// Same paths/methods as src/worker/routes/* (the verified contract), but these
// modules run the real src/lib logic instead of proxying to a remote backend.
export function api(): Hono {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true, service: "cowork" }));

  // Models offered in the new-session composer, before any session exists. The
  // mid-session switcher uses /api/sessions/:id/models (the runtime's live list)
  // instead.
  app.get("/api/models", (c) => c.json({ models: listDefaultModels() }));

  app.route("/api/comments", comments);
  app.route("/api/workspace", workspace);
  app.route("/api/files", files);
  app.route("/api/plan", plan);
  app.route("/api/file-events", fileEvents);
  // The recursive workspace model replaces the old (project, task) pair. The
  // routes accept the slug-chain as a splat (URL-encoded segments joined with
  // `/`), so e.g. POST /api/workspaces/HR creates a child under HR.
  app.route("/api/workspaces", workspaces);
  app.route("/api/sessions", sessions);

  // Unknown /api path → 404 (don't fall through to the SPA shell, which would
  // 200 with HTML and mask the bug).
  app.all("/api/*", (c) => c.json({ error: "Unknown API route" }, 404));

  return app;
}
