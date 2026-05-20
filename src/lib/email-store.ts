// File-based storage for pending email approvals.
// Each session gets a `pending-emails.json` file in its session directory.
// Emails are stored with status: pending -> approved/rejected -> sent.

import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

export interface EmailMessage {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  date: string;
  messageId?: string;
}

export interface EmailPreview {
  id: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  attachments?: string[];
  threadId?: string;
  replyToMessageId?: string;
  isForward?: boolean;
  isReply?: boolean;
  originalThread?: EmailMessage[];
  status: "pending" | "approved" | "rejected" | "sent";
  createdAt: string;
  approvedAt?: string;
  approvalHash?: string;
}

interface EmailStore {
  next_id: number;
  emails: EmailPreview[];
}

// Get the path to the pending-emails.json file for a session.
// Session directories are at: projects/<project>/wip-<task>/sessions/<sessionId>/
function getStorePath(sessionDir: string): string {
  return path.join(sessionDir, "pending-emails.json");
}

async function readStore(sessionDir: string): Promise<EmailStore> {
  const filePath = getStorePath(sessionDir);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.next_id !== "number" || !Array.isArray(parsed?.emails)) {
      return { next_id: 1, emails: [] };
    }
    return parsed as EmailStore;
  } catch {
    return { next_id: 1, emails: [] };
  }
}

async function writeStore(sessionDir: string, store: EmailStore): Promise<void> {
  const filePath = getStorePath(sessionDir);
  // Ensure session directory exists
  if (!existsSync(sessionDir)) {
    await fs.mkdir(sessionDir, { recursive: true });
  }
  await fs.writeFile(filePath, JSON.stringify(store, null, 2) + "\n", "utf8");
}

export async function createEmailPreview(
  sessionDir: string,
  email: Omit<EmailPreview, "id" | "status" | "createdAt">
): Promise<EmailPreview> {
  const store = await readStore(sessionDir);
  const id = `email-${store.next_id}`;
  const preview: EmailPreview = {
    id,
    to: email.to,
    cc: email.cc,
    subject: email.subject,
    body: email.body,
    attachments: email.attachments,
    threadId: email.threadId,
    replyToMessageId: email.replyToMessageId,
    isForward: email.isForward,
    isReply: email.isReply,
    originalThread: email.originalThread,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  store.emails.push(preview);
  store.next_id += 1;
  await writeStore(sessionDir, store);
  return preview;
}

export async function getEmailPreview(
  sessionDir: string,
  previewId: string
): Promise<EmailPreview | null> {
  const store = await readStore(sessionDir);
  return store.emails.find((e) => e.id === previewId) || null;
}

export async function updateEmailStatus(
  sessionDir: string,
  previewId: string,
  status: EmailPreview["status"],
  approvalHash?: string
): Promise<EmailPreview | null> {
  const store = await readStore(sessionDir);
  const email = store.emails.find((e) => e.id === previewId);
  if (!email) return null;

  email.status = status;
  if (status === "approved" && approvalHash) {
    email.approvalHash = approvalHash;
    email.approvedAt = new Date().toISOString();
  }
  await writeStore(sessionDir, store);
  return email;
}

export async function listPendingEmails(sessionDir: string): Promise<EmailPreview[]> {
  const store = await readStore(sessionDir);
  return store.emails.filter((e) => e.status === "pending");
}

export async function listAllEmails(sessionDir: string): Promise<EmailPreview[]> {
  const store = await readStore(sessionDir);
  return store.emails;
}

// Update email content (for edits before approval)
export async function updateEmailContent(
  sessionDir: string,
  previewId: string,
  updates: { to?: string; cc?: string; subject?: string; body?: string }
): Promise<EmailPreview | null> {
  const store = await readStore(sessionDir);
  const email = store.emails.find((e) => e.id === previewId);
  if (!email) return null;

  // Only allow updates while pending
  if (email.status !== "pending") return null;

  if (updates.to !== undefined) email.to = updates.to;
  if (updates.cc !== undefined) email.cc = updates.cc;
  if (updates.subject !== undefined) email.subject = updates.subject;
  if (updates.body !== undefined) email.body = updates.body;

  await writeStore(sessionDir, store);
  return email;
}

// Find an email by matching content (used to link UI tool_use input to stored email)
export async function findEmailByContent(
  sessionDir: string,
  to: string,
  subject: string,
  body: string
): Promise<EmailPreview | null> {
  const store = await readStore(sessionDir);
  // Find the most recent pending email matching the content
  const candidates = store.emails.filter(
    (e) =>
      e.status === "pending" &&
      e.to === to &&
      e.subject === subject &&
      e.body === body
  );
  // Return the most recent one
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}
