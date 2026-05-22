// Tracks, per cowork session, which app preview is bound (local dev server or a
// remote prod/preview URL) so the chat UI can show a live iframe. State is
// pushed to SSE subscribers via the RuntimeSession's events emitter
// ("preview_session") and replayed on connect.

import { getSession } from "../sessions";
import { detachSession, previewEvents } from "./manager";

export interface PreviewSessionInfo {
  active: boolean;
  app: string;
  url: string;
  // local = a `rw worker dev` process we manage; remote = a deployed prod/
  // preview URL we just embed (no process).
  remote: boolean;
}

const store = new Map<string, PreviewSessionInfo>();

function emit(coworkSessionId: string, info: PreviewSessionInfo | { active: false }): void {
  const s = getSession(coworkSessionId);
  s?.events.emit("preview_session", info);
}

export function setPreviewSession(coworkSessionId: string, app: string, url: string, remote = false): void {
  const info: PreviewSessionInfo = { active: true, app, url, remote };
  store.set(coworkSessionId, info);
  emit(coworkSessionId, info);
}

export function getPreviewSession(coworkSessionId: string): PreviewSessionInfo | null {
  return store.get(coworkSessionId) ?? null;
}

export function clearPreviewSession(coworkSessionId: string): void {
  detachSession(coworkSessionId);
  if (!store.has(coworkSessionId)) return;
  store.delete(coworkSessionId);
  emit(coworkSessionId, { active: false });
}

// When a local dev server dies (reaped/crashed/killed), drop the binding for
// every session showing it and tell those clients so they don't keep rendering
// a dead iframe.
previewEvents.on("dead", ({ sessions }: { app: string; sessions: string[] }) => {
  for (const sid of sessions) {
    if (!store.has(sid)) continue;
    store.delete(sid);
    emit(sid, { active: false });
  }
});
