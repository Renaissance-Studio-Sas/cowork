// API endpoint to actually send an approved email via Gmail.
// This is called by the UI after approval, and it:
// 1. Verifies the approval token
// 2. Sends the email via the rowads CLI
// 3. Updates the email status to "sent"
// 4. Emits an SSE event so the agent knows the email was sent

import { NextResponse } from "next/server";
import { verifyEmailSignature, type CanonicalEmail } from "@/lib/email-signing";
import { getEmailPreview, updateEmailStatus } from "@/lib/email-store";
import { getSessionDir, getSessionQuery } from "@/lib/sessions";
import { spawn } from "child_process";

export const runtime = "nodejs";

interface SendRequest {
  approvalToken: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  threadId?: string;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; previewId: string }> }
) {
  const { id: sessionId, previewId } = await ctx.params;

  let body: SendRequest;
  try {
    body = await req.json() as SendRequest;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { approvalToken, to, cc, subject, body: emailBody, threadId } = body;

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

  // Check it's approved
  if (preview.status !== "approved") {
    return NextResponse.json(
      { error: `Email not approved (status: ${preview.status})` },
      { status: 403 }
    );
  }

  // Verify the approval token matches
  if (preview.approvalHash !== approvalToken) {
    return NextResponse.json(
      { error: "Approval token does not match" },
      { status: 403 }
    );
  }

  // Re-verify the signature against the content being sent
  // (in case the user edited the email, we need to verify against the ORIGINAL approved content)
  const canonicalEmail: CanonicalEmail = {
    to: preview.to,
    cc: preview.cc,
    subject: preview.subject,
    body: preview.body,
    threadId: preview.threadId,
  };

  const signatureValid = verifyEmailSignature(canonicalEmail, approvalToken);
  if (!signatureValid) {
    return NextResponse.json(
      { error: "Approval signature verification failed" },
      { status: 403 }
    );
  }

  // Send the email using Python script directly (avoid CLI parsing issues)
  try {
    const result = await sendEmailViaPython({
      to,
      cc,
      subject,
      body: emailBody,
      threadId,
    });

    // Update status to sent
    await updateEmailStatus(sessionDir, previewId, "sent");

    // Notify the agent via SSE that the email was sent
    const query = getSessionQuery(sessionId);
    if (query) {
      // Inject a user message to notify the agent
      const notification = `[EMAIL SENT] The email has been sent successfully.

**To:** ${to}
${cc ? `**Cc:** ${cc}\n` : ""}**Subject:** ${subject}

**Body:**
${emailBody}

**Gmail Message ID:** ${result.messageId}
**Gmail Thread ID:** ${result.threadId}`;

      // Use the query's message injection if available, otherwise the agent will see it on next poll
      try {
        // We'll emit this as an SSE event that the chat can pick up
        // For now, just log it - the agent can check status via check_email_status
        console.log(`[email-send] Email sent for session ${sessionId}:`, result);
      } catch (e) {
        console.error(`[email-send] Failed to notify agent:`, e);
      }
    }

    return NextResponse.json({
      ok: true,
      messageId: result.messageId,
      threadId: result.threadId,
      to,
      subject,
      body: emailBody,
    });

  } catch (e) {
    console.error(`[email-send] Failed to send email:`, e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

interface SendResult {
  messageId: string;
  threadId: string;
}

async function sendEmailViaPython(params: {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  threadId?: string;
}): Promise<SendResult> {
  return new Promise((resolve, reject) => {
    // Use the manage_emails module directly via Python
    const pythonCode = `
import json
import sys
sys.path.insert(0, '/Users/mfucci/git/rowads-automation/scripts')

from automations.google_workspace.manage_emails import get_service, _autowrap_html
from email.mime.text import MIMEText
import base64

params = json.loads(sys.argv[1])

service = get_service()
message = MIMEText(_autowrap_html(params['body']), 'html')
message['to'] = params['to']
message['subject'] = params['subject']
if params.get('cc'):
    message['cc'] = params['cc']

raw = base64.urlsafe_b64encode(message.as_bytes()).decode('utf-8')
body_obj = {'raw': raw}
if params.get('threadId'):
    body_obj['threadId'] = params['threadId']

result = service.users().messages().send(userId='me', body=body_obj).execute()
print(json.dumps({'messageId': result.get('id'), 'threadId': result.get('threadId')}))
`;

    const child = spawn("python3", ["-c", pythonCode, JSON.stringify(params)], {
      cwd: "/Users/mfucci/git/rowads-automation/scripts",
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Python script failed (code ${code}): ${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        resolve(result);
      } catch (e) {
        reject(new Error(`Failed to parse Python output: ${stdout}`));
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}
