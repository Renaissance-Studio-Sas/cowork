// API endpoint for the Chat UI to reject an email.

import { NextResponse } from "next/server";
import { getEmailPreview, updateEmailStatus } from "@/lib/email-store";
import { getSessionDir } from "@/lib/sessions";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string; previewId: string }> }
) {
  const { id: sessionId, previewId } = await ctx.params;

  // Get session directory
  const sessionDir = getSessionDir(sessionId);
  if (!sessionDir) {
    return NextResponse.json(
      { error: `Session not found: ${sessionId}` },
      { status: 404 }
    );
  }

  // Get the email preview
  const preview = await getEmailPreview(sessionDir, previewId);
  if (!preview) {
    return NextResponse.json(
      { error: `Email preview not found: ${previewId}` },
      { status: 404 }
    );
  }

  // Check it's still pending
  if (preview.status !== "pending") {
    return NextResponse.json(
      { error: `Email already ${preview.status}` },
      { status: 400 }
    );
  }

  // Update the status
  const updated = await updateEmailStatus(sessionDir, previewId, "rejected");
  if (!updated) {
    return NextResponse.json(
      { error: "Failed to update email status" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    previewId,
  });
}
