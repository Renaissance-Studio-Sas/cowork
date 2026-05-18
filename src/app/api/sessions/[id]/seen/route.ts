import { NextResponse } from "next/server";
import { markSessionSeen } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

// POST /api/sessions/:id/seen
// Body: { projectSlug: string, taskSlug: string }
// Marks the session as seen by the user
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const body = await req.json();
  const { projectSlug, taskSlug } = body;

  if (!projectSlug) {
    return NextResponse.json({ error: "projectSlug is required" }, { status: 400 });
  }

  const ok = await markSessionSeen(projectSlug, taskSlug ?? "", id);
  if (!ok) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
