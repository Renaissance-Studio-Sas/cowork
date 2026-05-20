import { NextResponse } from "next/server";
import { injectSystemMessage } from "@/lib/sessions";

export const runtime = "nodejs";

// Inject a system message into the session's event stream. Used for
// confirmation messages (e.g., when a plan is approved).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json() as { message?: string };

  if (!body.message || typeof body.message !== "string") {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  const ok = injectSystemMessage(id, body.message);
  if (!ok) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
