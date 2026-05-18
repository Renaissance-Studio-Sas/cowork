import { NextResponse } from "next/server";
import { createTask } from "@/lib/fs";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ project: string }> }) {
  const { project } = await ctx.params;
  const body = await req.json();
  if (!body.slug || typeof body.slug !== "string") {
    return NextResponse.json({ error: "slug required" }, { status: 400 });
  }
  const task = await createTask(project, body.slug, body.description ?? "");
  return NextResponse.json(task);
}
