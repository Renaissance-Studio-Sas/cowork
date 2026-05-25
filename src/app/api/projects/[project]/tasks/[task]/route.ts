import { NextResponse } from "next/server";
import { deleteTask, getTask, setTaskStatus, listFiles, renameTask, moveTask } from "@/lib/fs";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ project: string; task: string }> }) {
  const { project, task } = await ctx.params;
  const t = await getTask(project, task);
  if (!t) return NextResponse.json({ error: "not found" }, { status: 404 });
  const files = await listFiles(project, task);
  return NextResponse.json({ ...t, files });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ project: string; task: string }> }) {
  const { project, task } = await ctx.params;
  const body = await req.json();

  try {
    if (body.status && (body.status === "active" || body.status === "archived")) {
      await setTaskStatus(project, task, body.status);
    }

    // Move to another project (rename within new parent if needed)
    if (typeof body.project === "string" && body.project !== project) {
      const res = await moveTask(project, task, body.project);
      return NextResponse.json({ ok: true, project: res.project, task: res.task });
    }

    // Rename within the same project
    if (typeof body.slug === "string" && body.slug !== task) {
      await renameTask(project, task, body.slug);
      return NextResponse.json({ ok: true, task: body.slug });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ project: string; task: string }> }) {
  const { project, task } = await ctx.params;
  try {
    await deleteTask(project, task);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}
