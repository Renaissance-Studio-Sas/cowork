import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "node:fs/promises";

// Load .env before importing anything that reads process.env at module-eval time
// (src/lib/fs.ts computes WORKSPACE_ROOT on import). Next.js loaded .env
// automatically; the bare Node runtime does not, so do it here. loadEnvFile
// (Node 20.12+) throws if the file is absent — that's fine in environments
// without one, so swallow it.
try {
  process.loadEnvFile();
} catch {
  // no .env present — fall back to real environment / defaults
}

const { api } = await import("./app");

// Node entry. Unlike the Cloudflare Worker (src/worker), which proxies /api/* to
// a remote backend, this runs the API HANDLERS NATIVELY on Node — calling the
// local src/lib logic directly (filesystem, session/agent spawning, SSE). That's
// what makes the app fully functional locally, exactly like the old Next.js app.
//
// Hono is runtime-agnostic: the same route modules could run here (Node) or on
// the Worker. This server mounts them via @hono/node-server.
//
// Two modes:
//   - production (NODE_ENV=production): also serves the built SPA from
//     dist/client with an index.html fallback for client-side routes. One
//     process serves everything on PORT (default 3100).
//   - dev: only serves /api — the Vite dev server (vite.config.node.ts) handles
//     the client with HMR and proxies /api here. Run both via `npm run dev`.

const isProd = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT) || (isProd ? 3100 : 8787);

const app = api();

if (isProd) {
  const clientDir = "./dist/client";
  // Serve hashed static assets (JS/CSS/images) directly.
  app.use("/*", serveStatic({ root: clientDir }));
  // SPA fallback: any non-API path that didn't match a file returns index.html
  // so react-router can handle the route on the client (deep links, refresh).
  app.get("*", async (c) => {
    const html = await readFile(`${clientDir}/index.html`, "utf8");
    return c.html(html);
  });
}

serve({ fetch: app.fetch, port }, ({ port }) => {
  const mode = isProd ? "production (SPA + API)" : "dev (API only)";
  console.log(`cowork ${mode} listening on http://localhost:${port}`);
});
