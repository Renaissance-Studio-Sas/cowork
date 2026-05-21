import { NextResponse } from "next/server";
import { createTask } from "@/lib/fs";
import { adoptSessionToTask } from "@/lib/sessions";

export const runtime = "nodejs";

// Materializes a (possibly edited) task proposal from the New Task chat into
// a real task on disk under the given project. If a `session_id` is passed,
// the planning chat that produced this task is also promoted into the new
// task's sessions/ folder so the conversation is preserved as a record.
export async function POST(req: Request, ctx: { params: Promise<{ project: string }> }) {
  const { project } = await ctx.params;
  const body = await req.json();
  const slug: string = body.slug;
  const description: string = body.description ?? "";
  const sessionId: string | undefined = body.session_id;

  if (!slug || typeof slug !== "string") {
    return NextResponse.json({ error: "slug required" }, { status: 400 });
  }

  try {
    const task = await createTask(project, slug, description);
    if (sessionId) {
      await adoptSessionToTask(sessionId, project, task.slug);
    }
    return NextResponse.json({ ok: true, slug: task.slug });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}
