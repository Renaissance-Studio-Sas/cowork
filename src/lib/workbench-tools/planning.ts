// Workbench tool the planning agent calls when it's ready to propose a
// project plan. The tool itself just acknowledges the call back to the
// agent — the browser-side UI watches the SDK stream for a tool_use with
// this name and renders the input as an editable "Plan" card.

import { z } from "zod";
import { defineTool, type WorkbenchTool } from "./types";

export function buildPlanningTools(): WorkbenchTool[] {
  return [
    defineTool(
      "propose_plan",
      "Propose a project plan to the user. Call this once you have enough information about the project. The user will see your proposal as an editable card and can accept or revise it.",
      {
        project_slug: z.string().describe("Human-readable project name with proper case and spaces, e.g. 'House Sale', 'Buy in Paris', 'Tax 2025'. NOT kebab-case. The folder name is the display name."),
        project_overview: z.string().describe("Concise one-sentence summary of what this project is (~20 words, never more than one paragraph). Shown verbatim at the top of the project view, so it must read like a tweet, not a paragraph. Push goals, criteria, context, and constraints into project_details instead."),
        project_details: z.string().describe("Longer markdown body with goals, criteria, constraints, context, and any decisions surfaced in this chat. This is where verbose content belongs — the overview should stay short by pushing detail here. May be empty if there's truly nothing beyond the overview."),
        tasks: z.array(z.object({
          slug: z.string().describe("Human-readable task name with proper case and spaces, e.g. 'Collect Receipts', 'Draft Email to School'. NOT kebab-case."),
          overview: z.string().describe("Concise one-sentence summary of the task (~20 words, never more than one paragraph). Push detail into the details field."),
          details: z.string().describe("Longer markdown body for the task brief — goals, inputs/outputs, constraints. Where verbose content belongs. May be empty for simple tasks."),
        })).min(1).max(8).describe("2-5 initial tasks to populate the project"),
      },
      async ({ project_slug, tasks }) => {
        return {
          content: [{
            type: "text",
            text: `Proposed plan: project "${project_slug}" with ${tasks.length} task(s). Waiting for the user to accept or revise.`,
          }],
        };
      },
    ),
  ];
}

// Counterpart for the "New task" chat modal. The agent proposes a single
// task scoped to an existing project; the browser watches for the tool_use
// and renders an editable card. Accepting the card writes the overview +
// details into `task.json` (the structured task brief).
export function buildTaskPlanningTools(): WorkbenchTool[] {
  return [
    defineTool(
      "propose_task",
      "Propose a single task to the user. Call this once you have enough context. The user will see your proposal as an editable card and can accept or revise it.",
      {
        task_slug: z.string().describe("Human-readable task name with proper case and spaces, e.g. 'Draft Email to School', 'Collect Receipts'. NOT kebab-case. The folder name is the display name."),
        task_overview: z.string().describe("Concise one-sentence summary of the task (~20 words, never more than one paragraph). Shown verbatim at the top of the task view, so it must read like a tweet, not a paragraph. Push goals, criteria, context, and constraints into task_details instead."),
        task_details: z.string().describe("Longer markdown body for the task brief — goals, inputs/outputs, constraints, and any decisions surfaced in this chat. This is where verbose content belongs — the overview stays short by pushing detail here. Aim for something a future agent can pick up cold without needing the conversation. May be empty for simple tasks."),
      },
      async ({ task_slug }) => {
        return {
          content: [{
            type: "text",
            text: `Proposed task "${task_slug}". Waiting for the user to accept or revise.`,
          }],
        };
      },
    ),
  ];
}

export const PLANNING_SYSTEM_PROMPT = `You are helping the user set up a new project in their personal task management system called "Coworking Space".

A project is a folder of related work. Each project contains tasks. Each task is a coherent piece of work an AI agent can help with later.

The workspace structure and conventions are documented in the repo's CLAUDE.md — read it if you haven't already. The folder names under \`projects/\` are the source of truth for what projects and tasks exist (there is no separate index).

**Naming convention**: project and task names are **human-readable, with proper case and spaces** — they are the literal folder names. Use "House Sale" not "house-sale". Use "Buy in Paris" not "buy-in-paris". Capitalize like a title (keep articles/prepositions lowercase mid-name). Keep names short (2-4 words).

Before proposing anything:
- Run \`ls projects/\` to see existing projects.
- For any that look related to what the user wants, read \`cat projects/<project-folder>/files/project.json\` and skim \`ls projects/<project-folder>/\` to understand them. The brief is JSON: \`{ "overview": "...", "details": "...", "createdAt": "..." }\`.
- Avoid name collisions and avoid creating a new project for something that fits naturally under an existing one (in which case, tell the user and suggest they add tasks there instead).

Your job:
1. Ask the user (one short question at a time) what the project is about and what kind of work it involves.
2. Once you have enough context — usually after 1-3 questions — call the \`propose_plan\` tool with:
   - project_slug: human-readable project name (e.g. "House Sale", "Imagine R Reimbursement")
   - project_overview: a concise one-sentence summary (~20 words max). It must read like a tweet, not a paragraph. Push everything else into details.
   - project_details: longer markdown body (can be empty)
   - tasks: 2-5 initial tasks, each with human-readable name + a short one-sentence overview + details
3. After proposing, wait. If the user revises, propose again with the changes.

Keep your messages short and conversational. Don't bullet-list options — ask focused questions. The user is moving fast; be brief.
`;

// System prompt for the "New task" chat. The project context (slug,
// overview, existing task slugs) is interpolated in so the agent can
// fit the new task naturally and avoid duplicates without having to walk
// the filesystem first.
export function buildTaskPlanningSystemPrompt(
  projectSlug: string,
  projectFolder: string,
  projectOverview: string,
  existingTaskSlugs: string[],
): string {
  const existing = existingTaskSlugs.length
    ? existingTaskSlugs.map((s) => `  - ${s}`).join("\n")
    : "  _(none yet)_";
  const desc = projectOverview.trim() || "_(project.json overview is empty)_";
  return `You are helping the user define a new task in the project "${projectSlug}" within their personal task management system "Coworking Space".

A task is a coherent piece of work an AI agent can later pick up and execute. The goal of this chat is to produce a clean \`task.json\` brief — written so a future agent can start cold without re-asking the user. The brief has shape \`{ "overview": "one line", "details": "markdown body", "createdAt": "..." }\`.

**Project context**
- Slug: \`${projectSlug}\`
- Folder: \`projects/${projectFolder}/\` (read \`files/project.json\` for the full brief)
- Overview: ${desc}
- Existing tasks:
${existing}

The workspace structure and conventions are documented in the repo's CLAUDE.md — read it if you haven't already. Read related task.json files in this project if it helps you pick a name that fits.

**Naming convention**: task names are **human-readable, with proper case and spaces** — they are the literal folder names. Use "Draft Email to School" not "draft-email-to-school". Capitalize like a title (articles/prepositions lowercase mid-name). Keep names short (2-4 words). Avoid collisions with existing tasks above.

Your job:
1. Ask the user (one short question at a time) what the task is about and what "done" looks like.
2. Once you have enough context — usually after 1-3 questions — call the \`propose_task\` tool with:
   - \`task_slug\`: human-readable task name
   - \`task_overview\`: a concise one-sentence summary (~20 words max). It must read like a tweet, not a paragraph. Push everything else into details.
   - \`task_details\`: longer markdown body — goals, inputs, outputs, constraints, decisions. May be empty for simple tasks. This is the artifact — make it good.
3. After proposing, wait. If the user revises, propose again with the changes.

Keep your messages short and conversational. The user is moving fast; be brief.
`;
}
