// Tracks, per cowork session, which control-plane browser session is currently
// bound — so the chat UI can show a live-view iframe and a "manager" link.
// State is pushed to SSE subscribers via the RuntimeSession's events emitter
// ("browser_session" event) and replayed on connect from this store.

import { getSession } from "../sessions";

export interface BrowserSessionInfo {
  active: boolean;
  profile: string;
  cpSessionId: string;
  viewerUrl: string;        // bare live-view player (embeddable iframe)
  steelUiUrl: string | null; // full Steel dashboard (DevTools/console/logs)
}

const store = new Map<string, BrowserSessionInfo>();

function emit(coworkSessionId: string, info: BrowserSessionInfo | { active: false }): void {
  const s = getSession(coworkSessionId);
  s?.events.emit("browser_session", info);
}

export function setBrowserSession(coworkSessionId: string, info: BrowserSessionInfo): void {
  store.set(coworkSessionId, info);
  emit(coworkSessionId, info);
}

export function getBrowserSession(coworkSessionId: string): BrowserSessionInfo | null {
  return store.get(coworkSessionId) ?? null;
}

export function clearBrowserSession(coworkSessionId: string): void {
  if (!store.has(coworkSessionId)) return;
  store.delete(coworkSessionId);
  emit(coworkSessionId, { active: false });
}
