// Route helpers for the app
// Maps to:
//   /                                              → Welcome
//   /project/[slug]                                → ProjectView
//   /project/[slug]/task/[taskSlug]                → TaskView
//   /project/[slug]/task/[taskSlug]/file/[...path] → FileViewer
//   /project/[slug]/task/[taskSlug]/session/[id]   → Chat
//   /project/[slug]/file/[...path]                 → FileViewer (project-level)
//   /project/[slug]/session/[id]                   → Chat (project-level)

export function projectRoute(slug: string) {
  return `/project/${encodeURIComponent(slug)}`;
}

export function projectDirRoute(slug: string, dirPath: string) {
  return `/project/${encodeURIComponent(slug)}/dir/${encodeURIComponent(dirPath)}`;
}

export function projectFileRoute(slug: string, filePath: string) {
  return `/project/${encodeURIComponent(slug)}/file/${filePath.split("/").map(encodeURIComponent).join("/")}`;
}

export function projectSessionRoute(slug: string, sessionId: string) {
  return `/project/${encodeURIComponent(slug)}/session/${encodeURIComponent(sessionId)}`;
}

export function taskRoute(projectSlug: string, taskSlug: string) {
  return `/project/${encodeURIComponent(projectSlug)}/task/${encodeURIComponent(taskSlug)}`;
}

export function taskDirRoute(projectSlug: string, taskSlug: string, dirPath: string) {
  return `/project/${encodeURIComponent(projectSlug)}/task/${encodeURIComponent(taskSlug)}/dir/${encodeURIComponent(dirPath)}`;
}

export function taskFileRoute(projectSlug: string, taskSlug: string, filePath: string) {
  return `/project/${encodeURIComponent(projectSlug)}/task/${encodeURIComponent(taskSlug)}/file/${filePath.split("/").map(encodeURIComponent).join("/")}`;
}

export function taskSessionRoute(projectSlug: string, taskSlug: string, sessionId: string) {
  return `/project/${encodeURIComponent(projectSlug)}/task/${encodeURIComponent(taskSlug)}/session/${encodeURIComponent(sessionId)}`;
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
