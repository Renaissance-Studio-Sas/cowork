"use client";

import { useEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", onDocClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-[var(--bg)] border border-[var(--border-strong)] rounded-lg shadow-xl py-1 min-w-[180px]"
      style={{ left: x, top: y }}
    >
      {items.map((it, i) => (
        <button
          key={i}
          disabled={it.disabled}
          onClick={() => { it.onClick(); onClose(); }}
          className={`w-full text-left px-3 py-1.5 text-[13px] ${
            it.disabled
              ? "text-[var(--muted)] cursor-not-allowed"
              : it.danger
                ? "text-[#dc2626] hover:bg-[#fee2e2]"
                : "hover:bg-[var(--panel-2)]"
          }`}
        >{it.label}</button>
      ))}
    </div>
  );
}
