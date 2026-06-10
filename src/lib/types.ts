// Shared types for the agent-workbench app

import type { WorkspaceSource } from "./sources";

export interface WorkspaceDTO {
  // Which root this workspace lives in — "local" (<WORKSPACE_ROOT>/workspaces)
  // or "cloud" (the separate cloud directory). Lets the sidebar split the tree
  // into "Local workspaces" / "Cloud workspaces" sections.
  source: WorkspaceSource;
  slug: string;
  folderName: string;
  // Full slug-chain from the root workspace down to this one (own slug
  // included). `["HR", "pay-contractors"]` identifies the workspace under HR
  // previously known as task "pay-contractors".
  path: string[];
  status: "active" | "archived";
  overview: string;
  details: string;        // markdown
  createdAt: string;
  children: WorkspaceDTO[];
}

export type SessionRuntime = "claude" | "gemini" | "cloud";

// Thinking effort level. Matches @anthropic-ai/claude-agent-sdk's EffortLevel
// and the Claude Code CLI's /model command labels.
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface SessionSummaryDTO {
  id: string;
  workspacePath: string[];
  state: "running" | "idle" | "awaiting_input" | "stopped" | "error";
  title: string;
  startedAt: string;
  lastActivity: string;
  isLive: boolean;
  unread: boolean; // true if session completed but hasn't been viewed by user
  completed: boolean; // sticky "marked complete" flag (manual or agent-suggested + approved)
  backlog: boolean; // sticky "moved to backlog" flag — completion waits on something external (e.g. another session, a person)
  // True when the agent's turn is parked on a user decision (tool approval,
  // AskUserQuestion, or completion suggestion). state is still "running" in
  // this case but the UI should treat it as "pending" — needs the human.
  hasPendingPrompt: boolean;
  runtime: SessionRuntime;
  model: string | null; // actual model id captured from the SDK init event (e.g. "claude-opus-4-7", "gemini-3.5-flash")
  effort: EffortLevel | null; // thinking effort, null = SDK default ('high')
}
