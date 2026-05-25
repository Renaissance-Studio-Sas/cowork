// System prompt + label generation helpers. Self-contained — only touches
// the filesystem and the project lookup helpers, so it sits at the bottom
// of the sessions module dependency graph.

import fs from "node:fs/promises";
import path from "node:path";
import {
  getProject,
  PROJECT_BRIEF_FILENAME,
  PROJECTS_DIR,
  TASK_BRIEF_FILENAME,
  WORKSPACE_ROOT,
  type Brief,
} from "../fs";

// Build the per-session system prompt. Always returns a prompt (never
// undefined) so the agent always knows what project/task it's working on
// and where files live. Includes the project.json and task.json briefs
// verbatim when they exist; otherwise notes the file is empty and points
// the agent at the location to write to.
//
// The agent's working directory is the cowork workspace root (set by the
// caller — see sessions.ts). That's where CLAUDE.md / GEMINI.md live, and
// where `projects/<project>/<task>/` is reachable. We tell the agent the
// EXPLICIT relative path to the task folder so file operations go to the
// right place.
export async function buildContextSystemPrompt(
  projectSlug: string,
  taskSlug: string,
  currentTitle?: string,
): Promise<{ type: "preset"; preset: "claude_code"; append: string }> {
  // Resolve the task folder relative to the workspace root. We need the
  // actual folder name (which carries " [Archived]" when archived), not
  // just the slug, because the agent will reference it in file ops.
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

  // Read the project.json and task.json briefs if they exist. Missing
  // files are not an error — the agent gets a "not yet written"
  // placeholder so it knows the file is supposed to be there and that
  // writing to it is a normal first step on a new project/task.
  const projectBrief = projectFolderRel
    ? await readBriefIfExists(path.join(WORKSPACE_ROOT, projectFolderRel, "files", PROJECT_BRIEF_FILENAME))
    : null;
  const taskBrief = taskFolderRel
    ? await readBriefIfExists(path.join(WORKSPACE_ROOT, taskFolderRel, "files", TASK_BRIEF_FILENAME))
    : null;

  const where = taskFolderRel
    ? `task **${taskSlug}** in project **${projectSlug}**`
    : `project **${projectSlug}** (project-level — no specific task)`;

  const pathLine = taskFolderRel
    ? `Task folder (relative to workspace root): \`${taskFolderRel}/\`\nProject folder: \`${projectFolderRel}/\``
    : `Project folder: \`${projectFolderRel ?? "(unknown)"}/\``;

  const projectBriefBlock = projectFolderRel
    ? formatBriefSection(
        "Project context",
        path.join(projectFolderRel, "files", PROJECT_BRIEF_FILENAME),
        projectBrief,
      )
    : "";

  const taskBriefBlock = taskFolderRel
    ? formatBriefSection(
        "Task context",
        path.join(taskFolderRel, "files", TASK_BRIEF_FILENAME),
        taskBrief,
      )
    : "";

  const titleBlock = currentTitle
    ? `## Session title

This session is currently titled "${currentTitle}" — a placeholder derived
from your first message. The workbench will auto-generate a better title
after your first turn ends; you don't need to do anything. If the auto-title
turns out wrong later, call \`set_session_title\` to override it.

`
    : "";

  const append = `
You are working in the **cowork agent workbench** on ${where}.

Your working directory is the workspace root. Repo-level conventions are
in **CLAUDE.md** / **GEMINI.md** at the workspace root — read those if you
haven't already.

${pathLine}

When you write output files for this task, put them under the task's
\`files/\` directory using the path above. When you read or modify the
project/task brief, edit the JSON file shown in the section below — it
has the shape \`{ "overview": "...", "details": "...", "createdAt": "..." }\`
where \`overview\` is a one-line summary and \`details\` is markdown.

${projectBriefBlock}${taskBriefBlock}${titleBlock}## Inline Media in Chat

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

async function readBriefIfExists(p: string): Promise<Brief | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<Brief>;
    return {
      overview: typeof parsed.overview === "string" ? parsed.overview : "",
      details: typeof parsed.details === "string" ? parsed.details : "",
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    };
  } catch {
    return null;
  }
}

function formatBriefSection(label: string, relPath: string, brief: Brief | null): string {
  if (brief === null) {
    return `## ${label} (\`${relPath}\`)\n\n_File not yet written. Create it if you have something to record there._\n\n`;
  }
  const overview = brief.overview.trim();
  const details = brief.details.trim();
  if (!overview && !details) {
    return `## ${label} (\`${relPath}\`)\n\n_File exists but overview and details are empty._\n\n`;
  }
  const overviewLine = overview ? `**Overview:** ${overview}\n\n` : "";
  const detailsBlock = details ? `${details}\n\n` : "";
  return `## ${label} (\`${relPath}\`)\n\n${overviewLine}${detailsBlock}`;
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
