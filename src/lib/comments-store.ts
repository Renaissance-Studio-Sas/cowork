// File-based comment storage. Each workspace gets a `.comments.json` file
// inside its workspace folder, so when a workspace is renamed or moved the
// comments travel with it automatically.
//
// Schema:
//   { next_id: number, comments: StoredComment[] }
//
// IDs are unique per-workspace and monotonically increasing (never reused).

import fs from "node:fs/promises";
import path from "node:path";
import { getWorkspace, workspaceDir } from "./fs";

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

// Returns the path to the .comments.json file for a workspace, or null if
// the workspace doesn't exist on disk.
async function pathFor(workspacePath: string[]): Promise<string | null> {
  const ws = await getWorkspace(workspacePath);
  if (!ws) return null;
  return path.join(workspaceDir(ws), ".comments.json");
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

export async function listComments(workspacePath: string[], filePath?: string): Promise<StoredComment[]> {
  const p = await pathFor(workspacePath);
  if (!p) return [];
  const f = await read(p);
  return filePath ? f.comments.filter((c) => c.filePath === filePath) : f.comments;
}

export async function commentCounts(workspacePath: string[]): Promise<Record<string, number>> {
  const p = await pathFor(workspacePath);
  if (!p) return {};
  const f = await read(p);
  const out: Record<string, number> = {};
  for (const c of f.comments) out[c.filePath] = (out[c.filePath] ?? 0) + 1;
  return out;
}

export async function addComment(
  workspacePath: string[],
  input: Omit<StoredComment, "id" | "createdAt" | "updatedAt" | "resolvedAt"> & { createdAt?: string },
): Promise<StoredComment> {
  const p = await pathFor(workspacePath);
  if (!p) throw new Error(`unknown workspace ${workspacePath.join("/")}`);
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

export async function deleteComment(workspacePath: string[], id: number): Promise<StoredComment | null> {
  const p = await pathFor(workspacePath);
  if (!p) return null;
  const f = await read(p);
  const idx = f.comments.findIndex((c) => c.id === id);
  if (idx < 0) return null;
  const [removed] = f.comments.splice(idx, 1);
  await write(p, f);
  return removed;
}

export async function setResolved(workspacePath: string[], id: number, resolved: boolean): Promise<void> {
  const p = await pathFor(workspacePath);
  if (!p) return;
  const f = await read(p);
  const c = f.comments.find((x) => x.id === id);
  if (!c) return;
  c.resolvedAt = resolved ? new Date().toISOString() : null;
  await write(p, f);
}

export async function updateComment(workspacePath: string[], id: number, body: string): Promise<StoredComment | null> {
  const p = await pathFor(workspacePath);
  if (!p) return null;
  const f = await read(p);
  const c = f.comments.find((x) => x.id === id);
  if (!c) return null;
  c.body = body;
  c.updatedAt = new Date().toISOString();
  await write(p, f);
  return c;
}
