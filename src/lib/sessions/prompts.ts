// System prompt + label generation helpers. Self-contained — only touches
// the filesystem and the project lookup helpers, so it sits at the bottom
// of the sessions module dependency graph.

import fs from "node:fs/promises";
import path from "node:path";
import { getProject, PROJECTS_DIR } from "../fs";

// Build a system prompt that includes project.md and task.md context so the
// agent knows what project/task it's working in. Returns undefined if no
// context files exist (letting the SDK use its default preset).
export async function buildContextSystemPrompt(
  projectSlug: string,
  taskSlug: string,
): Promise<{ type: "preset"; preset: "claude_code"; append: string } | undefined> {
  const parts: string[] = [];

  // Read project.md
  try {
    const projectMdPath = path.join(PROJECTS_DIR, `wip-${projectSlug}`, "files", "project.md");
    const projectContent = await fs.readFile(projectMdPath, "utf8");
    if (projectContent.trim()) {
      parts.push(`<project-context>\n# Project: ${projectSlug}\n\n${projectContent.trim()}\n</project-context>`);
    }
  } catch {
    // Try done- prefix
    try {
      const projectMdPath = path.join(PROJECTS_DIR, `done-${projectSlug}`, "files", "project.md");
      const projectContent = await fs.readFile(projectMdPath, "utf8");
      if (projectContent.trim()) {
        parts.push(`<project-context>\n# Project: ${projectSlug}\n\n${projectContent.trim()}\n</project-context>`);
      }
    } catch { /* no project.md */ }
  }

  // Read task.md
  if (taskSlug) {
    try {
      const project = await getProject(projectSlug);
      if (project) {
        const task = project.tasks.find((t) => t.slug === taskSlug);
        if (task) {
          const taskMdPath = path.join(PROJECTS_DIR, project.folderName, task.folderName, "files", "task.md");
          const taskContent = await fs.readFile(taskMdPath, "utf8");
          if (taskContent.trim()) {
            parts.push(`<task-context>\n# Task: ${taskSlug}\n\n${taskContent.trim()}\n</task-context>`);
          }
        }
      }
    } catch { /* no task.md */ }
  }

  if (parts.length === 0) return undefined;

  const contextPrompt = `
You are working within the Agent Workbench on a specific project and task. Here is the context:

${parts.join("\n\n")}

Use this context to understand the goals, requirements, and current state of work. When relevant, refer back to these documents for guidance.

## Inline Media in Chat

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

  return { type: "preset", preset: "claude_code", append: contextPrompt };
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
