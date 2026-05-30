import { Hono } from "hono";

// The Cloudflare Worker entry. Hosts the API under /api/*; everything else is
// served as a static SPA asset by the Workers `assets` binding (configured in
// wrangler.jsonc), so this Worker only runs for API requests.
//
// Per-group route modules are ported from the old `src/app/api/**/route.ts`
// into `src/worker/routes/*` during Phase 2 (see MIGRATION.md) and mounted here:
//
//   import { comments } from "./routes/comments";
//   app.route("/api/comments", comments);
//
// Handlers there will largely reuse the existing Web-standard Request/Response
// bodies; storage/agent-dependent endpoints proxy to the cloud backend.

type Bindings = {
  // Add Cloudflare bindings (R2/KV/D1, service bindings to the cloud backend)
  // here as Phase 2 lands them.
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/api/health", (c) => c.json({ ok: true, service: "cowork" }));

// Anything under /api that hasn't been ported yet returns a clear 501 rather
// than falling through to the SPA shell.
app.all("/api/*", (c) =>
  c.json({ error: "Not implemented on the Worker yet (see MIGRATION.md)" }, 501),
);

export default app;
