// Worker entry. Auth is a simple shared bearer token for now (no OAuth yet):
// every request to /mcp must carry `Authorization: Bearer <API_TOKEN>`.
//
// The token identifies a single tenant ("default"). An optional `X-Tenant-Id`
// header namespaces profiles / sessions / R2 keys, so one token can still drive
// separate, fully-isolated browser namespaces (the DO id and R2 keys are derived
// from this tenant id — see mcp.ts / browser-session.ts). Swap this front door
// for OAuthProvider later to get real per-user Google identities.

import { BrowserMcp } from "./mcp";
import type { UserProps } from "./types";

export { BrowserMcp } from "./mcp";
export { BrowserSession } from "./browser-session";

const mcpHandler = BrowserMcp.serve("/mcp");

// Constant-time compare so the token check doesn't leak length/content by timing.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function tenantFrom(req: Request): string {
  const raw = req.headers.get("x-tenant-id") ?? "default";
  return raw.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 64) || "default";
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") return new Response("ok");

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const expected = env.API_TOKEN;
      const got = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!expected || !got || !safeEqual(got, expected)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
        });
      }
      // Hand the tenant identity to McpAgent via ctx.props (what OAuthProvider
      // would otherwise populate). Every tool reads this.props.userId for isolation.
      const tenant = tenantFrom(request);
      const props: UserProps = { userId: tenant, email: `${tenant}@api.local`, name: tenant };
      (ctx as ExecutionContext & { props?: UserProps }).props = props;
      return mcpHandler.fetch(request, env, ctx);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
