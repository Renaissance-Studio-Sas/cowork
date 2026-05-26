// Route helpers for the app
// One canonical page per project and per task; modes are driven by query params:
//   ?dir=<folder>       — current folder in the artifact list
//   ?artifact=<path>    — expanded file in the artifact column
//   ?chat=<sessionId>   — expanded session in the sessions column
//   ?split=<0.1..0.9>   — artifact column fraction when both are expanded
//
// Maps to:
//   /                                → Welcome
//   /project/[slug]                  → Workspace (project)
//   /project/[slug]/task/[taskSlug]  → Workspace (task)
//
// The legacy /file/[...path], /dir/[...path] and /session/[id] segments are
// preserved as redirect-only pages so old deep links still resolve.

export interface WorkspaceParams {
  dir?: string;
  artifact?: string;
  chat?: string;
  split?: number;
}

export function buildWorkspaceQuery(p: WorkspaceParams): string {
  const sp = new URLSearchParams();
  if (p.dir) sp.set("dir", p.dir);
  if (p.artifact) sp.set("artifact", p.artifact);
  if (p.chat) sp.set("chat", p.chat);
  if (typeof p.split === "number") sp.set("split", p.split.toFixed(3));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function projectRoute(slug: string, params: WorkspaceParams = {}) {
  return `/project/${encodeURIComponent(slug)}${buildWorkspaceQuery(params)}`;
}

export function projectDirRoute(slug: string, dirPath: string) {
  return projectRoute(slug, { dir: dirPath });
}

export function projectFileRoute(slug: string, filePath: string) {
  return projectRoute(slug, { artifact: filePath });
}

export function projectSessionRoute(slug: string, sessionId: string) {
  return projectRoute(slug, { chat: sessionId });
}

export function taskRoute(projectSlug: string, taskSlug: string, params: WorkspaceParams = {}) {
  return `/project/${encodeURIComponent(projectSlug)}/task/${encodeURIComponent(taskSlug)}${buildWorkspaceQuery(params)}`;
}

export function taskDirRoute(projectSlug: string, taskSlug: string, dirPath: string) {
  return taskRoute(projectSlug, taskSlug, { dir: dirPath });
}

export function taskFileRoute(projectSlug: string, taskSlug: string, filePath: string) {
  return taskRoute(projectSlug, taskSlug, { artifact: filePath });
}

export function taskSessionRoute(projectSlug: string, taskSlug: string, sessionId: string) {
  return taskRoute(projectSlug, taskSlug, { chat: sessionId });
}

// Task state persistence - remembers last visited path for each task
const TASK_STATE_KEY = "wb-task-state";

interface TaskState {
  [taskKey: string]: string; // Maps "projectSlug/taskSlug" to the last visited path
}

function getTaskKey(projectSlug: string, taskSlug: string): string {
  return `${projectSlug}/${taskSlug}`;
}

export function saveTaskPath(projectSlug: string, taskSlug: string, path: string): void {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(TASK_STATE_KEY);
    const state: TaskState = raw ? JSON.parse(raw) : {};
    state[getTaskKey(projectSlug, taskSlug)] = path;
    localStorage.setItem(TASK_STATE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

export function getTaskPath(projectSlug: string, taskSlug: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(TASK_STATE_KEY);
    if (!raw) return null;
    const state: TaskState = JSON.parse(raw);
    return state[getTaskKey(projectSlug, taskSlug)] || null;
  } catch { return null; }
}

export function getTaskRestoreRoute(projectSlug: string, taskSlug: string): string {
  const savedPath = getTaskPath(projectSlug, taskSlug);
  if (savedPath) {
    return savedPath;
  }
  return taskRoute(projectSlug, taskSlug);
}
