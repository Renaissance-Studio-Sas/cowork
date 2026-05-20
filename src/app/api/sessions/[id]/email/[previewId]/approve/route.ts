// API endpoint for the Chat UI to approve an email.
// Generates the HMAC signature and returns it as the approval token.

import { NextResponse } from "next/server";
import { _internal, type CanonicalEmail } from "@/lib/email-signing";
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
      { error: `Email already ${preview.status}`, approvalHash: preview.approvalHash },
      { status: 400 }
    );
  }

  // Generate the approval hash
  const canonicalEmail: CanonicalEmail = {
    to: preview.to,
    cc: preview.cc,
    subject: preview.subject,
    body: preview.body,
    attachments: preview.attachments,
    threadId: preview.threadId,
  };

  let approvalHash: string;
  try {
    approvalHash = _internal.signEmail(canonicalEmail);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to sign email: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }

  // Update the status
  const updated = await updateEmailStatus(sessionDir, previewId, "approved", approvalHash);
  if (!updated) {
    return NextResponse.json(
      { error: "Failed to update email status" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    previewId,
    approvalToken: approvalHash,
  });
}
