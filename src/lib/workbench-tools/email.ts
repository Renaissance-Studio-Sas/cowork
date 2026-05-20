// Workbench tools for email preview and approval. Lets agents compose
// emails the user reviews before sending — compose_email_preview creates
// a pending preview, get_email_approval_status checks status, the user
// approves via the chat UI, and a CLI command actually sends.

import { z } from "zod";
import { getSessionDir } from "../sessions";
import { createEmailPreview, getEmailPreview, listPendingEmails, type EmailMessage } from "../email-store";
import { defineTool, type WorkbenchTool } from "./types";

export function buildEmailTools(sessionId: string): WorkbenchTool[] {
  return [
    defineTool(
      "compose_email_preview",
      `Compose an email for user approval. The email will be displayed in the chat
for the user to review. They can approve or reject it.

IMPORTANT: This does NOT send the email. The user must click "Approve & Send"
in the UI. After approval, call get_email_approval_status to get the approval
token, then execute the rowads CLI to actually send.

For replies, set isReply=true and include the replyToMessageId and threadId.
For forwards, set isForward=true.
Include originalThread to show the conversation context to the user.`,
      {
        to: z.string().describe("Recipient email address(es), comma-separated for multiple"),
        cc: z.string().optional().describe("CC email address(es), comma-separated"),
        subject: z.string().describe("Email subject line"),
        body: z.string().describe("Email body in HTML format"),
        attachments: z.array(z.string()).optional().describe("List of attachment filenames"),
        threadId: z.string().optional().describe("Gmail thread ID for replies"),
        replyToMessageId: z.string().optional().describe("Gmail message ID being replied to"),
        isReply: z.boolean().optional().describe("True if this is a reply to an existing email"),
        isForward: z.boolean().optional().describe("True if this is a forwarded email"),
        originalThread: z.array(z.object({
          from: z.string(),
          to: z.string(),
          cc: z.string().optional(),
          subject: z.string(),
          body: z.string(),
          date: z.string(),
          messageId: z.string().optional(),
        })).optional().describe("Previous messages in the thread for context"),
      },
      async (input) => {
        const sessionDir = getSessionDir(sessionId);
        if (!sessionDir) {
          return {
            content: [{ type: "text", text: `Session not found (id: ${sessionId}).` }],
            isError: true,
          };
        }

        const preview = await createEmailPreview(sessionDir, {
          to: input.to,
          cc: input.cc,
          subject: input.subject,
          body: input.body,
          attachments: input.attachments,
          threadId: input.threadId,
          replyToMessageId: input.replyToMessageId,
          isReply: input.isReply,
          isForward: input.isForward,
          originalThread: input.originalThread as EmailMessage[] | undefined,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              previewId: preview.id,
              status: "pending",
              message: "Email preview created. Waiting for user approval in the UI. " +
                "The user will see the email preview in the chat. " +
                "Call get_email_approval_status to check if they approved.",
            }, null, 2),
          }],
        };
      },
    ),

    defineTool(
      "get_email_approval_status",
      `Check the approval status of a pending email.

Returns:
- status: "pending" | "approved" | "rejected" | "sent"
- approvalToken: The signed token (only present when status is "approved")

Once approved, use the approvalToken with the rowads CLI to send:
  rowads email send --session-id <id> --preview-id <previewId> --approval-token <token> ...`,
      {
        previewId: z.string().describe("The email preview ID returned by compose_email_preview"),
      },
      async ({ previewId }) => {
        const sessionDir = getSessionDir(sessionId);
        if (!sessionDir) {
          return {
            content: [{ type: "text", text: `Session not found (id: ${sessionId}).` }],
            isError: true,
          };
        }

        const preview = await getEmailPreview(sessionDir, previewId);
        if (!preview) {
          return {
            content: [{ type: "text", text: `Email preview not found (id: ${previewId}).` }],
            isError: true,
          };
        }

        const response: {
          previewId: string;
          status: string;
          approvalToken?: string;
          to: string;
          subject: string;
          message: string;
        } = {
          previewId: preview.id,
          status: preview.status,
          to: preview.to,
          subject: preview.subject,
          message: "",
        };

        switch (preview.status) {
          case "pending":
            response.message = "Still waiting for user approval. The user needs to click 'Approve & Send' in the chat UI.";
            break;
          case "approved":
            response.approvalToken = preview.approvalHash;
            response.message = `Email approved! Use the rowads CLI to send:\n` +
              `rowads email send --session-id ${sessionId} --preview-id ${previewId} ` +
              `--approval-token ${preview.approvalHash} --to "${preview.to}" ` +
              `--subject "${preview.subject.replace(/"/g, '\\"')}"`;
            break;
          case "rejected":
            response.message = "User rejected this email. You may compose a new version with changes.";
            break;
          case "sent":
            response.message = "Email has already been sent.";
            break;
        }

        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        };
      },
    ),

    defineTool(
      "list_pending_emails",
      `List all pending email previews awaiting user approval in this session.`,
      {},
      async () => {
        const sessionDir = getSessionDir(sessionId);
        if (!sessionDir) {
          return {
            content: [{ type: "text", text: `Session not found (id: ${sessionId}).` }],
            isError: true,
          };
        }

        const pending = await listPendingEmails(sessionDir);
        if (pending.length === 0) {
          return {
            content: [{ type: "text", text: "No pending emails awaiting approval." }],
          };
        }

        const summary = pending.map((e) => ({
          previewId: e.id,
          to: e.to,
          subject: e.subject,
          createdAt: e.createdAt,
          isReply: e.isReply ?? false,
          isForward: e.isForward ?? false,
        }));

        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
        };
      },
    ),
  ];
}
