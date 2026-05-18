import { NextResponse } from "next/server";
import { startPlanningSession } from "@/lib/sessions";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json();
  if (!body.message || typeof body.message !== "string") {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }
  const s = await startPlanningSession(body.message);
  return NextResponse.json({ id: s.id });
}
