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

export type SessionRuntime = "claude" | "gemini";

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
  completed: boolean; // sticky "marked complete" flag (manual or agent-suggested + approved)
  runtime: SessionRuntime;
  model: string | null; // actual model id captured from the SDK init event (e.g. "claude-opus-4-7", "gemini-3.5-flash")
}
