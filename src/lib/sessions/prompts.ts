// System prompt + label generation helpers. Self-contained — only touches
// the filesystem and the workspace lookup helpers, so it sits at the bottom
// of the sessions module dependency graph.

import fs from "node:fs/promises";
import path from "node:path";
import {
  getWorkspace,
  WORKSPACE_BRIEF_FILENAME,
  WORKSPACE_ROOT,
  WORKSPACES_DIR,
  workspaceDir,
  type Brief,
} from "../fs";

// Operating-context file loaded into every session's system prompt verbatim at
// session start (and re-applied on resume). Lives at the root of the local
// workspaces dir — `<COWORK_LOCAL_DIR>/Context.md` (e.g. ~/Documents/Cowork/
// Local/Context.md). Holds the standing context (people, accounts, conventions)
// the agent should always have, so we inject it rather than asking it to read.
const CONTEXT_FILENAME = "Context.md";

async function readOperatingContext(): Promise<string | null> {
  try {
    const raw = (await fs.readFile(path.join(WORKSPACES_DIR, CONTEXT_FILENAME), "utf8")).trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null; // no Context.md — nothing to inject
  }
}

// Build the per-session system prompt. Always returns a prompt (never
// undefined) so the agent always knows what workspace it's working in and
// where files live. Includes the workspace.json briefs along the ancestor
// chain verbatim when they exist; otherwise notes the file is empty and
// points the agent at the location to write to.
//
// The agent's working directory is the cowork workspace root (set by the
// caller — see sessions.ts). That's where CLAUDE.md / GEMINI.md live, and
// where `projects/<workspace-path>/` is reachable. We tell the agent the
// EXPLICIT relative path to the workspace folder so file operations go to
// the right place.
// A workspace path the agent can use directly from its cwd (WORKSPACE_ROOT):
// the relative path when the target is inside the repo, else the absolute path
// (avoids fragile `../`-escaping hints when COWORK_LOCAL_DIR is outside it).
function pathHintFor(absDir: string): string {
  const rel = path.relative(WORKSPACE_ROOT, absDir);
  return rel.startsWith("..") || path.isAbsolute(rel) ? absDir : rel;
}

export async function buildContextSystemPrompt(
  workspacePath: string[],
  currentTitle?: string,
): Promise<{ type: "preset"; preset: "claude_code"; append: string }> {
  // Resolve the workspace folder relative to the project root, plus each
  // ancestor for the brief chain. Folder names carry " [Archived]" when
  // archived, so we use them rather than just the slugs in path hints the
  // agent will reference.
  const ws = await getWorkspace(workspacePath).catch(() => null);
  const ancestors: Array<{ label: string; relPath: string; brief: Brief | null }> = [];
  let folderRel: string | null = null;
  if (ws) {
    // Path the agent should use to reach the workspace from its cwd
    // (WORKSPACE_ROOT). Relative when the workspace dir lives inside the repo;
    // absolute when COWORK_LOCAL_DIR has relocated it outside (a `../`-escaping
    // relative path would be fragile, so hand the agent the absolute path).
    folderRel = pathHintFor(workspaceDir(ws));
    // Walk down the slug chain to read each ancestor's brief in turn — gives
    // the agent the full breadcrumb context, not just the leaf.
    for (let i = 1; i <= workspacePath.length; i++) {
      const partial = workspacePath.slice(0, i);
      const node = await getWorkspace(partial).catch(() => null);
      if (!node) continue;
      const absNode = workspaceDir(node);
      const brief = await readBriefIfExists(path.join(absNode, WORKSPACE_BRIEF_FILENAME));
      ancestors.push({
        label: partial.join(" > "),
        relPath: path.join(pathHintFor(absNode), WORKSPACE_BRIEF_FILENAME),
        brief,
      });
    }
  }

  const breadcrumb = workspacePath.join(" > ");
  const where = `workspace **${breadcrumb}**`;

  const pathLine = folderRel
    ? `Workspace folder (path is relative to your working directory unless absolute): \`${folderRel}/\``
    : `Workspace folder: (unknown — workspace ${breadcrumb} not found on disk)`;

  // One brief block per ancestor, top-down.
  const briefBlocks = ancestors
    .map((a) => formatBriefSection(`Context for ${a.label}`, a.relPath, a.brief))
    .join("");

  const titleBlock = currentTitle
    ? `## Session title

This session is currently titled "${currentTitle}" — a placeholder derived
from your first message. The workbench will auto-generate a better title
after your first turn ends; you don't need to do anything. If the auto-title
turns out wrong later, call \`set_session_title\` to override it.

`
    : "";

  const apiPath = workspacePath.map(encodeURIComponent).join("/");

  // Standing operating context (Local/Context.md), injected verbatim so it's
  // always in scope without the agent having to discover and read it.
  const operatingContext = await readOperatingContext();
  const contextBlock = operatingContext
    ? `## Operating context

The following is your standing operating context (people, accounts, tools, and
conventions). It is always in scope — treat it as authoritative background.

${operatingContext}

---

`
    : "";

  const append = `
You are working in the **cowork agent workbench** on ${where}.

Your working directory is the workspace root. Repo-level conventions are
in **CLAUDE.md** / **GEMINI.md** at the workspace root — read those if you
haven't already.

${contextBlock}${pathLine}

When you write output files for this workspace, put them directly in the
workspace folder shown above (artifacts live alongside the workspace.json
brief — there is no \`files/\` subfolder). When you read or
modify the workspace brief, edit the JSON file shown in the section below —
it has the shape \`{ "overview": "...", "details": "...", "createdAt": "..." }\`
where \`overview\` is a one-line summary and \`details\` is markdown.

${briefBlocks}${titleBlock}## Inline Media in Chat

You can display images and videos inline in your chat responses using markdown syntax:

**Basic syntax:**
- Image: \`![alt text](url)\`
- Video: \`![alt text](url.mp4)\` (automatically detected by extension: mp4, webm, mov, avi, mkv, m4v)

**With custom dimensions** (append \`|width\` or \`|widthxheight\` to alt text):
- \`![description|800](url)\` — 800px wide, maintains aspect ratio
- \`![description|800x600](url)\` — exact 800x600 dimensions

**For files in the workspace folder**, use the raw file API:
\`\`\`
![screenshot|600](/api/files/raw?workspace=${apiPath}&path=uploads/image.png)
![demo video|800](/api/files/raw?workspace=${apiPath}&path=uploads/demo.mp4)
\`\`\`

The \`workspace\` query parameter is the slash-joined slug chain
(URL-encoded). Files in the workspace folder are served via this API.
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

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "New session";

  // Take first ~5 words or ~40 chars, whichever is shorter. A leading token
  // that's too long to fit on its own (e.g. a pasted URL or file path) is
  // skipped rather than allowed to break the loop and leave the label empty —
  // otherwise any message starting with a URL collapses to "New session".
  let label = "";
  for (const word of words) {
    if (label.length + (label ? 1 : 0) + word.length > 40) {
      if (label) break; // already have words — stop here
      continue; // first token too long — skip it and keep looking
    }
    label += (label ? " " : "") + word;
  }

  if (!label) return "New session";

  // Capitalize the first letter of the chosen label.
  return label.charAt(0).toUpperCase() + label.slice(1);
}
