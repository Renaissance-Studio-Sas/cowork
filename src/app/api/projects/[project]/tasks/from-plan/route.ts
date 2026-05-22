import { NextResponse } from "next/server";
import { createTask } from "@/lib/fs";

export const runtime = "nodejs";

// Materializes a (possibly edited) task proposal from the "New task" planning
// chat. The chat runs as a normal project-level session, so we just create the
// task — the session stays at the project level (it can keep advising the user
// after acceptance if they want to refine more).
export async function POST(req: Request, ctx: { params: Promise<{ project: string }> }) {
  const { project } = await ctx.params;
  const body = await req.json();
  const slug: string = body.slug;
  const description: string = body.description ?? "";

  if (!slug || typeof slug !== "string") {
    return NextResponse.json({ error: "slug required" }, { status: 400 });
  }

  try {
    const task = await createTask(project, slug, description);
    return NextResponse.json({ ok: true, slug: task.slug });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}
