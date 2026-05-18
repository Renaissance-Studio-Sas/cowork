import { NextResponse } from "next/server";
import { createProject, createTask } from "@/lib/fs";
import { adoptSessionToProject } from "@/lib/sessions";

export const runtime = "nodejs";

// Materializes a (possibly edited) plan from the New Project chat into a real
// project + tasks on disk. If a `session_id` is passed, the planning chat
// that produced this plan is also promoted into the new project's
// sessions/ folder so the conversation is preserved as a record.
export async function POST(req: Request) {
  const body = await req.json();
  const slug: string = body.slug;
  const description: string = body.description ?? "";
  const tasks: Array<{ slug: string; description?: string }> = body.tasks ?? [];
  const sessionId: string | undefined = body.session_id;

  if (!slug || typeof slug !== "string") {
    return NextResponse.json({ error: "slug required" }, { status: 400 });
  }

  try {
    const project = await createProject(slug, description);
    for (const t of tasks) {
      if (!t.slug) continue;
      await createTask(project.slug, t.slug, t.description ?? "");
    }
    if (sessionId) {
      await adoptSessionToProject(sessionId, project.slug);
    }
    return NextResponse.json({ ok: true, slug: project.slug });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}
