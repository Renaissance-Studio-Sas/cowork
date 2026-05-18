// Shared types for the agent-workbench app

export interface ProjectDTO {
  slug: string;
  folderName: string;
  status: "wip" | "done";
  description: string;
  labels: string[];
  tasks: TaskDTO[];
}

export interface TaskDTO {
  slug: string;
  folderName: string;
  projectSlug: string;
  status: "wip" | "done";
  description: string;
  labels: string[];
}

export interface SessionSummaryDTO {
  id: string;
  projectSlug: string;
  taskSlug: string;
  state: "running" | "idle" | "awaiting_input" | "stopped" | "error";
  title: string;
  startedAt: string;
  lastActivity: string;
  isLive: boolean;
  unread: boolean; // true if session completed but hasn't been viewed by user
}
