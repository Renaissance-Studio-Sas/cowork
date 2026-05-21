// Per-cowork-session Playwright binding to a control-plane browser session.
// We acquire a Steel container via the control plane, then attach Playwright
// over CDP. browser.close() only detaches the CDP client; the session is
// released explicitly (which stops the container) via releaseBrowser().

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import * as cp from "./control-plane";
import { setBrowserSession, clearBrowserSession } from "./browser-session-store";

interface Binding {
  cpSessionId: string;
  profile: string;
  browser: Browser;
  context: BrowserContext;
  activePageIndex: number;
  viewerUrl: string;
  steelUiUrl: string | null;
}

const bindings = new Map<string, Binding>();

export interface AttachResult {
  cpSessionId: string;
  profile: string;
  viewerUrl: string;
  steelUiUrl: string | null;
  reused: boolean;
}

// Steel's /json/version returns ws://localhost/... with the proxy stripping
// the port, so we must repoint the host at the session's real cdp_port.
async function resolveCdpUrl(cdpPort: number): Promise<string> {
  const res = await fetch(`http://localhost:${cdpPort}/json/version`);
  const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl: string };
  return webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://localhost:${cdpPort}`);
}

export function getBinding(coworkSessionId: string): Binding | undefined {
  return bindings.get(coworkSessionId);
}

export function hasBrowser(coworkSessionId: string): boolean {
  return bindings.has(coworkSessionId);
}

// Acquire a control-plane session for `profile` and attach Playwright.
// If this cowork session already drives the same profile, reuse it.
export async function acquireAndAttach(coworkSessionId: string, profile: string): Promise<AttachResult> {
  const existing = bindings.get(coworkSessionId);
  if (existing && existing.profile === profile) {
    await cp.touchSession(existing.cpSessionId);
    return {
      cpSessionId: existing.cpSessionId,
      profile,
      viewerUrl: existing.viewerUrl,
      steelUiUrl: existing.steelUiUrl,
      reused: true,
    };
  }
  // Switching profiles: tear down the old binding first.
  if (existing) await releaseBrowser(coworkSessionId);

  const session = await cp.acquireSession(profile);
  const cdpUrl = await resolveCdpUrl(session.cdp_port);
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());

  // Steel's container opens its own initial tab, but it may not be exposed to
  // Playwright the instant we attach. If we eagerly create our own page we end
  // up with TWO tabs — the agent drives one while the live-view player shows
  // the other (a stray about:blank). So wait briefly for Steel's tab, reuse it,
  // and close any extra blank tabs so the viewer and the agent agree on one.
  if (context.pages().length === 0) {
    await new Promise((r) => setTimeout(r, 600));
  }
  const page = context.pages()[0] ?? (await context.newPage());
  for (const extra of context.pages()) {
    if (extra !== page && extra.url() === "about:blank") {
      try { await extra.close(); } catch { /* ignore */ }
    }
  }
  try { await page.bringToFront(); } catch { /* ignore */ }

  const binding: Binding = {
    cpSessionId: session.id,
    profile,
    browser,
    context,
    activePageIndex: 0,
    viewerUrl: session.urls.viewer,
    steelUiUrl: session.urls.steelUi,
  };
  bindings.set(coworkSessionId, binding);
  setBrowserSession(coworkSessionId, {
    active: true,
    profile,
    cpSessionId: session.id,
    viewerUrl: session.urls.viewer,
    steelUiUrl: session.urls.steelUi,
  });
  return {
    cpSessionId: session.id,
    profile,
    viewerUrl: session.urls.viewer,
    steelUiUrl: session.urls.steelUi,
    reused: false,
  };
}

export function activePage(coworkSessionId: string): Page {
  const b = bindings.get(coworkSessionId);
  if (!b) throw new NoBrowserError();
  const pages = b.context.pages();
  if (pages.length === 0) throw new Error("No open tabs. Call browser_navigate or browser_open_tab.");
  const idx = Math.min(b.activePageIndex, pages.length - 1);
  return pages[idx];
}

export class NoBrowserError extends Error {
  constructor() {
    super("No browser session bound. Call browser_use_profile first to acquire one.");
    this.name = "NoBrowserError";
  }
}

export function listPages(coworkSessionId: string): Page[] {
  const b = bindings.get(coworkSessionId);
  if (!b) throw new NoBrowserError();
  return b.context.pages();
}

export interface TabsInfo {
  activeIndex: number;
  tabs: { index: number; url: string; title: string }[];
}

// Snapshot of open tabs + which one the agent is operating on (for the UI).
export async function tabsInfo(coworkSessionId: string): Promise<TabsInfo | null> {
  const b = bindings.get(coworkSessionId);
  if (!b) return null;
  const pages = b.context.pages();
  const activeIndex = pages.length ? Math.min(b.activePageIndex, pages.length - 1) : -1;
  const tabs = await Promise.all(
    pages.map(async (p, index) => ({
      index,
      url: p.url(),
      title: (await p.title().catch(() => "")) || p.url() || "about:blank",
    })),
  );
  return { activeIndex, tabs };
}

export async function newTab(coworkSessionId: string, url?: string): Promise<Page> {
  const b = bindings.get(coworkSessionId);
  if (!b) throw new NoBrowserError();
  const page = await b.context.newPage();
  b.activePageIndex = b.context.pages().indexOf(page);
  if (url) await page.goto(url, { waitUntil: "domcontentloaded" });
  try { await page.bringToFront(); } catch { /* ignore */ }
  return page;
}

export function switchTab(coworkSessionId: string, index: number): Page {
  const b = bindings.get(coworkSessionId);
  if (!b) throw new NoBrowserError();
  const pages = b.context.pages();
  if (index < 0 || index >= pages.length) throw new Error(`Tab index ${index} out of range (0..${pages.length - 1}).`);
  b.activePageIndex = index;
  return pages[index];
}

// Keep the control-plane idle reaper from releasing the session mid-task.
export async function touch(coworkSessionId: string): Promise<void> {
  const b = bindings.get(coworkSessionId);
  if (b) await cp.touchSession(b.cpSessionId);
}

// Detach Playwright AND release the control-plane session (stops the container).
export async function releaseBrowser(coworkSessionId: string): Promise<void> {
  const b = bindings.get(coworkSessionId);
  if (!b) return;
  bindings.delete(coworkSessionId);
  try { await b.browser.close(); } catch { /* already detached */ }
  try { await cp.releaseSession(b.cpSessionId); } catch { /* already gone */ }
  clearBrowserSession(coworkSessionId);
}
