// API endpoint to update email content before approval.

import { NextResponse } from "next/server";
import { getEmailPreview, updateEmailContent } from "@/lib/email-store";
import { getSessionDir } from "@/lib/sessions";

export const runtime = "nodejs";

interface UpdateRequest {
  to: string;
  cc?: string;
  subject: string;
  body: string;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; previewId: string }> }
) {
  const { id: sessionId, previewId } = await ctx.params;

  let body: UpdateRequest;
  try {
    body = await req.json() as UpdateRequest;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

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
      { error: `Cannot update email with status: ${preview.status}` },
      { status: 400 }
    );
  }

  // Update the email content
  const updated = await updateEmailContent(sessionDir, previewId, {
    to: body.to,
    cc: body.cc,
    subject: body.subject,
    body: body.body,
  });

  if (!updated) {
    return NextResponse.json(
      { error: "Failed to update email" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, email: updated });
}
