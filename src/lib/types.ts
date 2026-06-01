// Shared types for the agent-workbench app

export interface ProjectDTO {
  slug: string;
  folderName: string;
  status: "active" | "archived";
  overview: string;
  details: string;        // markdown
  createdAt: string;
  tasks: TaskDTO[];
}

export interface TaskDTO {
  slug: string;
  folderName: string;
  projectSlug: string;
  status: "active" | "archived";
  overview: string;
  details: string;        // markdown
  createdAt: string;
}

export type SessionRuntime = "claude" | "gemini" | "remote" | "cloud";

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
  // True when the agent's turn is parked on a user decision (tool approval,
  // AskUserQuestion, or completion suggestion). state is still "running" in
  // this case but the UI should treat it as "pending" — needs the human.
  hasPendingPrompt: boolean;
  runtime: SessionRuntime;
  model: string | null; // actual model id captured from the SDK init event (e.g. "claude-opus-4-7", "gemini-3.5-flash")
  effort: EffortLevel | null; // thinking effort, null = SDK default ('high')
}
