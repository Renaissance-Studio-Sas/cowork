import { Hono } from "hono";
import { comments } from "./routes/comments";
import { workspace } from "./routes/workspace";
import { files } from "./routes/files";
import { plan } from "./routes/plan";
import { fileEvents } from "./routes/file-events";
import { projects } from "./routes/projects";
import { sessions } from "./routes/sessions";

// Builds the Node Hono app with the API mounted under /api/*. Kept separate from
// the server entry (index.ts) so the route tree can be imported in tests or
// reused without starting a listener.
//
// Same paths/methods as src/worker/routes/* (the verified contract), but these
// modules run the real src/lib logic instead of proxying to a remote backend.
export function api(): Hono {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true, service: "cowork" }));

  app.route("/api/comments", comments);
  app.route("/api/workspace", workspace);
  app.route("/api/files", files);
  app.route("/api/plan", plan);
  app.route("/api/file-events", fileEvents);
  app.route("/api/projects", projects);
  app.route("/api/sessions", sessions);

  // Unknown /api path → 404 (don't fall through to the SPA shell, which would
  // 200 with HTML and mask the bug).
  app.all("/api/*", (c) => c.json({ error: "Unknown API route" }, 404));

  return app;
}
