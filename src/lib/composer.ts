// Composer keydown handler shared across every textarea where:
//   - plain Enter  → submit
//   - Shift / Alt(Option) / Meta(Cmd) / Ctrl + Enter → insert newline
//
// Shift+Enter is handled by the browser natively. The other modifiers are
// not — on macOS, Cmd+Enter is a system shortcut and the browser does NOT
// insert a newline by default — so we insert one ourselves at the caret.

import React, { useEffect, useState } from "react";

// True while any modifier that turns Enter into "insert newline" is held
// (Shift / Alt(Option) / Meta(Cmd) / Ctrl). The submit button watches this so
// it can show a newline glyph instead of the send arrow — making it clear that
// pressing Enter right now inserts a line break rather than submitting.
//
// Modifier-only keydown/keyup events don't always pair up (e.g. the keyup is
// swallowed when the window loses focus during a Cmd+Tab), so we also reset on
// blur and re-read each event's modifier state rather than toggling per-key.
export function useNewlineModifier(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const sync = (e: KeyboardEvent) =>
      setHeld(e.shiftKey || e.altKey || e.metaKey || e.ctrlKey);
    const clear = () => setHeld(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, []);
  return held;
}

export function handleComposerEnter(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  submit: () => void,
): void {
  if (e.key !== "Enter") return;
  if (e.shiftKey) return; // browser inserts newline natively

  if (e.altKey || e.metaKey || e.ctrlKey) {
    e.preventDefault();
    insertNewline(e.currentTarget);
    return;
  }

  e.preventDefault();
  submit();
}

function insertNewline(el: HTMLTextAreaElement): void {
  // Prefer execCommand because it preserves the textarea's undo history.
  // Fall back to manual splice + setter (still keeps the controlled-input
  // bookkeeping working via a fresh InputEvent).
  let ok = false;
  try { ok = !!document.execCommand?.("insertText", false, "\n"); } catch { /* ignore */ }
  if (ok) return;

  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const next = el.value.slice(0, start) + "\n" + el.value.slice(end);

  // Use the native setter so React's controlled-input wrapper sees the change
  // and re-renders with the new value.
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  requestAnimationFrame(() => {
    el.selectionStart = el.selectionEnd = start + 1;
  });
}
