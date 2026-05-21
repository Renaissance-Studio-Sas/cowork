import { NextResponse } from "next/server";
import { resolveQuestion } from "@/lib/sessions";

export const runtime = "nodejs";

// Resolve a pending AskUserQuestion the agent's tool handler is awaiting.
// Body shape:
//   { questionId: string,
//     answers: Array<{ selected?: string[]; other?: string }> }
//
// `selected` is the labels of the options the user picked. `other` is the
// free text from the auto-provided "Other" input (when the user typed
// something there). Either or both may be present per question.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json() as {
    questionId?: string;
    answers?: Array<{ selected?: string[]; other?: string }>;
  };

  if (!body.questionId || !Array.isArray(body.answers)) {
    return NextResponse.json(
      { error: "body must include `questionId` and `answers` (array)" },
      { status: 400 },
    );
  }

  const ok = resolveQuestion(id, body.questionId, body.answers);
  if (!ok) {
    return NextResponse.json(
      { error: "no pending question for that questionId (already answered, session not in memory, or wrong id)" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
