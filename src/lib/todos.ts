// Derive the agent's todo/task list from a message stream.
//
// Two tool shapes feed the list, both supported here:
//   - TodoWrite  — sends the FULL list on every call (snapshot semantics).
//   - TaskCreate / TaskUpdate — incremental: each create appends a task, each
//     update mutates one by id. The SDK assigns ids "1","2","3"… in creation
//     order, so we reconstruct the same numbering by counting TaskCreate calls.
//
// IMPORTANT: this is pure (no React/DOM) so it can run on the SERVER over the
// COMPLETE session history. Running it over a truncated/paginated window breaks
// both shapes — a TodoWrite snapshot older than the window disappears, and a
// missing older TaskCreate desyncs the id counter so later TaskUpdates no longer
// match. The server derives over the full event log and pushes the result to the
// client (see the `todos` SSE event), keeping the panel correct regardless of
// how much transcript the chat UI has lazily loaded.

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export function extractTodosFromMessages(messages: unknown[]): TodoItem[] {
  // First try TodoWrite (sends full list each time) — walk backwards for most recent
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as {
      type?: string;
      message?: { content?: unknown[] };
    };
    if (msg.type !== "assistant") continue;

    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;

    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j] as {
        type?: string;
        name?: string;
        input?: { todos?: TodoItem[] };
      };
      if (block.type === "tool_use" && block.name === "TodoWrite") {
        const todos = block.input?.todos;
        if (Array.isArray(todos)) {
          return todos;
        }
      }
    }
  }

  // Fall back to TaskCreate/TaskUpdate accumulation (Claude Code SDK style)
  type TaskState = { content: string; status: TodoItem["status"]; activeForm?: string };
  const tasks = new Map<string, TaskState>();
  let nextId = 1;

  for (const m of messages) {
    const msg = m as { type?: string; message?: { content?: unknown[] } };
    if (msg.type !== "assistant") continue;

    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
      if (b.type !== "tool_use") continue;

      if (b.name === "TaskCreate") {
        const input = b.input as { subject?: string; description?: string; activeForm?: string } | undefined;
        if (input?.subject) {
          const id = String(nextId++);
          tasks.set(id, {
            content: input.subject,
            status: "pending",
            activeForm: input.activeForm,
          });
        }
      } else if (b.name === "TaskUpdate") {
        const input = b.input as { taskId?: string; status?: string; subject?: string; activeForm?: string } | undefined;
        if (input?.taskId) {
          const task = tasks.get(input.taskId);
          if (task) {
            if (input.status === "deleted") {
              tasks.delete(input.taskId);
            } else if (input.status === "pending" || input.status === "in_progress" || input.status === "completed") {
              task.status = input.status;
            }
            if (input.subject) task.content = input.subject;
            if (input.activeForm) task.activeForm = input.activeForm;
          }
        }
      }
    }
  }

  return Array.from(tasks.values());
}
