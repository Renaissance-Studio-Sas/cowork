// Composer for past sessions: resume the existing session via the SDK resume
// mechanism, which preserves full conversation context natively. Draft state
// is owned by the parent Chat so the live composer and this one share a single
// source of truth — otherwise editing here would leave Chat's stale draft to
// re-appear when isLive flips and the live composer takes over.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { handleComposerEnter } from "@/lib/composer";
import type { SessionSummaryDTO } from "@/lib/types";

export function ContinueComposer({
  session,
  draft,
  setDraft,
}: {
  session: SessionSummaryDTO;
  draft: string;
  setDraft: (v: string) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

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
          projectSlug: session.projectSlug,
          taskSlug: session.taskSlug,
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

  return (
    <div className="space-y-2">
      <div className="text-[11.5px] text-[var(--muted)] px-1">
        This session is paused. Sending a message will resume it with full conversation context.
      </div>
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
          className="flex-1 resize-none bg-transparent outline-none text-[14px] py-2 leading-relaxed"
        />
        <button
          onClick={resume}
          disabled={!draft.trim() || busy}
          className="rounded-lg bg-[var(--accent)] text-[var(--accent-text)] w-9 h-9 flex items-center justify-center font-semibold disabled:opacity-40 hover:brightness-110 transition shrink-0"
          title="Resume session (↵)"
        >↑</button>
      </div>
    </div>
  );
}
