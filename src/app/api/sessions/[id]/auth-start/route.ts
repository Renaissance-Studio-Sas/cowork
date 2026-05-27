import { NextResponse } from "next/server";
import { relayRemoteRunner } from "@/lib/sessions";

export const runtime = "nodejs";

// Trigger the runner's `claude setup-token` flow proactively. Used by the UI
// when the user types `/login` even though no auth error has fired yet — e.g.
// to refresh credentials or after a re-auth on the host side.
//
// Auto-triggered auth (when the SDK throws "Not logged in") happens entirely
// inside the runner without this route — the SSE stream gets the
// `auth_required` event directly.
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await relayRemoteRunner(id, "/auth-start", {});
  if (!r) {
    return NextResponse.json(
      { error: "session is not remote, not live, or doesn't support runner relay" },
      { status: 404 },
    );
  }
  return NextResponse.json(r.body, { status: r.status });
}
