"use client";

import type { TodoItem } from "@/lib/todos";

// Re-exported so existing importers (Chat) can keep pulling the type and the
// deriver from this component. The implementation now lives in the
// server-importable `@/lib/todos` so the same logic can run over the full
// session history on the server.
export { extractTodosFromMessages } from "@/lib/todos";
export type { TodoItem } from "@/lib/todos";

interface Props {
  todos: TodoItem[];
  /** Compact mode for side panel */
  compact?: boolean;
}

const STATUS_ICON: Record<TodoItem["status"], string> = {
  pending: "",
  in_progress: "",
  completed: "",
};

const STATUS_COLOR: Record<TodoItem["status"], string> = {
  pending: "var(--muted)",
  in_progress: "var(--accent)",
  completed: "var(--ok)",
};

export function TodoList({ todos, compact = false }: Props) {
  if (todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const progress = total > 0 ? (completed / total) * 100 : 0;
  const currentTask = todos.find((t) => t.status === "in_progress");

  if (compact) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2">
        <div className="flex items-center justify-between gap-2 mb-2 pr-6">
          <span className="text-[11px] uppercase tracking-wider text-[var(--muted)] font-semibold">
            Tasks
          </span>
          <span className="text-[11px] text-[var(--muted)]">
            {completed}/{total}
          </span>
        </div>
        {/* Progress bar */}
        <div className="h-1.5 bg-[var(--panel-2)] rounded-full overflow-hidden mb-2">
          <div
            className="h-full bg-[var(--ok)] transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
        {/* Current task */}
        {currentTask && (
          <div className="flex items-center gap-1.5 text-[12px]">
            <span className="shrink-0">{STATUS_ICON.in_progress}</span>
            <span className="truncate text-[var(--accent)]">
              {currentTask.activeForm || currentTask.content}
            </span>
          </div>
        )}
        {!currentTask && completed === total && total > 0 && (
          <div className="flex items-center gap-1.5 text-[12px] text-[var(--ok)]">
            <span>{STATUS_ICON.completed}</span>
            <span>All tasks completed</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
      <div className="flex items-center justify-between gap-2 mb-3 pr-24">
        <span className="text-[12px] uppercase tracking-wider text-[var(--muted)] font-semibold">
          Task Progress
        </span>
        <span className="text-[12px] text-[var(--muted)]">
          {completed} of {total} completed
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-2 bg-[var(--panel-2)] rounded-full overflow-hidden mb-4">
        <div
          className="h-full bg-[var(--ok)] transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Todo items */}
      <div className="space-y-2">
        {todos.map((todo, i) => (
          <div
            key={i}
            className={`flex items-start gap-2 text-[13px] ${
              todo.status === "completed" ? "opacity-60" : ""
            }`}
          >
            <span
              className={`shrink-0 mt-0.5 ${todo.status === "in_progress" ? "pulse" : ""}`}
              style={{ color: STATUS_COLOR[todo.status] }}
            >
              {STATUS_ICON[todo.status]}
            </span>
            <span
              className={`flex-1 ${
                todo.status === "completed"
                  ? "line-through text-[var(--muted)]"
                  : todo.status === "in_progress"
                    ? "text-[var(--text)]"
                    : "text-[var(--text-soft)]"
              }`}
            >
              {todo.status === "in_progress" && todo.activeForm
                ? todo.activeForm
                : todo.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
