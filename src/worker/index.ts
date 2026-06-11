import { Hono } from "hono";
import { proxy, type ProxyBindings } from "./lib/proxy";
import { comments } from "./routes/comments";
import { workspace } from "./routes/workspace";
import { files } from "./routes/files";
import { plan } from "./routes/plan";
import { fileEvents } from "./routes/file-events";
import { workspaces } from "./routes/workspaces";
import { sessions } from "./routes/sessions";

// The Cloudflare Worker entry. Hosts the API under /api/*; everything else is a
// client route served by the static SPA. Cloudflare checks static assets first,
// so this Worker only runs for /api/* and for non-file paths (deep links like
// /project/foo) — which we hand back to the ASSETS binding so it returns the SPA
// shell (index.html) and react-router takes over on the client.
//
// The 35 API routes mirror the old src/app/api/**/route.ts tree (see
// MIGRATION.md). The Node/filesystem/agent logic can't run on a Worker, so each
// route forwards to the cloud backend (BACKEND_URL) via the streaming proxy.
// The route modules are declared explicitly (method + path) rather than a blind
// catch-all, so every endpoint is visible and individually editable — e.g. to
// later run natively on the Worker against R2/D1/KV instead of proxying.

type Bindings = ProxyBindings & {
  // The static-assets binding (configured in wrangler.jsonc). Used to serve the
  // SPA shell for client-side routes that aren't physical files.
  ASSETS: { fetch: (req: Request) => Promise<Response> };
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/api/health", (c) => c.json({ ok: true, service: "cowork" }));

// Models for the new-session composer's picker — forwarded to the backend's
// static list (mirrors src/server/app.ts).
app.get("/api/models", proxy);

app.route("/api/comments", comments);
app.route("/api/workspace", workspace);
app.route("/api/files", files);
app.route("/api/plan", plan);
app.route("/api/file-events", fileEvents);
// The recursive workspace model replaces the old (project, task) pair. Splat
// captures the slug-chain so e.g. /api/workspaces/HR/pay-contractors reaches
// the nested workspace on the backend without rewriting.
app.route("/api/workspaces", workspaces);
app.route("/api/sessions", sessions);

// Any /api path not matched above is genuinely unknown — return 404 rather than
// falling through to the SPA shell (which would 200 with HTML and mask the bug).
app.all("/api/*", (c) => c.json({ error: "Unknown API route" }, 404));

// Non-API, non-file request (a react-router deep link). Serve the SPA shell.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
