// System prompt + label generation helpers. Self-contained — only touches
// the filesystem and the project lookup helpers, so it sits at the bottom
// of the sessions module dependency graph.

import fs from "node:fs/promises";
import path from "node:path";
import { getProject, PROJECTS_DIR, WORKSPACE_ROOT } from "../fs";

// Build the per-session system prompt. Always returns a prompt (never
// undefined) so the agent always knows what project/task it's working on
// and where files live. Includes project.md and task.md verbatim when
// they exist; otherwise notes the file is empty and points the agent at
// the location to write to.
//
// The agent's working directory is the cowork workspace root (set by the
// caller — see sessions.ts). That's where CLAUDE.md / GEMINI.md live, and
// where `projects/<wip-project>/<wip-task>/` is reachable. We tell the
// agent the EXPLICIT relative path to the task folder so file operations
// go to the right place.
export async function buildContextSystemPrompt(
  projectSlug: string,
  taskSlug: string,
  currentTitle?: string,
): Promise<{ type: "preset"; preset: "claude_code"; append: string }> {
  // Resolve the task folder relative to the workspace root. We need the
  // actual folder name (`wip-…` or `done-…`), not just the slug, because
  // the agent will reference it in file ops.
  const project = await getProject(projectSlug).catch(() => null);
  let taskFolderRel: string | null = null;
  let projectFolderRel: string | null = null;
  if (project) {
    projectFolderRel = path.join("projects", project.folderName);
    if (taskSlug) {
      const task = project.tasks.find((t) => t.slug === taskSlug);
      if (task) taskFolderRel = path.join(projectFolderRel, task.folderName);
    }
  }

  // Read project.md and task.md if they exist. Missing files are not an
  // error — the agent gets a "not yet written" placeholder so it knows
  // the file is supposed to be there and that writing to it is a normal
  // first step on a new project/task.
  const projectMd = projectFolderRel
    ? await readIfExists(path.join(WORKSPACE_ROOT, projectFolderRel, "files", "project.md"))
    : null;
  const taskMd = taskFolderRel
    ? await readIfExists(path.join(WORKSPACE_ROOT, taskFolderRel, "files", "task.md"))
    : null;

  const where = taskFolderRel
    ? `task **${taskSlug}** in project **${projectSlug}**`
    : `project **${projectSlug}** (project-level — no specific task)`;

  const pathLine = taskFolderRel
    ? `Task folder (relative to workspace root): \`${taskFolderRel}/\`\nProject folder: \`${projectFolderRel}/\``
    : `Project folder: \`${projectFolderRel ?? "(unknown)"}/\``;

  const projectMdBlock = projectFolderRel
    ? formatMdSection(
        "Project context",
        path.join(projectFolderRel, "files", "project.md"),
        projectMd,
      )
    : "";

  const taskMdBlock = taskFolderRel
    ? formatMdSection(
        "Task context",
        path.join(taskFolderRel, "files", "task.md"),
        taskMd,
      )
    : "";

  const titleBlock = currentTitle
    ? `## Session title

This session is currently titled "${currentTitle}" — that's an auto-generated
placeholder derived from the first message. In your first response, call
\`set_session_title\` with a 3-6 word summary of what you're actually working
on (e.g. "Added dark mode toggle", "Fixed login validation bug"). Skip filler
words like "Implemented", "Updated", "Changed". If the existing title already
captures the work accurately, leave it alone.

`
    : "";

  const append = `
You are working in the **cowork agent workbench** on ${where}.

Your working directory is the workspace root. Repo-level conventions are
in **CLAUDE.md** / **GEMINI.md** at the workspace root — read those if you
haven't already.

${pathLine}

When you write output files for this task, put them under the task's
\`files/\` directory using the path above. When you read or modify
project.md / task.md, use the paths shown in the sections below.

${projectMdBlock}${taskMdBlock}${titleBlock}## Inline Media in Chat

You can display images and videos inline in your chat responses using markdown syntax:

**Basic syntax:**
- Image: \`![alt text](url)\`
- Video: \`![alt text](url.mp4)\` (automatically detected by extension: mp4, webm, mov, avi, mkv, m4v)

**With custom dimensions** (append \`|width\` or \`|widthxheight\` to alt text):
- \`![description|800](url)\` — 800px wide, maintains aspect ratio
- \`![description|800x600](url)\` — exact 800x600 dimensions

**For files in the task folder**, use the raw file API:
\`\`\`
![screenshot|600](/api/files/raw?project=PROJECT&task=TASK&path=uploads/image.png)
![demo video|800](/api/files/raw?project=PROJECT&task=TASK&path=uploads/demo.mp4)
\`\`\`

Replace PROJECT and TASK with the current project/task slugs (URL-encoded). Files in the task's \`files/\` directory are served via this API.
`.trim();

  return { type: "preset", preset: "claude_code", append };
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    const content = await fs.readFile(p, "utf8");
    return content.trim() ? content.trim() : "";
  } catch {
    return null;
  }
}

function formatMdSection(label: string, relPath: string, content: string | null): string {
  if (content === null) {
    return `## ${label} (\`${relPath}\`)\n\n_File not yet written. Create it if you have something to record there._\n\n`;
  }
  if (content === "") {
    return `## ${label} (\`${relPath}\`)\n\n_File exists but is empty._\n\n`;
  }
  return `## ${label} (\`${relPath}\`)\n\n${content}\n\n`;
}

// Generate a short label from the first message by extracting key words.
// Produces labels like "Add dark mode", "Fix login bug", "Session names feature"
export function generateSessionLabel(firstMessage: string): string {
  const text = firstMessage
    .trim()
    .replace(/^(can you|could you|please|hey|hi|hello|I want to|I need to|I'd like to|let's|we should)\s*/gi, "")
    .replace(/[?!.]+$/, "")
    .trim();

  const words = text.split(/\s+/);
  if (words.length === 0) return "New session";

  // Capitalize first letter
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);

  // Take first ~5 words or ~40 chars, whichever is shorter
  let label = "";
  for (const word of words) {
    if (label.length + word.length > 40) break;
    label += (label ? " " : "") + word;
  }

  return label || "New session";
}
