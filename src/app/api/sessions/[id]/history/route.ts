import { NextResponse } from "next/server";
import { readSessionHistory } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const task = url.searchParams.get("task");
  // task can be empty string for project-level sessions, but project is required
  if (!project || task === null || task === undefined) {
    return NextResponse.json({ error: "project, task required" }, { status: 400 });
  }

  // Pagination parameters for lazy loading
  // limit: how many messages to return (default: all)
  // offset: skip this many messages from the END (for loading older messages)
  // When offset=0, limit=50: returns the last 50 messages
  // When offset=50, limit=50: returns messages 50-100 from the end (older)
  const limitStr = url.searchParams.get("limit");
  const offsetStr = url.searchParams.get("offset");
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;
  const offset = offsetStr ? parseInt(offsetStr, 10) : 0;

  const result = await readSessionHistory(project, task, id, limit, offset);
  if (!result) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(result);
}
