import { NextResponse } from "next/server";
import { createTask, getProject, renameProject, setProjectBrief } from "@/lib/fs";
import { markSessionCompleted } from "@/lib/sessions";

export const runtime = "nodejs";

// Materializes a (possibly edited) plan from the "New project" planning chat.
// The chat runs in a normal project-level session inside a stub project
// (created by /api/plan). On accept, we rename the stub to the chosen slug,
// fill in the project brief (overview + details), create the proposed
// tasks, and mark the planning session completed. The session naturally
// moves with the renamed project folder.
export async function POST(req: Request) {
  const body = await req.json();
  const currentSlug: string = body.current_slug;
  const newSlug: string = body.slug;
  const overview: string = body.overview ?? "";
  const details: string = body.details ?? "";
  const tasks: Array<{ slug: string; overview?: string; details?: string }> = body.tasks ?? [];
  const sessionId: string | undefined = body.session_id;

  if (!currentSlug || typeof currentSlug !== "string") {
    return NextResponse.json({ error: "current_slug required" }, { status: 400 });
  }
  if (!newSlug || typeof newSlug !== "string") {
    return NextResponse.json({ error: "slug required" }, { status: 400 });
  }

  try {
    const existing = await getProject(currentSlug);
    if (!existing) {
      return NextResponse.json({ error: `unknown project ${currentSlug}` }, { status: 404 });
    }

    if (newSlug !== currentSlug) {
      await renameProject(currentSlug, newSlug);
    }
    await setProjectBrief(newSlug, { overview, details });
    for (const t of tasks) {
      if (!t.slug) continue;
      await createTask(newSlug, t.slug, { overview: t.overview ?? "", details: t.details ?? "" });
    }
    if (sessionId) {
      await markSessionCompleted(newSlug, "", sessionId, true);
    }
    return NextResponse.json({ ok: true, slug: newSlug });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}
