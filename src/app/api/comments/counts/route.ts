import { NextResponse } from "next/server";
import { commentCounts } from "@/lib/comments-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const task = url.searchParams.get("task");
  if (!project || !task) {
    return NextResponse.json({ error: "project, task required" }, { status: 400 });
  }
  const counts = await commentCounts(project, task);
  return NextResponse.json({ counts });
}
