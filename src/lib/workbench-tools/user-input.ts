// Workbench tool that backs the built-in AskUserQuestion. The SDK's
// claude_code preset advertises AskUserQuestion to the agent, but it has
// no native implementation — sessions register a toolAliases entry that
// redirects the model-emitted call to this MCP tool.
//
// Handler flow:
//   1. agent emits AskUserQuestion → routed here as ask_user_question
//   2. we park a Promise in s.pendingQuestions and emit a
//      `question_request` event for the SSE stream
//   3. the user picks options in the UI, POST /api/sessions/[id]/question
//      calls resolveQuestion which fulfills the Promise
//   4. we format the user's answers as text and return them as the tool
//      result — that's what the agent sees on its next turn

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { defineTool, type WorkbenchTool } from "./types";
import { getSession } from "../sessions";

const optionSchema = z.object({
  label: z.string().describe("The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice."),
  description: z.string().describe("Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications."),
  preview: z.string().optional().describe("Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options."),
});

const questionSchema = z.object({
  question: z.string().describe(`The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"`),
  header: z.string().describe(`Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".`),
  options: z.array(optionSchema).min(2).max(4).describe("The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically."),
  multiSelect: z.boolean().default(false).describe("Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive."),
});

export function buildUserInputTools(sessionId: string): WorkbenchTool[] {
  return [
    defineTool(
      "ask_user_question",
      `Ask the user one or more multiple-choice questions and wait for their answer. Use this when you need a decision from the user mid-task — design choices, library picks, behavior preferences. The UI renders each question as a card with selectable options plus an automatic "Other" text input the user can fill if none of the options fit.

Each question must have 2-4 options. The "Other" option is added for you — do not include it yourself. Keep option labels short (1-5 words) and descriptions concise.

Returns the user's selection(s) per question, formatted as text. If the user typed under "Other", that free text is what comes back instead of an option label.

This tool is wired to the built-in AskUserQuestion via toolAliases — calling either name reaches the same handler.`,
      {
        questions: z.array(questionSchema).min(1).max(4).describe("Questions to ask the user (1-4 questions)"),
      },
      async ({ questions }) => {
        const s = getSession(sessionId);
        if (!s) {
          return {
            content: [{ type: "text", text: "Session not found — cannot ask the user." }],
            isError: true,
          };
        }

        const questionId = randomUUID();
        const items = questions.map((q) => ({
          question: q.question,
          header: q.header,
          multiSelect: q.multiSelect ?? false,
          options: q.options.map((o) => ({
            label: o.label,
            description: o.description,
            preview: o.preview,
          })),
        }));

        const answers = await new Promise<Array<{ selected?: string[]; other?: string } | { refused: true }> | null>((resolve) => {
          s.pendingQuestions.set(questionId, {
            questions: items,
            resolve,
            requestedAt: new Date(),
          });
          s.events.emit("question_request", { questionId, questions: items });
        });

        if (answers === null) {
          return {
            content: [{
              type: "text",
              text: "The user declined to answer this AskUserQuestion. Don't re-ask; either proceed with a reasonable default or wait for the user's next message.",
            }],
          };
        }

        const lines: string[] = [];
        items.forEach((q, i) => {
          const a = answers[i];
          let answerText: string;
          if (!a || "refused" in a) {
            answerText = "(no answer)";
          } else {
            const sel = a.selected ?? [];
            const other = a.other?.trim();
            if (other && sel.length === 0) {
              answerText = `Other: ${other}`;
            } else if (other) {
              answerText = `${sel.join(", ")}; Other: ${other}`;
            } else if (sel.length > 0) {
              answerText = sel.join(", ");
            } else {
              answerText = "(no answer)";
            }
          }
          lines.push(`Q${i + 1}: ${q.question}\nA: ${answerText}`);
        });

        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      },
    ),
  ];
}
