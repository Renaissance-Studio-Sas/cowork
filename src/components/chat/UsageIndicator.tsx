import type { RateLimitInfoLite } from "./types";

// Human label for each rate-limit window the SDK reports.
const WINDOW_LABEL: Record<NonNullable<RateLimitInfoLite["rateLimitType"]>, string> = {
  five_hour: "5h limit",
  seven_day: "Weekly limit",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
  overage: "Overage",
};

// "resets in 3h 12m" / "resets in 14m" / "resets soon". resetsAt may be epoch
// seconds or ms depending on source — normalize anything below 1e12 to ms.
function formatReset(resetsAt: number | undefined): string | null {
  if (!resetsAt) return null;
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  const diff = ms - Date.now();
  if (diff <= 0) return "resets soon";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `resets in ${h}h ${m}m` : `resets in ${h}h`;
}

// Small subscription-usage line shown below the composer. Renders nothing until
// the SDK reports a rate-limit snapshot for the session.
//
// The SDK only fills in `utilization` (a 0–1 consumed fraction) as you approach
// the cap — with headroom it sends just the window + reset + status. So we show
// the % and a bar when we have it, and otherwise a calm health dot + reset.
// We never fabricate a number we weren't given.
export function UsageIndicator({ info }: { info: RateLimitInfoLite | null }) {
  if (!info) return null;

  const pct = typeof info.utilization === "number"
    ? Math.min(100, Math.max(0, Math.round(info.utilization * 100)))
    : null;
  const label = info.rateLimitType ? WINDOW_LABEL[info.rateLimitType] : "Usage";
  const reset = formatReset(info.resetsAt);

  // Color escalates with pressure: red when the API is rejecting, amber on the
  // SDK's near-cap warning (or ≥90% if a number is present), muted otherwise.
  const tone =
    info.status === "rejected" ? "var(--err, #dc2626)"
    : info.status === "allowed_warning" || (pct !== null && pct >= 90) ? "var(--warn, #d97706)"
    : "var(--ok, #16a34a)";

  return (
    <span
      className="inline-flex items-center gap-2"
      title={
        `Claude ${label.toLowerCase()}` +
        (pct !== null ? ` — ${pct}% used` : info.status === "rejected" ? " — reached" : " — OK") +
        (reset ? ` — ${reset}` : "")
      }
    >
      {/* Health dot — the at-a-glance signal when there's no % to show. */}
      <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: tone }} />
      <span className="shrink-0">{label}</span>
      {pct !== null ? (
        <>
          <span className="relative h-1 w-16 rounded-full overflow-hidden shrink-0" style={{ background: "var(--border)" }}>
            <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: tone }} />
          </span>
          <span className="shrink-0 tabular-nums" style={{ color: tone }}>{pct}%</span>
        </>
      ) : (
        info.status === "rejected" && <span className="shrink-0" style={{ color: tone }}>reached</span>
      )}
      {reset && <span className="shrink-0 opacity-70">· {reset}</span>}
    </span>
  );
}
