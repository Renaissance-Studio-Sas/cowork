import { NextResponse } from "next/server";
import { renameSession } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

// POST /api/sessions/:id/rename
// Body: { projectSlug: string, taskSlug: string, name: string }
// Renames a session (works for both live and stopped sessions)
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const body = await req.json();
  const { projectSlug, taskSlug, name } = body;

  if (!projectSlug) {
    return NextResponse.json({ error: "projectSlug is required" }, { status: 400 });
  }
  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const ok = await renameSession(projectSlug, taskSlug ?? "", id, name);
  if (!ok) {
    return NextResponse.json(
      { error: "session not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true });
}
