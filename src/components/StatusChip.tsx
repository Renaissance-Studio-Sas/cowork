"use client";

type Status = "wip" | "done";

export function StatusChip({ status, size = "sm" }: { status: Status; size?: "sm" | "md" }) {
  const palette = status === "wip"
    ? { bg: "rgba(37, 99, 235, 0.10)", fg: "#1d4ed8", label: "WIP" }
    : { bg: "rgba(22, 163, 74, 0.12)", fg: "#15803d", label: "DONE" };
  const cls = size === "md"
    ? "px-1.5 py-0.5 text-[10.5px]"
    : "px-1 py-[1px] text-[9.5px]";
  return (
    <span
      className={`inline-flex items-center rounded-md font-semibold tracking-wider shrink-0 ${cls}`}
      style={{ background: palette.bg, color: palette.fg }}
    >
      {palette.label}
    </span>
  );
}
