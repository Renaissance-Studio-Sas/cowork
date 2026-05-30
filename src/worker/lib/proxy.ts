import type { Context } from "hono";

// Bindings every proxied route needs. BACKEND_URL is the origin of the cloud
// backend that owns the Node/filesystem/agent logic (the old Next handlers run
// there unchanged). It's a Worker `var` — set per-environment in wrangler.jsonc
// or via `wrangler secret`/dashboard. See MIGRATION.md.
export type ProxyBindings = {
  BACKEND_URL?: string;
};

// Forward the current request to the cloud backend, preserving method, path,
// query string, headers, and body. The upstream response body is streamed
// straight back (no buffering), so Server-Sent Events (text/event-stream) and
// large file downloads pass through unbuffered.
//
// Every mirrored route in src/worker/routes/* delegates here; the path the
// backend sees is identical to the path the client requested, so the backend
// keeps its existing /api/** routing.
export async function proxy(c: Context<{ Bindings: ProxyBindings }>): Promise<Response> {
  const backend = c.env.BACKEND_URL;
  if (!backend) {
    // Not wired up yet — clearer than a generic 500 and distinct from the
    // backend itself being down (502 below).
    return c.json(
      { error: "BACKEND_URL is not configured on the Worker (see MIGRATION.md)" },
      503,
    );
  }

  const incoming = new URL(c.req.url);
  const target = new URL(incoming.pathname + incoming.search, backend);

  const init: RequestInit = {
    method: c.req.method,
    headers: c.req.raw.headers,
    // Don't auto-follow backend redirects — let the client see them verbatim.
    redirect: "manual",
  };
  // GET/HEAD carry no body. For everything else, stream the request body
  // through; `duplex: "half"` is required to send a streaming body on Workers.
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    init.body = c.req.raw.body;
    (init as RequestInit & { duplex?: "half" }).duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    return c.json({ error: `Backend unreachable: ${String(err)}` }, 502);
  }

  // Stream the response straight back. Reusing upstream.headers keeps
  // Content-Type (incl. text/event-stream), Cache-Control, etc. intact.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}
