import { NextResponse } from "next/server";
import { resolveQuestion } from "@/lib/sessions";

export const runtime = "nodejs";

// Resolve a pending AskUserQuestion the agent's tool handler is awaiting.
// Body shape (answer):
//   { questionId: string,
//     answers: Array<{ selected?: string[]; other?: string }> }
// Body shape (refuse):
//   { questionId: string, refused: true }
//
// `selected` is the labels of the options the user picked. `other` is the
// free text from the auto-provided "Other" input. When `refused: true`, the
// user dismissed the prompt and the agent gets a "user declined to answer"
// result instead of selections.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json() as {
    questionId?: string;
    answers?: Array<{ selected?: string[]; other?: string }>;
    refused?: boolean;
  };

  if (!body.questionId) {
    return NextResponse.json(
      { error: "body must include `questionId`" },
      { status: 400 },
    );
  }
  if (!body.refused && !Array.isArray(body.answers)) {
    return NextResponse.json(
      { error: "body must include `answers` (array) or `refused: true`" },
      { status: 400 },
    );
  }

  const payload = body.refused ? null : body.answers!;
  const ok = resolveQuestion(id, body.questionId, payload);
  if (!ok) {
    return NextResponse.json(
      { error: "no pending question for that questionId (already answered, session not in memory, or wrong id)" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
