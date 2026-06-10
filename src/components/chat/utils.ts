// Small helpers shared across the chat UI. Kept dependency-light so they can
// be imported by leaf components without dragging the whole render pipeline.

import type { Part } from "./types";

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
// Current planning tool — a single recursive workspace with optional children.
// Supersedes propose_plan/propose_task, which are kept only for back-compat
// with old sessions whose stream still carries the legacy names.
export const PROPOSE_WORKSPACE_NAME = "mcp__workbench-planning__propose_workspace";

export function isProposalToolName(name: string | undefined | null): boolean {
  return name === PROPOSE_PLAN_NAME || name === PROPOSE_TASK_NAME || name === PROPOSE_WORKSPACE_NAME;
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
    const text = extractText(content).trim();
    if (!text) return false;
    // Local-command echoes (CLI plumbing) don't render as user bubbles. The
    // mid-session model/effort-switch acks are the exception — MessageStream
    // turns them into a small "… switched to …" note, so they stay visible.
    if (
      /^<local-command-(?:stdout|stderr)>[\s\S]*<\/local-command-(?:stdout|stderr)>$/.test(text)
      && !/^<local-command-stdout>\s*Set (?:model|effort) to /.test(text)
    ) {
      return false;
    }
    return true;
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

// Label for the "Working…" indicator. While the agent is working with no
// streamed text, the last message is the assistant's in-flight tool_use (its
// tool_result hasn't echoed back yet) — so we can name the tool that's
// currently running. Prefer the per-call `description` the model wrote for
// this call (Bash, Agent/Task, etc. carry one); otherwise fall back to a
// prettified tool name. Returns null when no tool is in flight (the agent is
// thinking between steps), so the caller shows the generic "Working".
export function currentToolLabel(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as {
      type?: string;
      parent_tool_use_id?: string | null;
      message?: { content?: unknown; model?: string };
    };
    // Subagent turns render in their own transcript, not the parent chat.
    if (m.parent_tool_use_id) continue;
    // Synthetic assistant messages are SDK status carriers, not real output.
    if (m.type === "assistant" && m.message?.model === "<synthetic>") continue;
    // The first "real" message from the end decides: only an assistant message
    // whose trailing part is a tool_use means a tool is still in flight. A
    // user/result/text message means the agent has moved on → generic label.
    if (m.type !== "assistant") return null;
    const parts = (m.message?.content as Part[] | undefined) ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j];
      if (p.type === "text" && typeof p.text === "string" && p.text.trim()) return null;
      if (p.type === "tool_use") {
        const desc = (p.input as { description?: unknown } | undefined)?.description;
        if (typeof desc === "string" && desc.trim()) return desc.trim();
        return prettifyToolName(p.name as string);
      }
    }
    return null;
  }
  return null;
}

// `mcp__workbench-comments__list_comments` → `list comments`; `WebFetch` →
// `WebFetch`. A readable fallback when a tool_use carries no description.
function prettifyToolName(name: string | undefined): string {
  if (!name) return "Working";
  const mcp = name.match(/^mcp__.+__(.+)$/);
  return (mcp ? mcp[1] : name).replace(/_/g, " ");
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
