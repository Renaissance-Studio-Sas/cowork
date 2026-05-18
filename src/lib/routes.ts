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
