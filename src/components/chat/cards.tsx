// Cards rendered above the composer when the agent is parked waiting on a
// user decision: tool-call approval (PlanApprovalCard), multi-choice question
// (QuestionCard), or "is this session complete?" suggestion
// (CompletionSuggestionCard). Plus the header's manual complete/reopen toggle.
//
// All three cards POST to the matching `/api/sessions/[id]/{permission|question|complete}`
// endpoint which resolves the agent-side parked promise; the SSE
// `*_resolved` echo clears the card from the parent's state map.

import { useState } from "react";
import { useRouter } from "@/lib/navigation";
import type { SessionSummaryDTO } from "@/lib/types";
import { workspaceRoute } from "@/lib/routes";
import type { PendingQuestionItem } from "./types";
import { Markdown } from "./Markdown";

// Surface a tool-use approval request from the agent's canUseTool callback.
// Today the only tool that gets here is ExitPlanMode — the agent has finished
// a plan and the SDK is asking the user to approve before exiting plan mode
// and letting the agent execute changes.
export function PlanApprovalCard({
  sessionId,
  toolUseId,
  toolName,
  input,
}: {
  sessionId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const planText = typeof input.plan === "string" ? input.plan : JSON.stringify(input, null, 2);
  const isPlan = toolName === "ExitPlanMode";

  const decide = async (behavior: "allow" | "deny") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/permission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolUseId,
          behavior,
          updatedInput: behavior === "allow" ? input : undefined,
          message: behavior === "deny" ? "User rejected the plan." : undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setError(j.error ?? "failed");
        return;
      }
      // Inject a confirmation message into the chat
      if (behavior === "allow" && isPlan) {
        const confirmationMessage = "✓ Plan approved. Proceeding with implementation.";
        await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/inject-message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: confirmationMessage, role: "system" }),
        });
      }
      // SSE permission_resolved event will clear this card from parent state
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--accent)] bg-[var(--panel)] p-3 flex flex-col max-h-[65vh]">
      <div className="flex items-center justify-between shrink-0 pb-2.5 mb-2.5 border-b border-[var(--border)]">
        <div className="text-[12px] font-semibold text-[var(--accent)]">
          {isPlan ? "Plan ready for review" : `Approve ${toolName}?`}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => decide("deny")}
            disabled={busy}
            className="text-[12px] px-3 py-1.5 rounded-md border border-[var(--border-strong)] text-[var(--text-soft)] hover:text-[#dc2626] hover:border-[#dc2626] disabled:opacity-40 transition"
          >
            Deny
          </button>
          <button
            onClick={() => decide("allow")}
            disabled={busy}
            className="text-[12px] px-3 py-1.5 rounded-md bg-[var(--accent)] text-[var(--accent-text)] disabled:opacity-40 hover:brightness-110 transition"
          >
            {busy ? "…" : "Approve & continue"}
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto rounded-md bg-[var(--bg)] px-4 py-3">
        <Markdown text={planText} />
      </div>
      {error && <div className="text-[12px] text-[#dc2626] shrink-0 pt-2">{error}</div>}
    </div>
  );
}

// AskUserQuestion card. The agent has parked one or more questions and is
// blocked on a tool result; submitting here POSTs the user's selections to
// /api/sessions/[id]/question, which resolves the parked Promise on the
// server. The SSE `question_resolved` echo then clears this card.
export function QuestionCard({
  sessionId,
  questionId,
  questions,
}: {
  sessionId: string;
  questionId: string;
  questions: PendingQuestionItem[];
}) {
  // selected[i] is the set of option indices the user has picked for
  // question i. otherText[i] is the free text typed into the "Other" input
  // for question i. Both feed into the answers payload at submit time.
  const [selected, setSelected] = useState<Array<Set<number>>>(
    () => questions.map(() => new Set<number>()),
  );
  const [otherText, setOtherText] = useState<string[]>(() => questions.map(() => ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (qi: number, oi: number, multi: boolean) => {
    setSelected((prev) => {
      const next = prev.map((s) => new Set(s));
      if (multi) {
        if (next[qi].has(oi)) next[qi].delete(oi);
        else next[qi].add(oi);
      } else {
        next[qi] = next[qi].has(oi) ? new Set() : new Set([oi]);
      }
      return next;
    });
  };

  const canSubmit = questions.every((_, qi) => {
    return selected[qi].size > 0 || otherText[qi].trim().length > 0;
  });

  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      const answers = questions.map((q, qi) => {
        const sel = Array.from(selected[qi]).map((oi) => q.options[oi].label);
        const other = otherText[qi].trim();
        const out: { selected?: string[]; other?: string } = {};
        if (sel.length > 0) out.selected = sel;
        if (other) out.other = other;
        return out;
      });
      const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, answers }),
      });
      const j = await r.json();
      if (!j.ok) {
        setError(j.error ?? "failed");
        return;
      }
      // SSE question_resolved event will clear this card from parent state
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const refuse = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, refused: true }),
      });
      const j = await r.json();
      if (!j.ok) setError(j.error ?? "failed");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--accent)] bg-[var(--panel)] p-4 flex flex-col max-h-[60vh]">
      <div className="flex items-center justify-between shrink-0 pb-3 border-b border-[var(--border)]">
        <div className="text-[12px] font-semibold text-[var(--accent)]">
          {questions.length === 1 ? "Agent is asking" : `Agent is asking ${questions.length} questions`}
        </div>
        <div className="flex gap-2">
          <button
            onClick={refuse}
            disabled={busy}
            className="text-[12px] px-3 py-1.5 rounded-md border border-[var(--border-strong)] text-[var(--text-soft)] hover:text-[var(--text)] hover:bg-[var(--panel-2)] disabled:opacity-40 transition"
            title="Skip this prompt — agent will proceed without your answer"
          >
            Refuse
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit || busy}
            className="text-[12px] px-3 py-1.5 rounded-md bg-[var(--accent)] text-[var(--accent-text)] disabled:opacity-40 hover:brightness-110 transition"
          >
            {busy ? "…" : "Send answer"}
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto -mx-4 px-4 py-3 space-y-4">
      {questions.map((q, qi) => (
        <div key={qi} className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[10.5px] uppercase tracking-wide font-semibold text-[var(--accent)] bg-[var(--accent-soft)] rounded px-1.5 py-0.5">
              {q.header}
            </span>
            {q.multiSelect && (
              <span className="text-[10.5px] text-[var(--muted)]">multi-select</span>
            )}
          </div>
          <div className="text-[14px] leading-snug">{q.question}</div>
          <div className="space-y-1.5">
            {q.options.map((opt, oi) => {
              const checked = selected[qi].has(oi);
              return (
                <label
                  key={oi}
                  className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition ${
                    checked
                      ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                      : "border-[var(--border)] hover:border-[var(--border-strong)]"
                  }`}
                >
                  <input
                    type={q.multiSelect ? "checkbox" : "radio"}
                    name={`q-${questionId}-${qi}`}
                    checked={checked}
                    onChange={() => toggle(qi, oi, q.multiSelect)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium">{opt.label}</div>
                    <div className="text-[12px] text-[var(--muted)] leading-snug">{opt.description}</div>
                    {opt.preview && (
                      <pre className="mt-1 text-[11px] bg-[var(--bg)] rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap">
                        {opt.preview}
                      </pre>
                    )}
                  </div>
                </label>
              );
            })}
            <div className="rounded-lg border border-[var(--border)] px-3 py-2">
              <div className="text-[11.5px] text-[var(--muted)] mb-1">Other</div>
              <input
                type="text"
                value={otherText[qi]}
                onChange={(e) => setOtherText((prev) => {
                  const next = [...prev];
                  next[qi] = e.target.value;
                  return next;
                })}
                placeholder="Type your own answer…"
                className="w-full bg-transparent outline-none text-[13px] placeholder:text-[var(--muted)]"
              />
            </div>
          </div>
        </div>
      ))}
      </div>

      {error && <div className="text-[12px] text-[#dc2626] shrink-0 pt-2">{error}</div>}
    </div>
  );
}

// Header button — toggles the session's sticky completion flag. When the
// session is already complete it offers Reopen (which only clears the flag;
// sending a new message in the composer is what actually resumes work).
export function CompleteToggleButton({
  session,
  completed,
  variant = "full",
}: {
  session: SessionSummaryDTO;
  completed: boolean;
  /** "full" = labeled pill (header); "icon" = square icon button (composer). */
  variant?: "full" | "icon";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const nextCompleted = !completed;
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: session.workspacePath,
          completed: nextCompleted,
        }),
      });
      // The SSE `completed_changed` event will flip the local state.
      // After marking complete, drop the user back at the workspace view —
      // the session is closed, so the session page is no longer the right
      // place to be. Reopen stays on the session page so the user can keep
      // working.
      if (nextCompleted && session.workspacePath.length > 0) {
        router.push(workspaceRoute(session.workspacePath));
      }
    } finally {
      setBusy(false);
    }
  };
  const title = completed
    ? "Reopen this session (marks it active again)"
    : "Mark this session complete (closes it and returns to the task)";

  if (variant === "icon") {
    return (
      <button
        onClick={toggle}
        disabled={busy}
        className={`rounded-lg border w-9 h-9 flex items-center justify-center text-[15px] transition disabled:opacity-50 shrink-0 ${
          completed
            ? "border-[var(--border-strong)] text-[var(--text-soft)] hover:bg-[var(--panel-2)]"
            : "border-[var(--ok)] text-[var(--ok)] hover:bg-[var(--ok-soft)]"
        }`}
        title={title}
        aria-label={completed ? "Reopen session" : "Mark session complete"}
      >
        {completed ? "↺" : "✓"}
      </button>
    );
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      className={`text-[12px] px-3 py-1.5 rounded-lg border transition disabled:opacity-50 ${
        completed
          ? "border-[var(--border-strong)] text-[var(--text-soft)] hover:bg-[var(--panel-2)]"
          : "border-[var(--ok)] text-[var(--ok)] hover:bg-[var(--ok-soft)]"
      }`}
      title={title}
    >
      {completed ? "↺ Reopen" : "✓ Mark complete"}
    </button>
  );
}

// Approve/Dismiss card for an agent's `suggest_session_complete` request.
// Approve marks the session complete and unblocks the agent's tool call
// with "approved". Dismiss leaves the flag alone and tells the agent to keep
// working.
export function CompletionSuggestionCard({
  session,
  requestId,
  reason,
}: {
  session: SessionSummaryDTO;
  requestId: string;
  reason: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (approved: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: session.workspacePath,
          completed: approved,
          requestId,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setError(j.error ?? "failed");
        return;
      }
      // SSE completion_resolved clears the card; completed_changed flips the badge.
      // On approval, navigate to the workspace view — the session is wrapped up.
      // Dismiss keeps the user on the session so they can keep iterating.
      if (approved && session.workspacePath.length > 0) {
        router.push(workspaceRoute(session.workspacePath));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--ok)] bg-[var(--panel)] p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-[var(--ok)] flex items-center gap-1.5">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Agent suggests this session is complete
          </div>
          {reason && (
            <div className="text-[12.5px] text-[var(--text-soft)] mt-1 truncate">{reason}</div>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => decide(false)}
            disabled={busy}
            className="text-[12px] px-3 py-1.5 rounded-md border border-[var(--border-strong)] text-[var(--text-soft)] hover:bg-[var(--panel-2)] disabled:opacity-40 transition"
          >
            Dismiss
          </button>
          <button
            onClick={() => decide(true)}
            disabled={busy}
            className="text-[12px] px-3 py-1.5 rounded-md bg-[var(--ok)] text-white disabled:opacity-40 hover:brightness-110 transition"
          >
            {busy ? "…" : "Approve & mark complete"}
          </button>
        </div>
      </div>
      {error && <div className="text-[12px] text-[#dc2626] mt-2">{error}</div>}
    </div>
  );
}
