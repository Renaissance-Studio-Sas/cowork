// Workbench tool the planning agent calls when it's ready to propose a new
// workspace under the current parent. The tool itself just acknowledges the
// call back to the agent — the browser-side UI watches the SDK stream for a
// tool_use with this name and renders the input as an editable "Plan" card.
//
// Cowork's data model is recursive: every unit of work is a `workspace`. A
// root workspace lives directly under `projects/`; a child workspace lives
// inside its parent. Planning is therefore symmetric — the agent proposes a
// single child workspace, the parent can be the project root (creating
// what used to be a top-level project) or any nested workspace (creating
// what used to be a task). No project-vs-task distinction.

import { z } from "zod";
import { defineTool, type WorkbenchTool } from "./types";

export function buildWorkspacePlanningTools(): WorkbenchTool[] {
  return [
    defineTool(
      "propose_workspace",
      "Propose a new workspace to the user. Call this once you have enough context. The user will see your proposal as an editable card and can accept or revise it. The proposal may optionally include initial child workspaces if a clear breakdown emerged from the chat.",
      {
        workspace_slug: z.string().describe("Human-readable workspace name with proper case and spaces, e.g. 'House Sale', 'Buy in Paris', 'Tax 2025'. NOT kebab-case. The folder name is the display name."),
        workspace_overview: z.string().describe("Concise one-sentence summary of what this workspace is (~20 words, never more than one paragraph). Shown verbatim at the top of the workspace view, so it must read like a tweet, not a paragraph. Push goals, criteria, context, and constraints into workspace_details instead."),
        workspace_details: z.string().describe("Longer markdown body with goals, criteria, constraints, context, and any decisions surfaced in this chat. This is where verbose content belongs — the overview should stay short by pushing detail here. May be empty if there's truly nothing beyond the overview."),
        children: z.array(z.object({
          slug: z.string().describe("Human-readable child name with proper case and spaces. NOT kebab-case."),
          overview: z.string().describe("Concise one-sentence summary of the child workspace (~20 words). Push detail into the details field."),
          details: z.string().describe("Longer markdown body for the child brief. May be empty for simple ones."),
        })).max(8).optional().describe("Optional initial child workspaces. Include them only when the chat surfaced a clear breakdown; omit otherwise — the user can add children later."),
      },
      async ({ workspace_slug, children }) => {
        const childCount = children?.length ?? 0;
        const text = childCount > 0
          ? `Proposed workspace "${workspace_slug}" with ${childCount} child(ren). Waiting for the user to accept or revise.`
          : `Proposed workspace "${workspace_slug}". Waiting for the user to accept or revise.`;
        return { content: [{ type: "text", text }] };
      },
    ),
  ];
}

// System prompt for the "New workspace" chat. The parent context (the slug
// chain, its overview, existing children) is interpolated in so the agent
// can fit the new workspace naturally and avoid duplicates without having to
// walk the filesystem first.
//
// `parentPath` is the slug chain of the parent — `[]` when creating a
// top-level workspace, `["HR"]` when creating one under `HR`, and so on.
export function buildWorkspacePlanningSystemPrompt(
  parentPath: string[],
  parentOverview: string,
  existingChildSlugs: string[],
): string {
  const existing = existingChildSlugs.length
    ? existingChildSlugs.map((s) => `  - ${s}`).join("\n")
    : "  _(none yet)_";
  const desc = parentOverview.trim() || "_(parent workspace overview is empty)_";
  const breadcrumb = parentPath.length > 0 ? parentPath.join(" > ") : "(root)";
  const folderHint = parentPath.length > 0
    ? `\`projects/${parentPath.join("/")}/\``
    : "`projects/` (top level)";

  return `You are helping the user define a new workspace under **${breadcrumb}** in their personal task management system "Coworking Space".

A workspace is a coherent unit of work. Workspaces are nestable: a root workspace groups related work; child workspaces refine it further; an AI agent can pick up any workspace cold and execute. The goal of this chat is to produce a clean \`workspace.json\` brief — written so a future agent can start without re-asking the user. The brief has shape \`{ "overview": "one line", "details": "markdown body", "createdAt": "..." }\`.

**Parent context**
- Path: ${breadcrumb}
- Folder: ${folderHint}
- Overview: ${desc}
- Existing siblings (children of this parent):
${existing}

The workspace structure and conventions are documented in the repo's CLAUDE.md — read it if you haven't already. Read related \`workspace.json\` files in sibling workspaces if it helps you pick a name and overview that fits.

**Naming convention**: workspace names are **human-readable, with proper case and spaces** — they are the literal folder names. Use "Draft Email to School" not "draft-email-to-school". Capitalize like a title (articles/prepositions lowercase mid-name). Keep names short (2-4 words). Avoid collisions with the siblings above.

Your job:
1. Ask the user (one short question at a time) what the workspace is about and what "done" looks like.
2. Once you have enough context — usually after 1-3 questions — call the \`propose_workspace\` tool with:
   - \`workspace_slug\`: human-readable name
   - \`workspace_overview\`: a concise one-sentence summary (~20 words max). Must read like a tweet, not a paragraph. Push everything else into details.
   - \`workspace_details\`: longer markdown body — goals, inputs, outputs, constraints, decisions. May be empty for simple workspaces. This is the artifact — make it good.
   - \`children\` (optional): 2-5 initial child workspaces if a clear breakdown emerged. Omit for a leaf.
3. After proposing, wait. If the user revises, propose again with the changes.

Keep your messages short and conversational. The user is moving fast; be brief.
`;
}
