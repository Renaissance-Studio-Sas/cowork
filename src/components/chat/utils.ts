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

// Whether an SDK event renders as a "real" entry in the chat (text bubble,
// proposal card, system pill, or error box). Tool calls collapse into a
// single inline chip row and tool_result echoes don't render at all, so they
// shouldn't count toward pagination — counting them makes the "Load older
// messages (N more)" label lie and produces nearly-empty initial pages on
// tool-heavy turns. Kept here next to the other render-shape helpers so the
// server (cloud-events.ts, stream/route.ts) and MessageStream share one
// definition of "visible".
export function isVisibleSDKMessage(event: unknown): boolean {
  const e = event as {
    type?: string;
    subtype?: string;
    is_error?: boolean;
    result?: string;
    message?: { content?: unknown; model?: string } | string;
    parent_tool_use_id?: string | null;
  };
  // Subagent (Task tool) messages render in the subagent's transcript, not
  // the parent chat — MessageStream skips them entirely.
  if (e.parent_tool_use_id) return false;
  if (e.type === "user") {
    // Tool_result echoes have no visible text → MessageStream renders nothing.
    const content = typeof e.message === "object" ? e.message?.content : undefined;
    return extractText(content).trim().length > 0;
  }
  if (e.type === "assistant") {
    const msg = typeof e.message === "object" ? e.message : undefined;
    if (msg?.model === "<synthetic>") return false;
    const parts = (msg?.content as Array<{ type?: string; text?: string; name?: string }> | undefined) ?? [];
    return parts.some((p) => {
      if (p.type === "text" && typeof p.text === "string" && p.text.trim()) return true;
      if (p.type === "tool_use" && isProposalToolName(p.name)) return true;
      return false;
    });
  }
  if (e.type === "result") {
    if (e.subtype === "error_during_execution" || isInterruptNoise(e.result)) return false;
    return !!e.is_error;
  }
  if (e.type === "system") {
    const msg = (event as { message?: string }).message;
    if (typeof msg !== "string" || !msg) return false;
    if (e.subtype === "info") return true;
    if (e.subtype === "error" && !isInterruptNoise(msg)) return true;
    return false;
  }
  return false;
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
