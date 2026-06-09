// Mid-session thinking-effort switcher shown in the chat footer next to the
// model picker. Effort levels are fixed (low → max), so unlike ModelPicker
// there's no list to fetch. The empty value means "runtime default" (high).
//
// Same constraints as the model switch: only Claude-family sessions expose an
// effort knob, and it can't change mid-turn — the server rejects it while the
// session is running (409), so we disable the control to match. The choice is
// persisted server-side and applied live to the idle agent (via the SDK's
// apply_flag_settings), so it takes effect on the next turn.

import { useCallback, useEffect, useState } from "react";
import type { SessionSummaryDTO, EffortLevel } from "@/lib/types";

// "" is the sentinel for "no pin → runtime default (high)".
const LEVELS: Array<{ value: EffortLevel | ""; label: string }> = [
  { value: "", label: "default" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

export function EffortPicker({
  session,
  disabled,
  onChanged,
}: {
  session: SessionSummaryDTO;
  // True while the agent is generating — effort can't be switched mid-turn.
  disabled: boolean;
  // Called after a successful change so the parent can refresh session state.
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  // Optimistic current effort so the label flips instantly, reverting on failure.
  const [current, setCurrent] = useState<EffortLevel | null>(session.effort);

  useEffect(() => {
    setCurrent(session.effort);
  }, [session.effort]);

  const change = useCallback(
    async (raw: string) => {
      const next = (raw === "" ? null : (raw as EffortLevel));
      const prev = current;
      setCurrent(next); // optimistic
      setSaving(true);
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/effort`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ effort: next }),
        });
        if (!r.ok) setCurrent(prev); // revert (e.g. raced into "running")
        else onChanged();
      } catch {
        setCurrent(prev);
      } finally {
        setSaving(false);
      }
    },
    [session.id, current, onChanged],
  );

  // Only the Claude runtime has a switchable effort knob; others render a
  // read-only label matching the prior footer.
  if (session.runtime !== "claude") {
    return (
      <span className="font-mono opacity-70" title={`Thinking effort: ${current ?? "high"}`}>
        ({current ?? "high"})
      </span>
    );
  }

  return (
    <select
      value={current ?? ""}
      disabled={disabled || saving}
      onChange={(e) => change(e.target.value)}
      title={disabled ? "Stop the agent to change the effort" : "Thinking effort — applies to the next turn"}
      className="font-mono text-[11px] bg-transparent border border-[var(--border)] rounded px-1 py-0.5 outline-none focus:border-[var(--accent)] cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
      style={{ color: "var(--text-soft)" }}
    >
      {LEVELS.map((l) => (
        <option key={l.value} value={l.value}>
          {l.label}
        </option>
      ))}
    </select>
  );
}
