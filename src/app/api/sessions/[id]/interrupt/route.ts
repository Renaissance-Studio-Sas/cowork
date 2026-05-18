import { NextResponse } from "next/server";
import { interrupt } from "@/lib/sessions";

export const runtime = "nodejs";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ok = await interrupt(id);
  if (!ok) return NextResponse.json({ error: "session not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
