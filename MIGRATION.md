# Next.js → Hono + Vite (Cloudflare) migration

Branch: `hono-vite-migration`

## Goal

Replace the Next.js App Router app with:

- **Vite + React 19** — the frontend, built as a static SPA.
- **Hono** — the API layer, running on a **Cloudflare Worker**.
- **Cloudflare** deploy via `@cloudflare/vite-plugin` + `wrangler` (one `wrangler deploy`
  ships the Worker and serves the SPA assets).

The Claude/Gemini **agent execution processes are being migrated to the cloud
independently**. This migration therefore does NOT try to run the agent SDKs,
`child_process` spawning, native `node-pty`/`better-sqlite3`, or local
filesystem session state on Cloudflare. Those backend concerns are reached over
the network via the existing `src/lib/runtimes/remote.ts` path. Anything that
still hard-depends on the local Node runtime is marked `// TODO(cloud)` and
proxied/stubbed until the cloud backend lands.

## Current shape (Next App Router)

- 99 files under `src/`. Routing is already **query-param driven** — see
  `src/lib/routes.ts`. There are only three real page shapes:
  - `/` → Welcome (`src/app/page.tsx`)
  - `/project/:slug` → Workspace
  - `/project/:slug/task/:taskSlug` → Workspace
  - The `dir/[...path]`, `file/[...path]`, `session/[sessionId]` segments are
    **redirect-only** legacy deep links (preserve as redirects).
- 35 API routes under `src/app/api/**/route.ts` (`comments`, `files`, `plan`,
  `projects/*`, `sessions/*`, `workspace`, `file-events/stream`). Every one
  declares `export const runtime = "nodejs"`.
- No server actions, no middleware, no `next/image`/`next/font`/`next/dynamic`.
  Only Next-specific bits: `metadata` in the root layout and
  `serverExternalPackages` in `next.config.ts`. **UI migration friction is low**;
  the work is the API/runtime layer.

## Target layout

```
index.html                 # SPA entry
vite.config.ts             # react + tailwind v4 + cloudflare plugins
wrangler.jsonc             # Worker + static assets config
src/
  client/
    main.tsx               # React root
    App.tsx                # react-router routes (3 real + redirects)
  worker/
    index.ts               # Hono app; mounts /api/* routes
    routes/                # one module per API group, ported from app/api/**
  components/              # (unchanged — already mostly 'use client')
  lib/                    # (unchanged where browser-safe; node-only → TODO(cloud))
  app/                    # DELETED once every page + route is ported
```

## Plan / checklist

### Phase 0 — scaffold (this commit)
- [x] Create branch.
- [x] Add `vite.config.ts`, `wrangler.jsonc`, `index.html`.
- [x] Add `src/client/{main,App}.tsx` SPA bootstrap with react-router.
- [x] Add `src/worker/index.ts` Hono app with health check + `/api` mount point.
- [x] Update `package.json` scripts/deps; update `tsconfig`.

### Phase 1 — frontend ✅
- [x] Port `app/layout.tsx` → `index.html` `<head>` + `App.tsx` shell (`<Providers>`).
- [x] Map the 3 page shapes + redirect-only deep links into react-router.
- [x] Replace `next/link`, `next/navigation` (`useRouter`/`usePathname`/
      `useSearchParams`/`redirect`) usages with react-router equivalents — done via
      the `@/lib/navigation` compat shim (smaller diff than rewriting call sites).
- [x] Replace any `next/*` imports across `components/` and `lib/` (none remain).
- [x] Wire Tailwind v4 via `@tailwindcss/vite` (globals.css already used the v4
      `@import "tailwindcss"` form). `postcss.config.mjs` left in place for the
      still-present Next pages; dropped in Phase 3 cutover.
- [x] SPA deep-link fallback: Worker serves `index.html` via the ASSETS binding.

### Phase 2 — API (Hono on the Worker) ✅
All 35 routes mirror the old `app/api/**/route.ts` tree as a per-route proxy.
Since the Node/fs/agent logic moves to the cloud independently, none of the
handlers run on the Worker — each forwards to a configurable `BACKEND_URL`.
- [x] Mirror every `app/api/**/route.ts` in `src/worker/routes/*` (explicit
      method + path; static segments before param routes). The bodies aren't
      reimplemented — they forward, so the cloud backend keeps the Next handlers.
- [x] Storage/agent-dependent routes (`sessions/*`, `files/*`, `comments`,
      `plan`, `workspace`, `projects/*`) → forward to the cloud backend via
      `src/worker/lib/proxy.ts`. `BACKEND_URL` unset → 503; unreachable → 502.
- [x] SSE routes (`sessions/:id/stream`, `file-events/stream`) — the proxy
      streams `text/event-stream` (and uploads/downloads) through unbuffered, so
      no separate `streamSSE` handler is needed while proxying.
- [x] `run_worker_first: ["/api/*"]` so the assets layer doesn't rewrite
      Worker 404s → 200 (would mask real backend 404s).

NOTE: per-route modules exist precisely so individual endpoints can later be
reimplemented to run natively on the Worker (R2/D1/KV) instead of proxying, if
parts of the backend move onto Cloudflare.

### Phase 3 — cutover
- [ ] Delete `src/app/`, `next.config.ts`, `next-env.d.ts`, `.next/`, Next deps.
- [ ] `vite build` clean; `wrangler deploy` dry-run clean.
- [ ] Update `CLAUDE.template.md` / docs for the new dev + deploy commands.

## Dev / deploy commands (target)

- `npm run dev`    — Vite dev server with the Worker running in-process.
- `npm run build`  — `vite build` (client assets + worker bundle).
- `npm run deploy` — `wrangler deploy`.
- `npm run preview`— `wrangler dev` against the built output.
