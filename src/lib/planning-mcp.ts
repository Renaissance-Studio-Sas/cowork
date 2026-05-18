// MCP tool the planning agent calls when it's ready to propose a project plan.
// The tool itself just acknowledges the call back to the agent — the
// browser-side UI watches the SDK stream for a tool_use with this name and
// renders the input as an editable "Plan" card.

import { tool, createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export function buildPlanningMcp(): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "workbench-planning",
    version: "0.1.0",
    tools: [
      tool(
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
        async ({ project_slug, project_description, tasks }) => {
          return {
            content: [{
              type: "text",
              text: `Proposed plan: project "${project_slug}" with ${tasks.length} task(s). Waiting for the user to accept or revise.`,
            }],
          };
        },
      ),
    ],
  });
}

export const PLANNING_SYSTEM_PROMPT = `You are helping the user set up a new project in their personal task management system called "Coworking Space".

A project is a folder of related work. Each project contains tasks. Each task is a coherent piece of work an AI agent can help with later.

The workspace structure and conventions are documented in the repo's CLAUDE.md — read it if you haven't already. The folder names under \`tasks/\` are the source of truth for what projects and tasks exist (there is no separate index).

**Naming convention**: project and task names are **human-readable, with proper case and spaces** — they are the literal folder names. Use "House Sale" not "house-sale". Use "Buy in Paris" not "buy-in-paris". Capitalize like a title (keep articles/prepositions lowercase mid-name). Keep names short (2-4 words).

Before proposing anything:
- Run \`ls tasks/\` to see existing projects.
- For any that look related to what the user wants, read \`cat tasks/<project-folder>/files/project.md\` and skim \`ls tasks/<project-folder>/\` to understand them.
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
