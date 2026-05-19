// File-based comment storage. Each task gets a `.comments.json` file inside
// its task folder, so when a task is renamed or moved the comments travel
// with it automatically.
//
// Schema:
//   { next_id: number, comments: StoredComment[] }
//
// IDs are unique per-task and monotonically increasing (never reused).

import fs from "node:fs/promises";
import path from "node:path";
import { getProject, taskDir, projectDir } from "./fs";

export interface StoredComment {
  id: number;
  filePath: string;
  anchorType: "md" | "html";
  anchor: { prefix?: string; exact?: string; suffix?: string; quote?: string };
  body: string;
  author: string;
  createdAt: string;        // ISO timestamp
  updatedAt: string | null; // ISO timestamp, set when body is edited
  resolvedAt: string | null;
}

interface CommentsFile {
  next_id: number;
  comments: StoredComment[];
}

// Returns the path to the .comments.json file for a project or task.
// - If taskSlug is provided, returns the task-level comments file.
// - If taskSlug is empty/null, returns the project-level comments file.
async function pathFor(projectSlug: string, taskSlug: string): Promise<string | null> {
  const project = await getProject(projectSlug);
  if (!project) return null;

  // Project-level comments (no task)
  if (!taskSlug) {
    return path.join(projectDir(project), ".comments.json");
  }

  // Task-level comments
  const task = project.tasks.find((t) => t.slug === taskSlug);
  if (!task) return null;
  return path.join(taskDir(project, task), ".comments.json");
}

async function read(file: string): Promise<CommentsFile> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.next_id !== "number" || !Array.isArray(parsed?.comments)) {
      return { next_id: 1, comments: [] };
    }
    return parsed as CommentsFile;
  } catch {
    return { next_id: 1, comments: [] };
  }
}

async function write(file: string, data: CommentsFile): Promise<void> {
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export async function listComments(projectSlug: string, taskSlug: string, filePath?: string): Promise<StoredComment[]> {
  const p = await pathFor(projectSlug, taskSlug);
  if (!p) return [];
  const f = await read(p);
  return filePath ? f.comments.filter((c) => c.filePath === filePath) : f.comments;
}

export async function commentCounts(projectSlug: string, taskSlug: string): Promise<Record<string, number>> {
  const p = await pathFor(projectSlug, taskSlug);
  if (!p) return {};
  const f = await read(p);
  const out: Record<string, number> = {};
  for (const c of f.comments) out[c.filePath] = (out[c.filePath] ?? 0) + 1;
  return out;
}

export async function addComment(
  projectSlug: string,
  taskSlug: string,
  input: Omit<StoredComment, "id" | "createdAt" | "updatedAt" | "resolvedAt"> & { createdAt?: string },
): Promise<StoredComment> {
  const p = await pathFor(projectSlug, taskSlug);
  if (!p) throw new Error(`unknown task ${projectSlug}/${taskSlug}`);
  const f = await read(p);
  const id = f.next_id;
  const created: StoredComment = {
    id,
    filePath: input.filePath,
    anchorType: input.anchorType,
    anchor: input.anchor,
    body: input.body,
    author: input.author,
    createdAt: input.createdAt ?? new Date().toISOString(),
    updatedAt: null,
    resolvedAt: null,
  };
  f.comments.push(created);
  f.next_id = id + 1;
  await write(p, f);
  return created;
}

export async function deleteComment(projectSlug: string, taskSlug: string, id: number): Promise<StoredComment | null> {
  const p = await pathFor(projectSlug, taskSlug);
  if (!p) return null;
  const f = await read(p);
  const idx = f.comments.findIndex((c) => c.id === id);
  if (idx < 0) return null;
  const [removed] = f.comments.splice(idx, 1);
  await write(p, f);
  return removed;
}

export async function setResolved(projectSlug: string, taskSlug: string, id: number, resolved: boolean): Promise<void> {
  const p = await pathFor(projectSlug, taskSlug);
  if (!p) return;
  const f = await read(p);
  const c = f.comments.find((x) => x.id === id);
  if (!c) return;
  c.resolvedAt = resolved ? new Date().toISOString() : null;
  await write(p, f);
}

export async function updateComment(projectSlug: string, taskSlug: string, id: number, body: string): Promise<StoredComment | null> {
  const p = await pathFor(projectSlug, taskSlug);
  if (!p) return null;
  const f = await read(p);
  const c = f.comments.find((x) => x.id === id);
  if (!c) return null;
  c.body = body;
  c.updatedAt = new Date().toISOString();
  await write(p, f);
  return c;
}
