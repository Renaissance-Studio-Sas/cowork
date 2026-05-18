import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { relocateSessionsForProject, relocateSessionsForTask } from "./sessions";

// Workspace root lives one level above apps/agent-workbench (i.e. the repo root).
// Convention: tasks/<project>/<task>/{files,sessions,task.md}
export const WORKSPACE_ROOT = path.resolve(process.cwd(), "..", "..", "tasks");

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
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
  // Bootstrap a default `wip-todo/` catch-all ONLY when the workspace has no
  // projects at all (fresh install). Once the user has any project, we never
  // auto-create — they're free to rename, delete, or replace the catch-all.
  let hasAnyProject = false;
  try {
    const entries = await fs.readdir(WORKSPACE_ROOT, { withFileTypes: true });
    hasAnyProject = entries.some((e) => e.isDirectory() && /^(wip|done)-/.test(e.name));
  } catch { /* empty or missing — treat as no projects */ }
  if (hasAnyProject) return;

  const todoPath = path.join(WORKSPACE_ROOT, "wip-todo");
  await fs.mkdir(path.join(todoPath, "files"), { recursive: true });
  await writeMarkdown(
    path.join(todoPath, "files", "project.md"),
    "Default project. Tasks that don't belong to a larger project go here.",
    { labels: ["todo"], created: new Date().toISOString().slice(0, 10) },
  );
}

export async function listProjects(): Promise<Project[]> {
  await ensureWorkspace();
  const entries = await fs.readdir(WORKSPACE_ROOT, { withFileTypes: true });
  const projects: Project[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const parsed = parsePrefixed(e.name);
    if (!parsed) continue;
    const projectDir = path.join(WORKSPACE_ROOT, e.name);
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
  const projectDir = path.join(WORKSPACE_ROOT, projectFolder);
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
  return path.join(WORKSPACE_ROOT, project.folderName);
}
export function taskDir(project: Project, task: Task): string {
  return path.join(WORKSPACE_ROOT, project.folderName, task.folderName);
}

export async function createProject(slug: string, description = ""): Promise<Project> {
  const clean = sanitizeName(slug);
  if (!clean) throw new Error("invalid name");
  const folder = `wip-${clean}`;
  const dir = path.join(WORKSPACE_ROOT, folder);
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
  const dir = path.join(WORKSPACE_ROOT, project.folderName, folder);
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
    path.join(WORKSPACE_ROOT, project.folderName),
    path.join(WORKSPACE_ROOT, newFolder),
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
  await fs.rename(
    path.join(WORKSPACE_ROOT, project.folderName),
    path.join(WORKSPACE_ROOT, newFolder),
  );
  relocateSessionsForProject(slug, clean);
}

export async function deleteProject(slug: string): Promise<void> {
  const project = await getProject(slug);
  if (!project) throw new Error(`unknown project ${slug}`);
  await fs.rm(path.join(WORKSPACE_ROOT, project.folderName), { recursive: true, force: true });
}

export async function deleteTask(projectSlug: string, taskSlug: string): Promise<void> {
  const project = await getProject(projectSlug);
  const task = project?.tasks.find((t) => t.slug === taskSlug);
  if (!project || !task) throw new Error("not found");
  await fs.rm(path.join(WORKSPACE_ROOT, project.folderName, task.folderName), { recursive: true, force: true });
}

export async function setTaskStatus(projectSlug: string, taskSlug: string, status: Status): Promise<void> {
  const project = await getProject(projectSlug);
  const task = project ? project.tasks.find((t) => t.slug === taskSlug) : null;
  if (!project || !task) throw new Error(`unknown task ${projectSlug}/${taskSlug}`);
  if (task.status === status) return;
  const newFolder = `${status}-${taskSlug}`;
  await fs.rename(
    path.join(WORKSPACE_ROOT, project.folderName, task.folderName),
    path.join(WORKSPACE_ROOT, project.folderName, newFolder),
  );
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
  await fs.rename(
    path.join(WORKSPACE_ROOT, project.folderName, task.folderName),
    path.join(WORKSPACE_ROOT, dest.folderName, newFolder),
  );
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
  await fs.rename(
    path.join(WORKSPACE_ROOT, project.folderName, task.folderName),
    path.join(WORKSPACE_ROOT, project.folderName, newFolder),
  );
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
// from any one task). They live in `tasks/<project>/files/`.
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
