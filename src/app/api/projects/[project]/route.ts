import { NextResponse } from "next/server";
import { deleteProject, getProject, renameProject, setProjectStatus } from "@/lib/fs";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ project: string }> }) {
  const { project } = await ctx.params;
  const p = await getProject(project);
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(p);
}

export async function PATCH(req: Request, ctx: { params: Promise<{ project: string }> }) {
  const { project } = await ctx.params;
  const body = await req.json();
  try {
    if (body.status && (body.status === "wip" || body.status === "done")) {
      await setProjectStatus(project, body.status);
    }
    if (typeof body.slug === "string" && body.slug !== project) {
      await renameProject(project, body.slug);
      return NextResponse.json({ ok: true, slug: body.slug });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ project: string }> }) {
  const { project } = await ctx.params;
  try {
    await deleteProject(project);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}
