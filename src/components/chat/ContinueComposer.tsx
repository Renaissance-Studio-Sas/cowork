// Composer for past sessions: resume the existing session via the SDK resume
// mechanism, which preserves full conversation context natively. Draft state
// is owned by the parent Chat so the live composer and this one share a single
// source of truth — otherwise editing here would leave Chat's stale draft to
// re-appear when isLive flips and the live composer takes over.

import { useState } from "react";
import { useRouter } from "@/lib/navigation";
import { handleComposerEnter, handleComposerPaste, useNewlineModifier } from "@/lib/composer";
import type { SessionSummaryDTO } from "@/lib/types";

export function ContinueComposer({
  session,
  draft,
  setDraft,
  openArtifactPath,
}: {
  session: SessionSummaryDTO;
  draft: string;
  setDraft: (v: string) => void;
  /**
   * Path of the artifact currently open in the workspace's other column.
   * Forwarded to the input endpoint so the agent gets a system-reminder
   * about which file the user is looking at.
   */
  openArtifactPath?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const newlineMod = useNewlineModifier();
  // Only a genuine "error" state means something went wrong. "stopped" is a
  // normal terminal state (interrupt, eviction, or the agent loop ending after
  // a successful turn) — exhausted 529 retries land in "error", not "stopped",
  // so a stopped session has nothing to retry and should not look like a failure.
  const isError = session.state === "error";

  const resume = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      // Send to the existing session's input endpoint — this will resume it via SDK
      const r = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: draft.trim(),
          workspace: session.workspacePath,
          openArtifact: openArtifactPath || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) { alert(j.error ?? "failed to resume"); return; }
      // Clear draft *before* refreshing — the refresh may swap us out for the
      // live composer, which would otherwise see the stale value on re-mount.
      setDraft("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/retry`, {
        method: "POST",
      });
      if (!r.ok) {
        const text = await r.text();
        alert(text || "Failed to retry");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {isError && (
        <div className="text-[11.5px] text-[var(--muted)] px-1">
          This session encountered an error. You can retry the last request or send a new message to continue.
        </div>
      )}
      <div className="rounded-2xl border border-[var(--border-strong)] bg-[var(--panel)] flex items-end gap-2 px-3 py-2 focus-within:border-[var(--accent)] transition">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Continue the conversation…"
          rows={2}
          style={{ maxHeight: 200 }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 200) + "px";
          }}
          onKeyDown={(e) => handleComposerEnter(e, resume)}
          onPaste={handleComposerPaste}
          className="flex-1 resize-none bg-transparent outline-none text-[14px] py-2 leading-relaxed"
        />
        {isError && (
          <button
            onClick={retry}
            disabled={busy}
            className="rounded-lg border border-[var(--warn)] text-[var(--warn)] hover:bg-[var(--warn)] hover:text-white px-3 h-9 flex items-center justify-center font-medium text-[13px] disabled:opacity-40 transition shrink-0"
            title="Retry last request"
          >Retry</button>
        )}
        <button
          onClick={resume}
          disabled={!draft.trim() || busy}
          className={`rounded-lg w-9 h-9 flex items-center justify-center font-semibold disabled:opacity-40 transition shrink-0 ${newlineMod ? "border border-[var(--border-strong)] text-[var(--text-soft)] bg-transparent" : "bg-[var(--accent)] text-[var(--accent-text)] hover:brightness-110"}`}
          title={newlineMod ? "Insert a new line (↵ — release the modifier to send)" : "Resume session — send the message to continue (↵)"}
          aria-label={newlineMod ? "Insert a new line" : "Resume session"}
        >{newlineMod ? "↵" : "↑"}</button>
      </div>
    </div>
  );
}
