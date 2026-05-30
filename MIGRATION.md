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

### Phase 1 — frontend
- [ ] Port `app/layout.tsx` → `index.html` `<head>` + `App.tsx` shell (`<Providers>`).
- [ ] Map the 3 page shapes + redirect-only deep links into react-router.
- [ ] Replace `next/link`, `next/navigation` (`useRouter`/`usePathname`/
      `useSearchParams`/`redirect`) usages with react-router equivalents.
- [ ] Replace any `next/*` imports across `components/` and `lib/`.
- [ ] Wire Tailwind v4 via `@tailwindcss/vite`; drop `postcss.config.mjs`.

### Phase 2 — API (Hono on the Worker)
- [ ] Port each `app/api/**/route.ts` into `src/worker/routes/*`. The handlers
      are already Web-standard `Request`/`Response`, so bodies port almost
      verbatim; swap `NextResponse.json` → `c.json`, read params from Hono.
- [ ] Storage/agent-dependent routes (`sessions/*`, `files/*`, `comments`,
      `plan`, `workspace`) → call the remote cloud backend; mark `// TODO(cloud)`.
- [ ] Port SSE routes (`sessions/:id/stream`, `file-events/stream`) using
      Hono's `streamSSE` against the remote event source.

### Phase 3 — cutover
- [ ] Delete `src/app/`, `next.config.ts`, `next-env.d.ts`, `.next/`, Next deps.
- [ ] `vite build` clean; `wrangler deploy` dry-run clean.
- [ ] Update `CLAUDE.template.md` / docs for the new dev + deploy commands.

## Dev / deploy commands (target)

- `npm run dev`    — Vite dev server with the Worker running in-process.
- `npm run build`  — `vite build` (client assets + worker bundle).
- `npm run deploy` — `wrangler deploy`.
- `npm run preview`— `wrangler dev` against the built output.
