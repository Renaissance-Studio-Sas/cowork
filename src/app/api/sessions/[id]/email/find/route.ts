// API endpoint to find an email by its content.
// Used by the Chat UI to match tool_use input to the stored email.

import { NextResponse } from "next/server";
import { findEmailByContent } from "@/lib/email-store";
import { getSessionDir } from "@/lib/sessions";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await ctx.params;

  let body: { to: string; subject: string; body: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { to, subject, body: emailBody } = body;
  if (!to || !subject || !emailBody) {
    return NextResponse.json(
      { error: "Missing required fields: to, subject, body" },
      { status: 400 }
    );
  }

  const sessionDir = getSessionDir(sessionId);
  if (!sessionDir) {
    return NextResponse.json(
      { error: `Session not found: ${sessionId}` },
      { status: 404 }
    );
  }

  const email = await findEmailByContent(sessionDir, to, subject, emailBody);
  if (!email) {
    return NextResponse.json(
      { error: "No matching email found" },
      { status: 404 }
    );
  }

  return NextResponse.json({ email });
}
