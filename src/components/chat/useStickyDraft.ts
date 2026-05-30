import { useCallback, useEffect, useRef, useState } from "react";

// Draft text persisted in localStorage, keyed by session id. Survives both:
//   - state transitions inside Chat (live composer ↔ ContinueComposer swap on pause)
//   - component unmount/remount (navigating away and back)
// Both composers pass the same sessionId so they share the same storage slot.
export function useStickyDraft(sessionId: string): [string, (v: string) => void] {
  const storageKey = `wb-draft-${sessionId}`;
  const [draft, setDraftState] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try { return localStorage.getItem(storageKey) ?? ""; } catch { return ""; }
  });

  // If sessionId changes (rare — same Chat instance reused for a different
  // session), reload the new session's saved draft.
  const prevKeyRef = useRef(storageKey);
  useEffect(() => {
    if (prevKeyRef.current === storageKey) return;
    prevKeyRef.current = storageKey;
    // Reload the new session's saved draft when the key actually changes —
    // intentional state reset on prop change, guarded above so it only fires
    // on a real switch.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset-on-prop-change, guarded
    try { setDraftState(localStorage.getItem(storageKey) ?? ""); } catch { /* ignore */ }
  }, [storageKey]);

  const setDraft = useCallback((v: string) => {
    setDraftState(v);
    try {
      if (v) localStorage.setItem(storageKey, v);
      else localStorage.removeItem(storageKey);
    } catch { /* ignore */ }
  }, [storageKey]);

  return [draft, setDraft];
}
