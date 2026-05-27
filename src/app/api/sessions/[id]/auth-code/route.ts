import { NextResponse } from "next/server";
import { relayRemoteRunner } from "@/lib/sessions";

export const runtime = "nodejs";

// Forward an OAuth code the user pasted in the chat UI into the runner's
// `claude setup-token` subprocess. On success the runner writes
// `.credentials.json` into the bind-mounted ~/.claude (so all future
// containers inherit auth too) and restarts the SDK with the cached first
// message — events resume on the existing SSE stream.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({})) as { code?: string };
  if (typeof body.code !== "string" || !body.code.trim()) {
    return NextResponse.json({ error: "missing `code`" }, { status: 400 });
  }
  const r = await relayRemoteRunner(id, "/auth-code", { code: body.code.trim() });
  if (!r) {
    return NextResponse.json(
      { error: "session is not remote, not live, or doesn't support runner relay" },
      { status: 404 },
    );
  }
  return NextResponse.json(r.body, { status: r.status });
}
