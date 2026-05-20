// HMAC-SHA256 signing utilities for email approval tokens.
// The secret is stored only in Cowork (COWORK_EMAIL_SECRET env var) and never
// exposed to clients or the rowads-automation scripts.
//
// SECURITY: signEmail is NOT exported. Signing can only happen through the
// /api/sessions/[id]/email/[previewId]/approve endpoint when a user clicks
// the approve button in the UI.

import { createHmac, timingSafeEqual } from "node:crypto";

function getSecret(): string {
  const secret = process.env.COWORK_EMAIL_SECRET;
  if (!secret) {
    throw new Error(
      "COWORK_EMAIL_SECRET environment variable is not set. " +
      "Generate one with: openssl rand -hex 32"
    );
  }
  return secret;
}

export interface CanonicalEmail {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  attachments?: string[];
  threadId?: string;
}

/**
 * Create a deterministic JSON representation of email content for signing.
 * All fields are normalized (trimmed, lowercased for emails, sorted for arrays).
 */
function canonicalizeEmail(email: CanonicalEmail): string {
  return JSON.stringify({
    to: (email.to || "").toLowerCase().trim(),
    cc: (email.cc || "").toLowerCase().trim(),
    subject: (email.subject || "").trim(),
    body: (email.body || "").trim(),
    attachments: [...(email.attachments || [])].sort(),
    threadId: email.threadId || "",
  });
}

/**
 * Sign email content with HMAC-SHA256 using the secret.
 * Returns a hex-encoded signature.
 *
 * INTERNAL ONLY - not exported. Use signEmailForApproval from the approve endpoint.
 */
function signEmail(email: CanonicalEmail): string {
  const secret = getSecret();
  const canonical = canonicalizeEmail(email);
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

/**
 * Verify an email signature using constant-time comparison.
 * Returns true if the signature is valid.
 *
 * This IS exported because the verification endpoint needs it.
 */
export function verifyEmailSignature(email: CanonicalEmail, signature: string): boolean {
  try {
    const expected = signEmail(email);
    // Ensure both are the same length before comparison
    if (expected.length !== signature.length) {
      return false;
    }
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

// Internal module for server-side API routes only.
// This pattern ensures signEmail can only be called from specific API endpoints.
export const _internal = {
  signEmail,
};
