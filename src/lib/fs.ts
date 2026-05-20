import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { relocateSessionsForProject, relocateSessionsForTask } from "./sessions";

// The Claude Agent SDK stores per-session transcripts under
// `~/.claude/projects/<encoded-cwd>/<sdkSessionId>.jsonl`, where encoded-cwd
// is the absolute cwd with `/` swapped for `-`. When we rename or move a
// project/task folder, the cwd of every session in it changes — and the SDK
// won't find the prior transcript at the new encoded path. Resuming silently
// fails: only an `init` event is emitted and the agent never replies. Rename
// the SDK transcript directories alongside the project/task folders so resume
// keeps working.
//
// Exported so the startup reconciliation pass (reconcileSessionsOnDisk) can
// also call it when it detects that a session's meta.json cwd drifted from
// the folder it actually lives in.
export async function relocateSdkTranscripts(oldAbsPath: string, newAbsPath: string): Promise<void> {
  const encode = (p: string) => p.replaceAll("/", "-");
  const base = path.join(os.homedir(), ".claude", "projects");
  const oldPrefix = encode(oldAbsPath);
  const newPrefix = encode(newAbsPath);
  let entries: string[];
  try {
    entries = await fs.readdir(base);
  } catch { return; }
  // Match the project/task itself plus any descendant task dirs whose encoded
  // names share that prefix (e.g. renaming a project also relocates its tasks).
  for (const name of entries) {
    if (name !== oldPrefix && !name.startsWith(oldPrefix + "-")) continue;
    const renamed = newPrefix + name.slice(oldPrefix.length);
    try {
      await fs.rename(path.join(base, name), path.join(base, renamed));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        console.warn(`[fs] could not relocate SDK transcripts ${name} → ${renamed}:`, e.message);
      }
    }
  }
}

// Workspace root: the user's own repo / folder that contains `projects/` plus any
// shared resources (CLAUDE.md, skills/, scripts/, etc.). Agents get read/write
// access to this whole tree via `additionalDirectories` so they can pull in
// context from anywhere in the repo.
//
// Set WORKSPACE_ROOT in `.env` to point at any directory; defaults to `../..`
// relative to cwd (the legacy layout where this app lived inside a monorepo).
export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT
  ? path.resolve(process.env.WORKSPACE_ROOT)
  : path.resolve(process.cwd(), "..", "..");

// Directory holding `wip-<project>/` and `done-<project>/` folders. Lives
// inside the workspace root so the rest of the repo can host CLAUDE.md and
// other shared files.
// Convention: <WORKSPACE_ROOT>/projects/<project>/<task>/{files,sessions,task.md}
export const PROJECTS_DIR = path.join(WORKSPACE_ROOT, "projects");

export type Status = "wip" | "done";

export interface Frontmatter {
  labels?: string[];
  created?: string;
  [k: string]: unknown;
}

export interface Project {
  slug: string;            // bare slug, without status prefix
  folderName: string;      // e.g. "wip-inbox"
  status: Status;
  description: string;     // body of project.md (without frontmatter)
  labels: string[];
  tasks: Task[];
}

export interface Task {
  slug: string;
  folderName: string;
  projectSlug: string;
  status: Status;
  description: string;
  labels: string[];
}

const STATUS_PREFIX_RE = /^(wip|done)-(.+)$/;

function parsePrefixed(folderName: string): { status: Status; slug: string } | null {
  const m = folderName.match(STATUS_PREFIX_RE);
  if (!m) return null;
  return { status: m[1] as Status, slug: m[2] };
}

// The folder name *is* the display name. Sanitize only what the filesystem
// genuinely can't handle (path separators + a few illegal chars) and what
// would clash with our prefix scheme. Preserve case, spaces, and most
// punctuation so renames keep the user's intent intact.
function sanitizeName(s: string): string {
  let out = s.normalize("NFC").trim();
  out = out.replace(/[/\\:*?"<>|]+/g, "-");
  out = out.replace(/\s+/g, " ");
  out = out.replace(/^[.-]+|[.-]+$/g, "");
  // Don't allow names starting with wip- or done- — those would create
  // ambiguous nested prefixes.
  out = out.replace(/^(wip|done)-+/i, "");
  return out.slice(0, 80);
}

async function readMarkdown(filePath: string): Promise<{ description: string; fm: Frontmatter }> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = matter(raw);
    return { description: parsed.content.trim(), fm: parsed.data as Frontmatter };
  } catch {
    return { description: "", fm: {} };
  }
}

async function writeMarkdown(filePath: string, description: string, fm: Frontmatter): Promise<void> {
  const body = matter.stringify(description.trim() + "\n", fm);
  await fs.writeFile(filePath, body, "utf8");
}

export async function ensureWorkspace(): Promise<void> {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  // Bootstrap a default `wip-todo/` catch-all ONLY when the workspace has no
  // projects at all (fresh install). Once the user has any project, we never
  // auto-create — they're free to rename, delete, or replace the catch-all.
  let hasAnyProject = false;
  try {
    const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    hasAnyProject = entries.some((e) => e.isDirectory() && /^(wip|done)-/.test(e.name));
  } catch { /* empty or missing — treat as no projects */ }
  if (hasAnyProject) return;

  const todoPath = path.join(PROJECTS_DIR, "wip-todo");
  await fs.mkdir(path.join(todoPath, "files"), { recursive: true });
  await writeMarkdown(
    path.join(todoPath, "files", "project.md"),
    "Default project. Tasks that don't belong to a larger project go here.",
    { labels: ["todo"], created: new Date().toISOString().slice(0, 10) },
  );
}

export async function listProjects(): Promise<Project[]> {
  await ensureWorkspace();
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const projects: Project[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const parsed = parsePrefixed(e.name);
    if (!parsed) continue;
    const projectDir = path.join(PROJECTS_DIR, e.name);
    // project.md lives inside files/ so it shows up as a regular artifact
    // (same convention as task.md). Fall back to the legacy root location.
    let parsed_md = await readMarkdown(path.join(projectDir, "files", "project.md"));
    if (!parsed_md.description && Object.keys(parsed_md.fm).length === 0) {
      parsed_md = await readMarkdown(path.join(projectDir, "project.md"));
    }
    const { description, fm } = parsed_md;
    const tasks = await listTasks(e.name);
    projects.push({
      slug: parsed.slug,
      folderName: e.name,
      status: parsed.status,
      description,
      labels: Array.isArray(fm.labels) ? fm.labels : [],
      tasks,
    });
  }
  projects.sort((a, b) => {
    if (a.status !== b.status) return a.status === "wip" ? -1 : 1;
    return a.slug.localeCompare(b.slug);
  });
  return projects;
}

async function listTasks(projectFolder: string): Promise<Task[]> {
  const projectDir = path.join(PROJECTS_DIR, projectFolder);
  const projectSlug = parsePrefixed(projectFolder)!.slug;
  const out: Task[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(projectDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const parsed = parsePrefixed(e.name);
    if (!parsed) continue;
    const taskDir = path.join(projectDir, e.name);
    // task.md is now inside files/ — it's treated as a regular artifact.
    const { description, fm } = await readMarkdown(path.join(taskDir, "files", "task.md"));
    out.push({
      slug: parsed.slug,
      folderName: e.name,
      projectSlug,
      status: parsed.status,
      description,
      labels: Array.isArray(fm.labels) ? fm.labels : [],
    });
  }
  out.sort((a, b) => {
    if (a.status !== b.status) return a.status === "wip" ? -1 : 1;
    return a.slug.localeCompare(b.slug);
  });
  return out;
}

export async function getProject(slug: string): Promise<Project | null> {
  const projects = await listProjects();
  return projects.find((p) => p.slug === slug) ?? null;
}

export async function getTask(projectSlug: string, taskSlug: string): Promise<Task | null> {
  const project = await getProject(projectSlug);
  if (!project) return null;
  return project.tasks.find((t) => t.slug === taskSlug) ?? null;
}

export function projectDir(project: Project): string {
  return path.join(PROJECTS_DIR, project.folderName);
}
export function taskDir(project: Project, task: Task): string {
  return path.join(PROJECTS_DIR, project.folderName, task.folderName);
}

export async function createProject(slug: string, description = ""): Promise<Project> {
  const clean = sanitizeName(slug);
  if (!clean) throw new Error("invalid name");
  const folder = `wip-${clean}`;
  const dir = path.join(PROJECTS_DIR, folder);
  await fs.mkdir(path.join(dir, "files"), { recursive: true });
  await fs.mkdir(path.join(dir, "sessions"), { recursive: true });
  await writeMarkdown(path.join(dir, "files", "project.md"), description, {
    labels: [],
    created: new Date().toISOString().slice(0, 10),
  });
  return (await getProject(clean))!;
}

export async function createTask(projectSlug: string, slug: string, description = ""): Promise<Task> {
  const project = await getProject(projectSlug);
  if (!project) throw new Error(`unknown project ${projectSlug}`);
  const clean = sanitizeName(slug);
  if (!clean) throw new Error("invalid name");
  const folder = `wip-${clean}`;
  const dir = path.join(PROJECTS_DIR, project.folderName, folder);
  await fs.mkdir(path.join(dir, "files"), { recursive: true });
  await fs.mkdir(path.join(dir, "sessions"), { recursive: true });
  await writeMarkdown(path.join(dir, "files", "task.md"), description, {
    labels: [],
    created: new Date().toISOString().slice(0, 10),
  });
  return (await getTask(projectSlug, clean))!;
}

export async function setProjectStatus(slug: string, status: Status): Promise<void> {
  const project = await getProject(slug);
  if (!project) throw new Error(`unknown project ${slug}`);
  if (project.status === status) return;
  const newFolder = `${status}-${slug}`;
  await fs.rename(
    path.join(PROJECTS_DIR, project.folderName),
    path.join(PROJECTS_DIR, newFolder),
  );
}

export async function renameProject(slug: string, newSlug: string): Promise<void> {
  const project = await getProject(slug);
  if (!project) throw new Error(`unknown project ${slug}`);
  const clean = sanitizeName(newSlug);
  if (!clean) throw new Error("invalid name");
  if (clean === slug) return;
  const existing = await getProject(clean);
  if (existing) throw new Error(`project "${clean}" already exists`);
  const newFolder = `${project.status}-${clean}`;
  const oldPath = path.join(PROJECTS_DIR, project.folderName);
  const newPath = path.join(PROJECTS_DIR, newFolder);
  await fs.rename(oldPath, newPath);
  await relocateSdkTranscripts(oldPath, newPath);
  relocateSessionsForProject(slug, clean);
}

export async function deleteProject(slug: string): Promise<void> {
  const project = await getProject(slug);
  if (!project) throw new Error(`unknown project ${slug}`);
  await fs.rm(path.join(PROJECTS_DIR, project.folderName), { recursive: true, force: true });
}

export async function deleteTask(projectSlug: string, taskSlug: string): Promise<void> {
  const project = await getProject(projectSlug);
  const task = project?.tasks.find((t) => t.slug === taskSlug);
  if (!project || !task) throw new Error("not found");
  await fs.rm(path.join(PROJECTS_DIR, project.folderName, task.folderName), { recursive: true, force: true });
}

export async function setTaskStatus(projectSlug: string, taskSlug: string, status: Status): Promise<void> {
  const project = await getProject(projectSlug);
  const task = project ? project.tasks.find((t) => t.slug === taskSlug) : null;
  if (!project || !task) throw new Error(`unknown task ${projectSlug}/${taskSlug}`);
  if (task.status === status) return;
  const newFolder = `${status}-${taskSlug}`;
  const oldPath = path.join(PROJECTS_DIR, project.folderName, task.folderName);
  const newPath = path.join(PROJECTS_DIR, project.folderName, newFolder);
  await fs.rename(oldPath, newPath);
  await relocateSdkTranscripts(oldPath, newPath);
}

export async function moveTask(projectSlug: string, taskSlug: string, toProjectSlug: string): Promise<{ project: string; task: string }> {
  const project = await getProject(projectSlug);
  const task = project ? project.tasks.find((t) => t.slug === taskSlug) : null;
  const dest = await getProject(toProjectSlug);
  if (!project || !task) throw new Error(`unknown task ${projectSlug}/${taskSlug}`);
  if (!dest) throw new Error(`unknown destination ${toProjectSlug}`);
  if (toProjectSlug === projectSlug) return { project: projectSlug, task: taskSlug };
  let finalSlug = taskSlug;
  if (dest.tasks.find((t) => t.slug === finalSlug)) {
    let i = 2;
    while (dest.tasks.find((t) => t.slug === `${taskSlug}-${i}`)) i++;
    finalSlug = `${taskSlug}-${i}`;
  }
  const newFolder = `${task.status}-${finalSlug}`;
  const oldPath = path.join(PROJECTS_DIR, project.folderName, task.folderName);
  const newPath = path.join(PROJECTS_DIR, dest.folderName, newFolder);
  await fs.rename(oldPath, newPath);
  await relocateSdkTranscripts(oldPath, newPath);
  relocateSessionsForTask(projectSlug, taskSlug, toProjectSlug, finalSlug);
  return { project: toProjectSlug, task: finalSlug };
}

export async function renameTask(projectSlug: string, taskSlug: string, newSlug: string): Promise<void> {
  const project = await getProject(projectSlug);
  const task = project ? project.tasks.find((t) => t.slug === taskSlug) : null;
  if (!project || !task) throw new Error(`unknown task ${projectSlug}/${taskSlug}`);
  const clean = sanitizeName(newSlug);
  if (!clean) throw new Error("invalid name");
  if (clean === taskSlug) return;
  const collision = project.tasks.find((t) => t.slug === clean);
  if (collision) throw new Error(`task "${clean}" already exists`);
  const newFolder = `${task.status}-${clean}`;
  const oldPath = path.join(PROJECTS_DIR, project.folderName, task.folderName);
  const newPath = path.join(PROJECTS_DIR, project.folderName, newFolder);
  await fs.rename(oldPath, newPath);
  await relocateSdkTranscripts(oldPath, newPath);
  relocateSessionsForTask(projectSlug, taskSlug, projectSlug, clean);
}

// File CRUD inside a task's files/ folder
function ensureSafePath(base: string, rel: string): string {
  const target = path.resolve(base, rel);
  if (!target.startsWith(base + path.sep) && target !== base) {
    throw new Error("path escapes task directory");
  }
  return target;
}

// Files to hide from artifact listings (macOS metadata, etc.)
const HIDDEN_FILES = new Set([".DS_Store"]);

export async function listFiles(projectSlug: string, taskSlug: string): Promise<string[]> {
  const project = await getProject(projectSlug);
  const task = project?.tasks.find((t) => t.slug === taskSlug);
  if (!project || !task) return [];
  const base = path.join(taskDir(project, task), "files");
  try {
    const entries = await fs.readdir(base, { withFileTypes: true, recursive: true });
    return entries
      .filter((e) => e.isFile() && !HIDDEN_FILES.has(e.name))
      .map((e) => path.relative(base, path.join(e.parentPath, e.name)));
  } catch {
    return [];
  }
}

export async function readFileText(projectSlug: string, taskSlug: string, rel: string): Promise<string> {
  const project = await getProject(projectSlug);
  const task = project?.tasks.find((t) => t.slug === taskSlug);
  if (!project || !task) throw new Error("not found");
  const base = path.join(taskDir(project, task), "files");
  const full = ensureSafePath(base, rel);
  return fs.readFile(full, "utf8");
}

export async function writeFileText(projectSlug: string, taskSlug: string, rel: string, content: string): Promise<void> {
  const project = await getProject(projectSlug);
  const task = project?.tasks.find((t) => t.slug === taskSlug);
  if (!project || !task) throw new Error("not found");
  const base = path.join(taskDir(project, task), "files");
  const full = ensureSafePath(base, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
}

// ---------------------------------------------------------------------------
// Project-level files (artifacts attached to the project itself, distinct
// from any one task). They live in `projects/<project>/files/`.
// ---------------------------------------------------------------------------

export async function listProjectFiles(projectSlug: string): Promise<string[]> {
  const project = await getProject(projectSlug);
  if (!project) return [];
  const base = path.join(projectDir(project), "files");
  try {
    const entries = await fs.readdir(base, { withFileTypes: true, recursive: true });
    return entries
      .filter((e) => e.isFile() && !HIDDEN_FILES.has(e.name))
      .map((e) => path.relative(base, path.join(e.parentPath, e.name)));
  } catch {
    return [];
  }
}

export async function readProjectFileText(projectSlug: string, rel: string): Promise<string> {
  const project = await getProject(projectSlug);
  if (!project) throw new Error("not found");
  const base = path.join(projectDir(project), "files");
  const full = ensureSafePath(base, rel);
  return fs.readFile(full, "utf8");
}

export async function projectFileExists(projectSlug: string, rel: string): Promise<boolean> {
  try {
    await readProjectFileText(projectSlug, rel);
    return true;
  } catch { return false; }
}

export async function readProjectFileBytes(projectSlug: string, rel: string): Promise<Uint8Array> {
  const project = await getProject(projectSlug);
  if (!project) throw new Error("not found");
  const base = path.join(projectDir(project), "files");
  const full = ensureSafePath(base, rel);
  const buf = await fs.readFile(full);
  return new Uint8Array(buf);
}

export async function projectDirFor(projectSlug: string): Promise<string> {
  const project = await getProject(projectSlug);
  if (!project) throw new Error("not found");
  return projectDir(project);
}

export async function renameFile(projectSlug: string, taskSlug: string, from: string, to: string): Promise<void> {
  const project = await getProject(projectSlug);
  const task = project?.tasks.find((t) => t.slug === taskSlug);
  if (!project || !task) throw new Error("not found");
  if (from === "task.md") throw new Error("task.md cannot be renamed");
  if (!to.trim()) throw new Error("destination required");
  const base = path.join(taskDir(project, task), "files");
  const src = ensureSafePath(base, from);
  const dst = ensureSafePath(base, to);
  // Don't allow overwriting existing files
  try { await fs.access(dst); throw new Error(`${to} already exists`); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      if ((err as Error).message?.includes("already exists")) throw err;
    }
  }
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.rename(src, dst);
}

export async function deleteFile(projectSlug: string, taskSlug: string, rel: string): Promise<void> {
  const project = await getProject(projectSlug);
  const task = project?.tasks.find((t) => t.slug === taskSlug);
  if (!project || !task) throw new Error("not found");
  if (rel === "task.md") throw new Error("task.md cannot be deleted");
  const base = path.join(taskDir(project, task), "files");
  const full = ensureSafePath(base, rel);
  await fs.rm(full, { recursive: true, force: true });
}

// Walk every session folder on disk and fix any meta.json whose
// `project`/`task`/`cwd` drifted from the actual location it lives in.
// This happens when a user renames/moves a project or task folder outside the
// rename API (e.g. directly in Finder). Without this, sendInput → resumeSession
// → getProject(staleSlug) returns null and the session is silently broken.
//
// Also relocates the SDK transcript directory if the cwd changed, so
// resume(sdkSessionId) keeps working.
//
// Called once on module load with a globalThis guard for HMR. Best effort —
// failures are logged but never throw.
export async function reconcileSessionsOnDisk(): Promise<void> {
  try {
    const projects = await listProjects();
    for (const p of projects) {
      const projectCwd = path.join(PROJECTS_DIR, p.folderName);
      await reconcileSessionDir(
        path.join(projectCwd, "sessions"),
        p.slug, "", projectCwd,
      );
      for (const t of p.tasks) {
        const taskCwd = path.join(projectCwd, t.folderName);
        await reconcileSessionDir(
          path.join(taskCwd, "sessions"),
          p.slug, t.slug, taskCwd,
        );
      }
    }
  } catch (err) {
    const e = err as Error;
    console.warn(`[reconcile] sessions reconciliation failed:`, e.message);
  }
}

async function reconcileSessionDir(
  sessDir: string,
  expectedProject: string,
  expectedTask: string,
  expectedCwd: string,
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(sessDir, { withFileTypes: true }) as import("node:fs").Dirent[];
  } catch { return; }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const metaPath = path.join(sessDir, String(d.name), "meta.json");
    let meta: { project?: string; task?: string; cwd?: string; [k: string]: unknown };
    try {
      meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    } catch { continue; }
    const projectDrift = meta.project !== expectedProject;
    const taskDrift = (meta.task ?? "") !== expectedTask;
    const cwdDrift = meta.cwd !== expectedCwd;
    if (!projectDrift && !taskDrift && !cwdDrift) continue;

    const oldCwd = typeof meta.cwd === "string" ? meta.cwd : null;
    console.log(
      `[reconcile] session ${String(d.name)}: ${meta.project ?? "?"}/${meta.task ?? ""} → ${expectedProject}/${expectedTask}`,
    );
    meta.project = expectedProject;
    meta.task = expectedTask;
    meta.cwd = expectedCwd;
    try {
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    } catch (err) {
      const e = err as Error;
      console.warn(`[reconcile] could not rewrite ${metaPath}:`, e.message);
      continue;
    }

    if (oldCwd && oldCwd !== expectedCwd) {
      await relocateSdkTranscripts(oldCwd, expectedCwd);
    }
  }
}
