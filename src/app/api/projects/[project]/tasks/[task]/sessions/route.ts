import { NextResponse } from "next/server";
import { startSession } from "@/lib/sessions";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ project: string; task: string }> }) {
  const { project, task } = await ctx.params;
  const body = await req.json();
  if (!body.message || typeof body.message !== "string") {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }
  try {
    const s = await startSession({
      projectSlug: project,
      taskSlug: task,
      firstMessage: body.message,
      permissionMode: body.permissionMode,
      model: body.model,
      effort: body.effort,
      runtime: body.runtime,
    });
    return NextResponse.json({ id: s.id, state: s.state });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
