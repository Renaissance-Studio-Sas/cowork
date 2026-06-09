// Flatten the SDK message stream into render items, batching consecutive
// tool calls (across messages) into a single inline-flex row of compact
// chips. Visible text and user messages break the row. Detects a handful of
// SDK-injected synthetic messages (resume prompt, interrupt note, compaction
// summary) and surfaces them as neutral pills instead of regular bubbles.
// `propose_plan` / `propose_task` tool_uses become interactive cards rather
// than chips — the most recent one is actionable, earlier ones render dimmed.

import { useState } from "react";
import type { SessionSummaryDTO } from "@/lib/types";
import { Markdown } from "./Markdown";
import { ToolChip } from "./ToolChip";
import { ProposalCard } from "./proposals";
import { extractText, isInterruptNoise, isProposalToolName } from "./utils";
import type { Part, SDKMessageLite } from "./types";

export function MessageStream({
  messages,
  session,
  onChange,
}: {
  messages: SDKMessageLite[];
  session: SessionSummaryDTO;
  onChange: () => void;
}) {
  type Chip = { kind: "tool"; part: Part };
  type Item =
    | { kind: "user"; key: string; text: string }
    | { kind: "asst-text"; key: string; text: string }
    | { kind: "chip-row"; key: string; chips: Chip[] }
    | { kind: "proposal"; key: string; name: string; input: Record<string, unknown>; toolUseId: string; isLatest: boolean }
    | { kind: "result"; key: string }
    | { kind: "system-info"; key: string; text: string }
    | { kind: "system-note"; key: string; text: string }
    | { kind: "system-error"; key: string; text: string }
    | { kind: "system-compaction"; key: string; summary: string }
    // Inline /login flow for remote sessions. Surfaced when the runner emits
    // `auth_required` (SDK threw "Not logged in") and stays until a later
    // `auth_done` event hides it. The card has a clickable OAuth URL plus a
    // code-paste field that POSTs to /api/sessions/[id]/auth-code.
    | { kind: "auth-card"; key: string; url: string; message: string };

  // Find the (i, j) index of the last propose_plan / propose_task tool_use
  // so we know which one to render as an actionable card. Earlier proposals
  // fall through to the regular chip rendering.
  let latestProposalI = -1;
  let latestProposalJ = -1;
  for (let i = messages.length - 1; i >= 0 && latestProposalI < 0; i--) {
    const mm = messages[i] as { type?: string; message?: { content?: unknown } };
    if (mm.type !== "assistant") continue;
    const parts = (mm.message?.content as Part[] | undefined) ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j];
      if (p.type === "tool_use" && isProposalToolName(p.name as string)) {
        latestProposalI = i;
        latestProposalJ = j;
        break;
      }
    }
  }

  const items: Item[] = [];
  let batch: Chip[] = [];
  let batchKey = "";
  const flush = () => {
    if (batch.length) {
      items.push({ kind: "chip-row", key: batchKey, chips: batch });
      batch = [];
      batchKey = "";
    }
  };

  messages.forEach((m, i) => {
    const mm = m as { type?: string; message?: { content?: unknown }; parent_tool_use_id?: string | null };
    // Messages with a non-null parent_tool_use_id come from a Task() subagent's
    // own turn — they belong to the subagent's transcript, not the parent
    // chat. The parent already shows the Agent tool_use as a chip (with the
    // full prompt in its expanded JSON), so suppress the subagent's bubbles
    // and tool chips here.
    if (mm.parent_tool_use_id) return;
    if (mm.type === "user") {
      // User messages can also be tool-result echoes (no visible text). Those
      // mustn't break the chip row — only flush when there's actual text.
      // Strip any <system-reminder> blocks (e.g. the "open artifact" hint
      // injected on the server) — the agent still sees them in its context,
      // but the user shouldn't see their own bubble polluted by them.
      const text = stripSystemReminders(extractText(mm.message?.content)).trim();
      // Hide system-injected resume prompts (sessions.ts pushes this as a
      // user message so the model has something to continue from after a
      // server restart — but it's not actually FROM the user). Surfaced as
      // a small "session resumed" note via system-info instead.
      const isResumePrompt = text === "[Server restarted — please continue where you left off.]";
      // The SDK injects "[Request interrupted by user]" as a user message when a
      // turn is stopped. It's not something the user typed — surface it as a
      // neutral interruption note instead of a chat bubble.
      const isInterruptNote = text === "[Request interrupted by user]";
      // When the SDK auto-compacts a conversation, the next turn starts with a
      // synthetic user message containing the full summary. Collapse it into a
      // small "Session compacted" pill so the chat isn't dominated by it.
      const isCompactionSummary = text.startsWith("This session is being continued from a previous conversation that ran out of context.");
      // The SDK acknowledges a mid-session model/effort switch by injecting a
      // `<local-command-stdout>Set model to <id></local-command-stdout>` user
      // message (the same plumbing the CLI's /model command uses). Surface it
      // as a small note rather than a raw user bubble showing the tag.
      const settingSwitchMatch = text.match(/^<local-command-stdout>\s*Set (model|effort) to (.+?)\s*<\/local-command-stdout>$/);
      // Any other local-command echo is CLI plumbing the user never typed — hide it.
      const isLocalCommandEcho = /^<local-command-(?:stdout|stderr)>[\s\S]*<\/local-command-(?:stdout|stderr)>$/.test(text);
      if (isResumePrompt) {
        flush();
        items.push({ kind: "system-info", key: `sr-${i}`, text: "Session resumed after server restart." });
      } else if (isInterruptNote) {
        flush();
        items.push({ kind: "system-note", key: `int-${i}`, text: "Session interrupted by the user." });
      } else if (isCompactionSummary) {
        flush();
        items.push({ kind: "system-compaction", key: `cp-${i}`, summary: text });
      } else if (settingSwitchMatch) {
        flush();
        const label = settingSwitchMatch[1] === "effort" ? "Effort" : "Model";
        items.push({ kind: "system-info", key: `set-${i}`, text: `${label} switched to ${settingSwitchMatch[2]}.` });
      } else if (isLocalCommandEcho) {
        // Hidden — CLI plumbing, nothing to render.
      } else if (text) {
        flush();
        items.push({ kind: "user", key: `u-${i}`, text });
      }
    } else if (mm.type === "assistant") {
      // Synthetic assistant messages are SDK-generated error/status carriers
      // (e.g. rate limits, aborts), not real model output. The matching
      // `result` message surfaces the error as a proper error box below, so
      // skip the synthetic text here to avoid rendering it twice.
      const model = (mm.message as { model?: string } | undefined)?.model;
      if (model === "<synthetic>") return;
      const parts = (mm.message?.content as Part[] | undefined) ?? [];
      parts.forEach((p, j) => {
        if (p.type === "tool_use" && isProposalToolName(p.name as string)) {
          flush();
          items.push({
            kind: "proposal",
            key: `pp-${i}-${j}`,
            name: p.name as string,
            input: (p.input ?? {}) as Record<string, unknown>,
            toolUseId: (p.id as string) ?? `${i}-${j}`,
            isLatest: i === latestProposalI && j === latestProposalJ,
          });
        } else if (p.type === "tool_use") {
          if (!batch.length) batchKey = `c-${i}-${j}`;
          batch.push({ kind: "tool", part: p });
        } else if (p.type === "text" && typeof p.text === "string" && (p.text as string).trim()) {
          flush();
          items.push({ kind: "asst-text", key: `at-${i}-${j}`, text: p.text as string });
        }
      });
    } else if (mm.type === "result") {
      flush();
      // A result with is_error (e.g. api_error_status 429 rate limit) means the
      // turn ended in failure. Surface it as an error box; the SDK's `result`
      // text is already human-readable ("You've hit your session limit …").
      const res = m as { is_error?: boolean; result?: string; subtype?: string };
      // An interrupted turn ends with an "error_during_execution" result (or an
      // abort diagnostic in `result`). That's the user stopping the agent, not a
      // failure — the interruption note already covers it, so skip the error box.
      if (res.subtype === "error_during_execution" || isInterruptNoise(res.result)) {
        items.push({ kind: "result", key: `r-${i}` });
      } else if (res.is_error) {
        const text = res.result?.trim() || "The agent stopped due to an error.";
        items.push({ kind: "system-error", key: `re-${i}`, text });
      } else {
        items.push({ kind: "result", key: `r-${i}` });
      }
    } else if (mm.type === "system") {
      const sysMsg = m as { subtype?: string; message?: string; url?: string };
      if (sysMsg.subtype === "info" && sysMsg.message) {
        flush();
        items.push({ kind: "system-info", key: `si-${i}`, text: sysMsg.message });
      } else if (sysMsg.subtype === "error" && sysMsg.message) {
        flush();
        // An interrupt aborts the in-flight SDK request, which can surface as an
        // abort/"ede_diagnostic" error. Don't render it — the interruption note
        // already explains what happened. (Older session logs persisted this
        // before the server-side fix, so keep filtering it on replay.)
        if (isInterruptNoise(sysMsg.message)) return;
        items.push({ kind: "system-error", key: `se-${i}`, text: sysMsg.message });
      } else if (sysMsg.subtype === "auth_required" && sysMsg.url) {
        // Remove any earlier auth-card so we only ever render the most recent
        // one (a fresh /auth-start while a stale card is sitting around would
        // otherwise stack two URLs in the chat).
        for (let k = items.length - 1; k >= 0; k--) {
          if (items[k].kind === "auth-card") items.splice(k, 1);
        }
        flush();
        items.push({
          kind: "auth-card",
          key: `auth-${i}`,
          url: sysMsg.url,
          message: sysMsg.message ?? "Sign in to continue.",
        });
      } else if (sysMsg.subtype === "auth_submitted") {
        // Code was POSTed to the runner — optimistically dismiss the card so
        // the chat returns to its working state. The submit button no longer
        // sits on "Waiting…". If setup-token rejects the code, an
        // `auth_failed` event arrives and the user sees the error.
        for (let k = items.length - 1; k >= 0; k--) {
          if (items[k].kind === "auth-card") items.splice(k, 1);
        }
      } else if (sysMsg.subtype === "auth_done") {
        // Auth fully confirmed — drop any lingering card + show a small note.
        for (let k = items.length - 1; k >= 0; k--) {
          if (items[k].kind === "auth-card") items.splice(k, 1);
        }
        flush();
        items.push({
          kind: "system-info",
          key: `ad-${i}`,
          text: sysMsg.message ?? "Authenticated — resuming session.",
        });
      } else if (sysMsg.subtype === "auth_failed" && sysMsg.message) {
        flush();
        items.push({ kind: "system-error", key: `af-${i}`, text: sysMsg.message });
      } else if (sysMsg.subtype === "auth_pending") {
        // The runner saw an auth error and is bringing up setup-token — no
        // URL yet. Render a transient note; the card replaces it when the
        // URL lands.
        flush();
        items.push({
          kind: "system-info",
          key: `ap-${i}`,
          text: "Claude is not logged in — preparing sign-in…",
        });
      }
    }
  });
  flush();

  return (
    <>
      {items.map((it) => {
        if (it.kind === "user") {
          const parsed = parseAddressCommentsMessage(it.text);
          return (
            <div key={it.key} className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl rounded-br-md bg-[var(--user-bubble)] text-[var(--text)] px-4 py-2.5 text-[14px] leading-relaxed border border-[var(--border)]">
                {parsed ? <CommentBriefBubble parsed={parsed} /> : <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{it.text}</span>}
              </div>
            </div>
          );
        }
        if (it.kind === "asst-text") {
          return (
            <div key={it.key} className="text-[14px] leading-relaxed">
              <Markdown text={it.text} />
            </div>
          );
        }
        if (it.kind === "chip-row") {
          return (
            <div key={it.key} className="flex flex-wrap gap-1">
              {it.chips.map((c, j) => <ToolChip key={j} p={c.part} />)}
            </div>
          );
        }
        if (it.kind === "proposal") {
          return (
            <ProposalCard
              key={it.key}
              name={it.name}
              input={it.input}
              isLatest={it.isLatest}
              session={session}
              onCreated={onChange}
            />
          );
        }
        if (it.kind === "result") {
          return null;
        }
        if (it.kind === "system-info") {
          return (
            <div key={it.key} className="flex justify-center">
              <div className="rounded-lg bg-[var(--ok-soft)] border border-[var(--ok)] text-[var(--ok)] px-3 py-1.5 text-[12.5px] font-medium">
                {it.text}
              </div>
            </div>
          );
        }
        if (it.kind === "system-note") {
          return (
            <div key={it.key} className="flex justify-center">
              <div className="rounded-lg bg-[var(--bg-2)] border border-[var(--border)] text-[var(--muted)] px-3 py-1.5 text-[12.5px] font-medium">
                {it.text}
              </div>
            </div>
          );
        }
        if (it.kind === "system-error") {
          return (
            <div key={it.key} className="flex justify-center">
              <div className="rounded-lg bg-red-500/10 border border-red-500/40 text-red-400 px-3 py-1.5 text-[12.5px] font-medium max-w-[80%] text-center">
                {it.text}
              </div>
            </div>
          );
        }
        if (it.kind === "auth-card") {
          return (
            <AuthCard
              key={it.key}
              sessionId={session.id}
              url={it.url}
              message={it.message}
            />
          );
        }
        if (it.kind === "system-compaction") {
          return (
            <div key={it.key} className="flex justify-center">
              <details className="group max-w-[80%]">
                <summary className="cursor-pointer select-none list-none rounded-lg bg-[var(--bg-2)] border border-[var(--border)] text-[var(--muted)] px-3 py-1.5 text-[12.5px] font-medium inline-flex items-center gap-1.5">
                  <span className="text-[9px] opacity-70 group-open:rotate-90 transition-transform">▸</span>
                  <span>Session compacted</span>
                </summary>
                <div className="mt-2 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] text-[var(--text-soft)] px-3 py-2 text-[13px] leading-relaxed">
                  <Markdown text={it.summary} />
                </div>
              </details>
            </div>
          );
        }
        return null;
      })}
    </>
  );
}

// Remove <system-reminder>…</system-reminder> blocks from a user-message
// string. These are server-injected context hints (e.g. which artifact the
// user has open) — visible to the agent but noise in the user's own bubble.
function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "");
}

// Detects the "Send to agent" comment-briefing message and pulls the file
// path + each comment chip out so we can render it as a card instead of a
// wall of text.
function parseAddressCommentsMessage(text: string): null | {
  filePath: string;
  items: Array<{ id?: number; quote: string; body: string }>;
  footer: string;
} {
  const headerMatch = text.match(/^Please address (?:the following )?comments? on `([^`]+)`:/);
  if (!headerMatch) return null;
  const filePath = headerMatch[1];
  const lines = text.split("\n");
  const items: Array<{ id?: number; quote: string; body: string }> = [];
  let footer = "";
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^- (?:\[comment #(\d+)\] )?on "([^"]*)" — (.+)$/);
    if (m) {
      items.push({ id: m[1] ? Number(m[1]) : undefined, quote: m[2], body: m[3] });
      continue;
    }
    if (items.length > 0 && line.trim() && !line.startsWith("-")) {
      footer = lines.slice(i).join("\n").trim();
      break;
    }
  }
  if (items.length === 0) return null;
  return { filePath, items, footer };
}

// Inline auth card for the /login flow. Renders the OAuth URL the runner
// captured from `claude setup-token` and a code-paste field. On submit, POSTs
// to /api/sessions/[id]/auth-code which forwards into the runner's setup-
// token subprocess. The card stays mounted until the SSE stream delivers an
// `auth_done` event (handled by MessageStream by dropping the card item).
function AuthCard({ sessionId, url, message }: { sessionId: string; url: string; message: string }) {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setStatus("sending");
    setErrMsg(null);
    try {
      const r = await fetch(`/api/sessions/${sessionId}/auth-code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({} as Record<string, unknown>));
        setStatus("error");
        setErrMsg(typeof body.error === "string" ? body.error : `HTTP ${r.status}`);
        return;
      }
      // Don't flip to "done" here — wait for the SSE auth_done event which
      // unmounts the card. The 202 response just means the code was queued.
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setErrMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex justify-center">
      <div className="max-w-[80%] w-full rounded-lg bg-[var(--bg-2)] border border-[var(--accent)]/40 px-4 py-3 text-[13px] leading-relaxed">
        <div className="flex items-center gap-2 text-[var(--text)] font-medium pb-1">
          <span className="text-[14px]">🔐</span>
          <span>Sign in to Claude Code</span>
        </div>
        <div className="text-[12.5px] text-[var(--muted)] pb-2.5">{message}</div>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 mb-3 rounded-md bg-[var(--accent)] text-white text-[12.5px] font-medium px-3 py-1.5 hover:opacity-90"
        >
          Sign in with Claude
          <span aria-hidden className="text-[11px]">↗</span>
        </a>
        <details className="text-[11px] text-[var(--muted)] -mt-2 mb-2">
          <summary className="cursor-pointer select-none">Use the URL directly</summary>
          <div className="mt-1 break-all font-mono">{url}</div>
        </details>
        <form onSubmit={submit} className="flex items-center gap-2 pt-1">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Paste authorization code…"
            autoFocus
            disabled={status === "sending" || status === "done"}
            className="flex-1 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--text)] px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--accent)] disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!code.trim() || status === "sending" || status === "done"}
            className="rounded bg-[var(--accent)] text-white text-[12.5px] font-medium px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {status === "sending" ? "Submitting…" : status === "done" ? "Waiting…" : "Submit"}
          </button>
        </form>
        {errMsg && (
          <div className="mt-2 text-[12px] text-red-400">{errMsg}</div>
        )}
      </div>
    </div>
  );
}

function CommentBriefBubble({ parsed }: { parsed: NonNullable<ReturnType<typeof parseAddressCommentsMessage>> }) {
  const [showFooter, setShowFooter] = useState(false);
  return (
    <div className="space-y-2">
      <div className="text-[12px] uppercase tracking-wider text-[var(--muted)] font-semibold">
        Address comments
      </div>
      <div className="text-[13px]">
        on <span className="font-mono text-[12.5px] bg-[rgba(0,0,0,0.06)] rounded px-1.5 py-0.5">{parsed.filePath}</span>
      </div>
      <div className="space-y-1.5 pt-1">
        {parsed.items.map((c, i) => (
          <div key={i} className="rounded-lg bg-[rgba(255,255,255,0.55)] border border-[rgba(0,0,0,0.06)] px-2.5 py-1.5 text-[12.5px]">
            <div className="italic text-[var(--text-soft)] truncate">&ldquo;{c.quote}&rdquo;</div>
            <div className="mt-0.5">{c.body}</div>
          </div>
        ))}
      </div>
      {parsed.footer && (
        <button
          onClick={() => setShowFooter((v) => !v)}
          className="text-[11.5px] text-[var(--muted)] hover:text-[var(--text)] underline underline-offset-2"
        >
          {showFooter ? "hide instructions" : "show instructions"}
        </button>
      )}
      {showFooter && (
        <div className="text-[12px] text-[var(--text-soft)] whitespace-pre-wrap pt-1">{parsed.footer}</div>
      )}
    </div>
  );
}
