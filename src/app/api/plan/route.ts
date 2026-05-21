import { NextResponse } from "next/server";
import { startPlanningSession, startTaskPlanningSession } from "@/lib/sessions";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json();
  if (!body.message || typeof body.message !== "string") {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }
  // mode=task scopes the planning agent to an existing project so it can
  // propose a single new task that fits. Default (no mode) is project-level
  // planning, which proposes a new project + initial tasks.
  if (body.mode === "task") {
    if (!body.project || typeof body.project !== "string") {
      return NextResponse.json({ error: "project required for mode=task" }, { status: 400 });
    }
    try {
      const s = await startTaskPlanningSession(body.project, body.message);
      return NextResponse.json({ id: s.id });
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 400 });
    }
  }
  const s = await startPlanningSession(body.message);
  return NextResponse.json({ id: s.id });
}
