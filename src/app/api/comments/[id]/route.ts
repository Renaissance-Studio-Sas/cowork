import { NextResponse } from "next/server";
import { deleteComment, setResolved, updateComment } from "@/lib/comments-store";

export const runtime = "nodejs";

// The store is keyed by (project, task, id) but our existing API URLs only
// carry `id`. The caller must include project + task in the query string so
// we know which project/task's `.comments.json` to mutate.
// Task is optional — empty string means project-level comments.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const project = url.searchParams.get("project") ?? "";
  const task = url.searchParams.get("task") ?? "";  // empty = project-level
  if (!project) {
    return NextResponse.json({ error: "project required (querystring)" }, { status: 400 });
  }
  const removed = await deleteComment(project, task, Number(id));
  if (!removed) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const project = url.searchParams.get("project") ?? "";
  const task = url.searchParams.get("task") ?? "";  // empty = project-level
  if (!project) {
    return NextResponse.json({ error: "project required (querystring)" }, { status: 400 });
  }
  const body = await req.json();

  // Handle body update
  if (typeof body.body === "string") {
    const updated = await updateComment(project, task, Number(id), body.body);
    if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true, comment: updated });
  }

  // Handle resolved status
  if (body.resolved === true) await setResolved(project, task, Number(id), true);
  else if (body.resolved === false) await setResolved(project, task, Number(id), false);
  return NextResponse.json({ ok: true });
}
