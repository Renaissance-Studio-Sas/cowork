import { NextResponse } from "next/server";
import { deleteComment, setResolved } from "@/lib/comments-store";

export const runtime = "nodejs";

// The store is keyed by (project, task, id) but our existing API URLs only
// carry `id`. The caller must include project + task in the query string so
// we know which task's `.comments.json` to mutate.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const project = url.searchParams.get("project") ?? "";
  const task = url.searchParams.get("task") ?? "";
  if (!project || !task) {
    return NextResponse.json({ error: "project, task required (querystring)" }, { status: 400 });
  }
  const removed = await deleteComment(project, task, Number(id));
  if (!removed) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const project = url.searchParams.get("project") ?? "";
  const task = url.searchParams.get("task") ?? "";
  if (!project || !task) {
    return NextResponse.json({ error: "project, task required (querystring)" }, { status: 400 });
  }
  const body = await req.json();
  if (body.resolved === true) await setResolved(project, task, Number(id), true);
  else if (body.resolved === false) await setResolved(project, task, Number(id), false);
  return NextResponse.json({ ok: true });
}
