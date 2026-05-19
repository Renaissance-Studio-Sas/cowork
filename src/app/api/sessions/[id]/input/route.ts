import { NextResponse } from "next/server";
import { sendInput, sendInputWithFiles, getSession, restoreSession, type FileAttachmentInfo } from "@/lib/sessions";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json();
  if (!body.message || typeof body.message !== "string") {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  const projectSlug = body.projectSlug as string | undefined;
  const taskSlug = body.taskSlug as string | undefined;
  const files = body.files as FileAttachmentInfo[] | undefined;

  // If session isn't in memory, try to restore it from disk
  if (!getSession(id)) {
    if (projectSlug !== undefined && taskSlug !== undefined) {
      await restoreSession(projectSlug, taskSlug, id);
    }
  }

  // Use extended function if files are provided
  let ok: boolean;
  if (files && files.length > 0 && projectSlug && taskSlug) {
    ok = await sendInputWithFiles(id, body.message, files, projectSlug, taskSlug);
  } else {
    ok = await sendInput(id, body.message);
  }

  if (!ok) return NextResponse.json({ error: "session not found or failed to resume" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
