import { NextResponse } from "next/server";
import { createTask, getProject, renameProject, setProjectDescription } from "@/lib/fs";

export const runtime = "nodejs";

// Materializes a (possibly edited) plan from the "New project" planning chat.
// The chat runs in a normal project-level session inside a stub project
// (created by /api/plan). On accept, we rename the stub to the chosen slug,
// fill in the project description, and create the proposed tasks. The
// session stays where it is — it now lives inside the renamed project.
export async function POST(req: Request) {
  const body = await req.json();
  const currentSlug: string = body.current_slug;
  const newSlug: string = body.slug;
  const description: string = body.description ?? "";
  const tasks: Array<{ slug: string; description?: string }> = body.tasks ?? [];

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
    await setProjectDescription(newSlug, description);
    for (const t of tasks) {
      if (!t.slug) continue;
      await createTask(newSlug, t.slug, t.description ?? "");
    }
    return NextResponse.json({ ok: true, slug: newSlug });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}
