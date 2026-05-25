import { NextResponse } from "next/server";
import { createTask } from "@/lib/fs";
import { markSessionCompleted, moveSessionToTask } from "@/lib/sessions";

export const runtime = "nodejs";

// Materializes a (possibly edited) task proposal from the "New task" planning
// chat. The planning session is created at the project level; on accept we
// create the task, then move that session inside it and mark it completed so
// the planning conversation lives with the task it produced.
export async function POST(req: Request, ctx: { params: Promise<{ project: string }> }) {
  const { project } = await ctx.params;
  const body = await req.json();
  const slug: string = body.slug;
  const overview: string = body.overview ?? "";
  const details: string = body.details ?? "";
  const sessionId: string | undefined = body.session_id;

  if (!slug || typeof slug !== "string") {
    return NextResponse.json({ error: "slug required" }, { status: 400 });
  }

  try {
    const task = await createTask(project, slug, { overview, details });
    if (sessionId) {
      await moveSessionToTask(sessionId, task.slug);
      await markSessionCompleted(project, task.slug, sessionId, true);
    }
    return NextResponse.json({ ok: true, slug: task.slug });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}
