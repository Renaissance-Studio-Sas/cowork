# cloud-browser-cf

Persistent-profile Chromium browsers on Cloudflare, exposed as a
**multi-tenant remote MCP server**, with no infra to babysit.

```
MCP client (Claude, etc.)
   │  remote MCP (streamable-HTTP /mcp), Bearer token
   ▼
 Worker ── Bearer-token gate  +  BrowserMcp (McpAgent DO)
   │            props.userId = tenant (X-Tenant-Id)   → the tenancy key
   ▼
 BrowserSession DO   (id = `${userId}:${profile}` → unguessable, 1 live/ profile)
   │  · ownership checks   · idle alarm() reclaim
   │  · R2 hydrate on acquire / save on release  (R2 creds stay here)
   ▼
 Container  [ Chromium + Xvnc/noVNC  +  Node agent (Playwright over localhost CDP) ]
   ▲
   └── R2: <userId>/<profile>/profile.tar.gz   (login state, cache-filtered)
```

**Why an in-container agent:** Workers can't run Playwright, and CF Containers
have no direct CDP ingress — so the driver lives in the container and the Worker
proxies coarse HTTP ops (navigate/click/screenshot) + the noVNC view. CDP never
leaves the container.

## Security model (multi-tenant)
- **AuthN (temporary):** a single shared bearer token (`API_TOKEN` secret). Every
  `/mcp` request must send `Authorization: Bearer <token>` (constant-time checked);
  no token ⇒ 401. Identity comes from an optional `X-Tenant-Id` header (default
  `default`), which becomes `props.userId`. *Swap-in path: replace `src/index.ts`
  with `@cloudflare/workers-oauth-provider` + a Google handler for real per-user
  identities — the rest of the stack is unchanged since it only reads `props.userId`.*
- **AuthZ / isolation:** DO ids and R2 keys are *derived from* `userId`, so a tenant
  can't address another tenant's session/profile even by guessing. Each driving op
  re-checks ownership in the `BrowserSession` DO.
- **Runtime isolation:** one container per session (separate sandbox); one live
  session per `(tenant, profile)`.
- **Data:** profiles encrypted at rest in R2 (SSE) under per-tenant prefixes; the
  API token + R2 creds stay in Worker bindings; CDP + noVNC never public
  (Worker-proxied, live-view URLs signed + short-lived).
- **Quotas (defaults):** 3 concurrent sessions/user, ~10 profiles/user, 20-min idle reclaim.

## Layout
- `wrangler.jsonc` — containers + DOs + R2 + migrations.
- `src/index.ts` — bearer-token front door; sets `ctx.props` then forwards to the MCP.
- `src/mcp.ts` — `BrowserMcp` (McpAgent): management + driving tools.
- `src/browser-session.ts` — `BrowserSession` Container DO: lifecycle + R2 + ownership.
- `container/` — Dockerfile + `entrypoint.sh` + `agent/agent.mjs` (in-container driver).

## Run it locally
1. `npm install`
2. `.dev.vars` holds `API_TOKEN=<value>` (a random token is fine for dev).
3. `npm run dev` — `wrangler dev` builds the container image (first build is slow)
   and serves `/mcp` at `http://127.0.0.1:8787`. Clients send `Authorization: Bearer <API_TOKEN>`.

## Deploy (needs a Containers-enabled CF account)
1. `wrangler login` on an account with the Containers entitlement + a token scoped
   for Containers/R2.
2. `wrangler r2 bucket create cloud-browser-profiles`.
3. `wrangler secret put API_TOKEN`.
4. `npm run deploy` (first container build/provision takes a few minutes).

## Status — verified locally; edge deploy gated on account
Worker bundles and typechecks clean; a full local smoke test passes: container
build → agent drives Chromium (navigate/read/evaluate/screenshot) → profile
save+hydrate → noVNC live view → `wrangler dev` serves a token-gated `/mcp` that
exposes all tools. Remaining:
- `live_view_url` token signing is a TODO; the Worker `/view` proxy route isn't written yet.
- The agent ports the core driving ops; carry over the rest (extract, request_human
  handoff UX) the same way (each maps to a `POST /<op>` on the in-container agent).
- Edge deploy needs a CF account with the Containers entitlement (Workers Paid);
  local `wrangler dev` works against local Docker today.
