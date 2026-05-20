// API endpoint for rowads-automation to verify email approval tokens.
// This is the critical security check — the secret never leaves Cowork.

import { NextResponse } from "next/server";
import { verifyEmailSignature, type CanonicalEmail } from "@/lib/email-signing";
import { getEmailPreview } from "@/lib/email-store";
import { getSessionDir } from "@/lib/sessions";

export const runtime = "nodejs";

interface VerifyRequest {
  sessionId: string;
  previewId: string;
  approvalToken: string;
  emailContent: {
    to: string;
    cc?: string;
    subject: string;
    body: string;
    attachments?: string[];
    threadId?: string;
  };
}

export async function POST(req: Request) {
  let body: VerifyRequest;
  try {
    body = await req.json() as VerifyRequest;
  } catch {
    return NextResponse.json(
      { valid: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { sessionId, previewId, approvalToken, emailContent } = body;

  // Validate required fields
  if (!sessionId || !previewId || !approvalToken || !emailContent) {
    return NextResponse.json(
      { valid: false, error: "Missing required fields: sessionId, previewId, approvalToken, emailContent" },
      { status: 400 }
    );
  }

  // Get session directory
  const sessionDir = getSessionDir(sessionId);
  if (!sessionDir) {
    return NextResponse.json(
      { valid: false, error: `Session not found: ${sessionId}` },
      { status: 404 }
    );
  }

  // Get the email preview
  const preview = await getEmailPreview(sessionDir, previewId);
  if (!preview) {
    return NextResponse.json(
      { valid: false, error: `Email preview not found: ${previewId}` },
      { status: 404 }
    );
  }

  // Check status
  if (preview.status !== "approved") {
    return NextResponse.json(
      { valid: false, error: `Email not approved (status: ${preview.status})` },
      { status: 403 }
    );
  }

  // Verify the token matches the stored approval hash
  if (preview.approvalHash !== approvalToken) {
    return NextResponse.json(
      { valid: false, error: "Approval token does not match stored hash" },
      { status: 403 }
    );
  }

  // Re-compute the hash from the provided email content and verify it matches
  const canonicalEmail: CanonicalEmail = {
    to: emailContent.to,
    cc: emailContent.cc,
    subject: emailContent.subject,
    body: emailContent.body,
    attachments: emailContent.attachments,
    threadId: emailContent.threadId,
  };

  const signatureValid = verifyEmailSignature(canonicalEmail, approvalToken);
  if (!signatureValid) {
    return NextResponse.json(
      { valid: false, error: "Email content does not match approval signature" },
      { status: 403 }
    );
  }

  // All checks passed
  return NextResponse.json({
    valid: true,
    previewId: preview.id,
    approvedAt: preview.approvedAt,
  });
}
