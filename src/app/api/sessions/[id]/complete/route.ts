import { NextResponse } from "next/server";
import { markSessionCompleted, resolveCompletionSuggestion } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

// POST /api/sessions/:id/complete
// Body shapes:
//   { projectSlug, taskSlug, completed: boolean }
//     → manual mark/unmark (user clicked the button)
//   { projectSlug, taskSlug, completed: boolean, requestId: string }
//     → resolve an agent suggest_session_complete request; `completed` is the
//       user's decision (true = approve + mark complete, false = dismiss).
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const body = await req.json() as {
    projectSlug?: string;
    taskSlug?: string;
    completed?: boolean;
    requestId?: string;
  };

  if (typeof body.completed !== "boolean") {
    return NextResponse.json({ error: "`completed` (boolean) is required" }, { status: 400 });
  }
  if (!body.projectSlug) {
    return NextResponse.json({ error: "projectSlug is required" }, { status: 400 });
  }

  // If this resolves an agent suggestion, unblock the parked tool handler
  // first. The handler returns "approved" / "dismissed" to the model based on
  // the boolean. The mark itself still happens below so the on-disk flag is
  // up to date even if the suggestion was already cleared.
  if (body.requestId) {
    resolveCompletionSuggestion(id, body.requestId, body.completed);
  }

  const ok = await markSessionCompleted(
    body.projectSlug,
    body.taskSlug ?? "",
    id,
    body.completed,
  );
  if (!ok) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
