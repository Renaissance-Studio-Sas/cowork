// Small helpers shared across the chat UI. Kept dependency-light so they can
// be imported by leaf components without dragging the whole render pipeline.

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: unknown) => {
        const pp = p as { type?: string; text?: string };
        return pp.type === "text" ? pp.text ?? "" : "";
      })
      .join("");
  }
  return "";
}

// Errors the agent SDK throws when an in-flight turn is interrupted/aborted.
// These are the expected consequence of a user stopping the agent — not real
// failures — so we render the neutral interruption note instead of an error
// box. Matched both for live `system: error` events and when replaying older
// session logs that persisted the diagnostic before the server-side fix.
export function isInterruptNoise(text: string | undefined | null): boolean {
  if (!text) return false;
  return /request was aborted|ede_diagnostic|returned an error result/i.test(text);
}

// SDK names for the planning-mode MCP tools the agent calls when proposing
// a project plan or a task brief. The MessageStream watches for these and
// renders an editable acceptance card instead of a generic tool chip.
export const PROPOSE_PLAN_NAME = "mcp__workbench-planning__propose_plan";
export const PROPOSE_TASK_NAME = "mcp__workbench-planning__propose_task";

export function isProposalToolName(name: string | undefined | null): boolean {
  return name === PROPOSE_PLAN_NAME || name === PROPOSE_TASK_NAME;
}

export function sluggifyName(s: string): string {
  return s
    .normalize("NFC")
    .trim()
    .replace(/[/\\:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80) || "Untitled";
}
