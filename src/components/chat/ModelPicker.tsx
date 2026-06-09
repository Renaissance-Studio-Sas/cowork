// Mid-session model switcher shown in the chat footer. Renders as a compact
// dropdown of the models the session's runtime can switch to (Claude reports
// the CLI's live list; other runtimes report none and we fall back to a
// read-only label). Switching is only allowed when the agent isn't actively
// generating — the server enforces this too (409 while running), and we disable
// the control so the affordance matches.
//
// The choice is persisted to the session meta server-side and applied live to
// the idle agent process, so it takes effect on the very next turn.

import { useCallback, useEffect, useState } from "react";
import type { SessionSummaryDTO } from "@/lib/types";

interface ModelInfoLite {
  value: string;
  displayName: string;
  description?: string;
}

export function ModelPicker({
  session,
  disabled,
  onChanged,
}: {
  session: SessionSummaryDTO;
  // True while the agent is generating — the model can't be switched mid-turn.
  disabled: boolean;
  // Called after a successful switch so the parent can refresh session state.
  onChanged: () => void;
}) {
  const [models, setModels] = useState<ModelInfoLite[] | null>(null);
  const [saving, setSaving] = useState(false);
  // Optimistic current model so the label flips instantly on change, reverting
  // if the request fails.
  const [current, setCurrent] = useState<string | null>(session.model);

  useEffect(() => {
    setCurrent(session.model);
  }, [session.model]);

  // Lazily load the switchable model list for this session. Only the Claude
  // runtime returns one; others return [] and we render a read-only label.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/models`);
        if (!r.ok) return;
        const data = (await r.json()) as { models?: ModelInfoLite[] };
        if (!cancelled) setModels(data.models ?? []);
      } catch {
        if (!cancelled) setModels([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-fetch when the runtime process may have changed (id is stable per
    // session; this effectively runs once per mounted session).
  }, [session.id]);

  const change = useCallback(
    async (value: string) => {
      const prev = current;
      setCurrent(value); // optimistic
      setSaving(true);
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/model`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: value }),
        });
        if (!r.ok) {
          setCurrent(prev); // revert on failure (e.g. raced into "running")
        } else {
          onChanged();
        }
      } catch {
        setCurrent(prev);
      } finally {
        setSaving(false);
      }
    },
    [session.id, current, onChanged],
  );

  // No switchable list (non-Claude runtime, or the agent process isn't alive to
  // answer the control request): show the model as a read-only label, matching
  // the prior footer rendering.
  if (!models || models.length === 0) {
    return (
      <span
        className="font-mono"
        title={current ? `Model: ${current}` : `Runtime: ${session.runtime}`}
      >
        {current ?? session.runtime}
      </span>
    );
  }

  // Always keep the current model selectable even if the runtime didn't list it
  // (e.g. a resolved id like "claude-opus-4-8" vs. an alias the menu uses).
  const options =
    current && !models.some((m) => m.value === current)
      ? [{ value: current, displayName: current }, ...models]
      : models;

  return (
    <select
      value={current ?? ""}
      disabled={disabled || saving}
      onChange={(e) => change(e.target.value)}
      title={
        disabled
          ? "Stop the agent to change the model"
          : "Model — applies to the next turn"
      }
      className="font-mono text-[11px] bg-transparent border border-[var(--border)] rounded px-1 py-0.5 outline-none focus:border-[var(--accent)] cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed max-w-[200px]"
      style={{ color: "var(--text-soft)" }}
    >
      {options.map((m) => (
        <option key={m.value} value={m.value} title={m.description}>
          {m.displayName}
        </option>
      ))}
    </select>
  );
}
