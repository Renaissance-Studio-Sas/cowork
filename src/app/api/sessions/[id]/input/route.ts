import { NextResponse } from "next/server";
import { sendInput, getSession, restoreSession } from "@/lib/sessions";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json();
  if (!body.message || typeof body.message !== "string") {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  // If session isn't in memory, try to restore it from disk
  if (!getSession(id)) {
    const projectSlug = body.projectSlug as string | undefined;
    const taskSlug = body.taskSlug as string | undefined;
    if (projectSlug !== undefined && taskSlug !== undefined) {
      await restoreSession(projectSlug, taskSlug, id);
    }
  }

  const ok = await sendInput(id, body.message);
  if (!ok) return NextResponse.json({ error: "session not found or failed to resume" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
