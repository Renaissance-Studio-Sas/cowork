import { NextResponse } from "next/server";
import { readSessionHistory } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const task = url.searchParams.get("task");
  if (!project || !task) {
    return NextResponse.json({ error: "project, task required" }, { status: 400 });
  }
  const result = await readSessionHistory(project, task, id);
  if (!result) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(result);
}
