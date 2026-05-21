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
        project_description: z.string().describe("1-2 sentences describing the project"),
        tasks: z.array(z.object({
          slug: z.string().describe("Human-readable task name with proper case and spaces, e.g. 'Collect Receipts', 'Draft Email to School'. NOT kebab-case."),
          description: z.string().describe("one-line description of what this task is about"),
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
// and renders an editable card. Accepting the card creates the task and
// writes `task_description` verbatim into `task.md`.
export function buildTaskPlanningTools(): WorkbenchTool[] {
  return [
    defineTool(
      "propose_task",
      "Propose a single task to the user. Call this once you have enough context. The user will see your proposal as an editable card and can accept or revise it.",
      {
        task_slug: z.string().describe("Human-readable task name with proper case and spaces, e.g. 'Draft Email to School', 'Collect Receipts'. NOT kebab-case. The folder name is the display name."),
        task_description: z.string().describe("The brief that will be written verbatim into task.md. Markdown is fine — use it to capture goals, constraints, inputs/outputs, and any decisions made in this chat. Aim for something a future agent can pick up cold without needing the conversation."),
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
- For any that look related to what the user wants, read \`cat projects/<project-folder>/files/project.md\` and skim \`ls projects/<project-folder>/\` to understand them.
- Avoid name collisions and avoid creating a new project for something that fits naturally under an existing one (in which case, tell the user and suggest they add tasks there instead).

Your job:
1. Ask the user (one short question at a time) what the project is about and what kind of work it involves.
2. Once you have enough context — usually after 1-3 questions — call the \`propose_plan\` tool with:
   - project_slug: human-readable project name (e.g. "House Sale", "Imagine R Reimbursement")
   - project_description: 1-2 sentences for the project description
   - tasks: 2-5 initial tasks, each with a human-readable name and one-line description
3. After proposing, wait. If the user revises, propose again with the changes.

Keep your messages short and conversational. Don't bullet-list options — ask focused questions. The user is moving fast; be brief.
`;

// System prompt for the "New task" chat. The project context (slug,
// description, existing task slugs) is interpolated in so the agent can
// fit the new task naturally and avoid duplicates without having to walk
// the filesystem first.
export function buildTaskPlanningSystemPrompt(
  projectSlug: string,
  projectFolder: string,
  projectDescription: string,
  existingTaskSlugs: string[],
): string {
  const existing = existingTaskSlugs.length
    ? existingTaskSlugs.map((s) => `  - ${s}`).join("\n")
    : "  _(none yet)_";
  const desc = projectDescription.trim() || "_(project.md is empty)_";
  return `You are helping the user define a new task in the project "${projectSlug}" within their personal task management system "Coworking Space".

A task is a coherent piece of work an AI agent can later pick up and execute. The goal of this chat is to produce a clean \`task.md\` brief — written so a future agent can start cold without re-asking the user.

**Project context**
- Slug: \`${projectSlug}\`
- Folder: \`projects/${projectFolder}/\` (read \`files/project.md\` for the full description)
- Description: ${desc}
- Existing tasks:
${existing}

The workspace structure and conventions are documented in the repo's CLAUDE.md — read it if you haven't already. Read related task.md files in this project if it helps you pick a name that fits.

**Naming convention**: task names are **human-readable, with proper case and spaces** — they are the literal folder names. Use "Draft Email to School" not "draft-email-to-school". Capitalize like a title (articles/prepositions lowercase mid-name). Keep names short (2-4 words). Avoid collisions with existing tasks above.

Your job:
1. Ask the user (one short question at a time) what the task is about and what "done" looks like.
2. Once you have enough context — usually after 1-3 questions — call the \`propose_task\` tool with:
   - \`task_slug\`: human-readable task name
   - \`task_description\`: the full brief that will be written verbatim into task.md. Use markdown. Include goals, inputs, outputs, constraints, and any decisions surfaced in this chat. This is the artifact — make it good.
3. After proposing, wait. If the user revises, propose again with the changes.

Keep your messages short and conversational. The user is moving fast; be brief.
`;
}
