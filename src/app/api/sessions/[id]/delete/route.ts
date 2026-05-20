import { NextResponse } from "next/server";
import { deleteSession } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

// DELETE /api/sessions/:id/delete
// Body: { projectSlug: string, taskSlug: string }
// Deletes a stopped session
export async function DELETE(req: Request, { params }: Params) {
  const { id } = await params;
  const body = await req.json();
  const { projectSlug, taskSlug } = body;

  if (!projectSlug) {
    return NextResponse.json({ error: "projectSlug is required" }, { status: 400 });
  }

  const ok = await deleteSession(projectSlug, taskSlug ?? "", id);
  if (!ok) {
    return NextResponse.json(
      { error: "Session not found or is actively running" },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true });
}

// Also support POST for easier client usage
export async function POST(req: Request, { params }: Params) {
  return DELETE(req, { params });
}
