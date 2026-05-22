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

// Thinking effort level. Matches @anthropic-ai/claude-agent-sdk's EffortLevel
// and the Claude Code CLI's /model command labels.
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

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
  effort: EffortLevel | null; // thinking effort, null = SDK default ('high')
}
