// workbench-browser tools: drive a real Chrome via the steelyard control plane
// (one Steel container per persistent profile), controlled over CDP with
// Playwright. Runtime-agnostic WorkbenchTool[] — the per-runtime adapters wrap
// these for Claude (in-process MCP) or Gemini (ToolRegistry).
//
// Hybrid surface: DOM-structured tools (read_page/click/fill/extract) AND
// vision tools (screenshot/click_xy/type/press/scroll). When a site needs a
// human (2FA, captcha, first login) the agent calls browser_request_human,
// which pauses the run and shows a live-view card in chat.

import { z } from "zod";
import * as cp from "../browser/control-plane";
import * as pw from "../browser/playwright-manager";
import { ensureSteelyardUp, DockerNotRunningError, SteelyardError } from "../browser/steelyard";
import { requestBrowserHandoff } from "../sessions";
import { defineTool, type WorkbenchTool, type ToolCallResult } from "./types";

function errText(msg: string): ToolCallResult {
  return { content: [{ type: "text", text: msg }], isError: true };
}
function okText(msg: string): ToolCallResult {
  return { content: [{ type: "text", text: msg }] };
}

// Lazily bring up the browser control plane (clone + docker compose) before any
// operation that needs it. Returns a tool error result to relay on failure
// (e.g. Docker not running), or null on success.
async function ensureInfra(): Promise<ToolCallResult | null> {
  try {
    await ensureSteelyardUp();
    return null;
  } catch (e) {
    if (e instanceof DockerNotRunningError) return errText(e.message);
    if (e instanceof SteelyardError) return errText(`Browser infrastructure (steelyard) couldn't start: ${e.message}`);
    return errText(`Browser infrastructure error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function withBrowser(fn: () => Promise<ToolCallResult>): Promise<ToolCallResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof pw.NoBrowserError) return errText(e.message);
    if (e instanceof cp.ControlPlaneError) return errText(`Control plane error: ${e.message}`);
    return errText(`Browser error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

interface InteractiveEl {
  tag: string;
  role: string;
  name: string;
  selector: string;
}

export function buildBrowserTools(
  sessionId: string,
  _projectSlug: string,
  _taskSlug: string,
): WorkbenchTool[] {
  return [
    defineTool(
      "browser_list_profiles",
      `List reusable browser profiles in the control plane. A profile is a
persistent, logged-in Chrome identity (cookies/logins survive across sessions).
Each shows whether a live session currently holds it. Pick an existing profile
that already has the accounts you need; only create a new one when none fits.`,
      {},
      async () => withBrowser(async () => {
        const infra = await ensureInfra();
        if (infra) return infra;
        const profiles = await cp.listProfiles();
        if (profiles.length === 0) return okText("No profiles yet. Create one with browser_create_profile, then have the user log in via browser_request_human.");
        const lines = profiles.map((p) =>
          `- ${p.name}${p.liveSessionId ? " (LIVE)" : ""}: ${p.description ?? "—"}${p.notes ? `\n    notes: ${p.notes}` : ""}`,
        );
        return okText(`Profiles:\n${lines.join("\n")}`);
      }),
    ),

    defineTool(
      "browser_create_profile",
      `Create a new empty browser profile (a fresh logged-out Chrome identity).
After creating it you'll typically browser_use_profile then browser_request_human
so the user can log in once; the login persists for all future sessions.`,
      {
        name: z.string().regex(/^[a-z0-9][a-z0-9-_]{0,62}$/, "lowercase letters, digits, - and _; must start alphanumeric").describe("Unique profile id, e.g. 'linkedin-personal'"),
        description: z.string().optional().describe("Short human description"),
        notes: z.string().optional().describe("Free text: what's connected here (accounts/logins/purpose)"),
      },
      async ({ name, description, notes }) => withBrowser(async () => {
        const infra = await ensureInfra();
        if (infra) return infra;
        const p = await cp.createProfile(name, description, notes);
        return okText(`Created profile "${p.name}". Acquire it with browser_use_profile("${p.name}").`);
      }),
    ),

    defineTool(
      "browser_use_profile",
      `Acquire a live browser session for a profile and attach to it (spawns a
Steel Chrome container, ~3-5s; reuses an existing live session if present).
This binds the browser to THIS chat session and lights up the live-view iframe
in the UI. The profile is auto-created if it doesn't exist (logged out).`,
      { profile: z.string().describe("Profile name from browser_list_profiles") },
      async ({ profile }) => withBrowser(async () => {
        const infra = await ensureInfra();
        if (infra) return infra;
        const r = await pw.acquireAndAttach(sessionId, profile);
        return okText(
          `${r.reused ? "Reusing" : "Acquired"} browser session for profile "${r.profile}".\n`
          + `Live view: ${r.viewerUrl}\nFull dashboard: ${r.steelUiUrl ?? "(n/a)"}\n`
          + `If the profile isn't logged in to the target site, call browser_request_human so the user can log in once.`,
        );
      }),
    ),

    defineTool(
      "browser_navigate",
      `Navigate the active tab to a URL (waits for DOM content). After navigating,
inspect the result with browser_read_page or browser_screenshot before acting —
sites may show consent/login/captcha walls.`,
      { url: z.string().describe("Absolute URL, e.g. https://example.com") },
      async ({ url }) => withBrowser(async () => {
        await pw.touch(sessionId);
        const page = pw.activePage(sessionId);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        // Make the working tab the focused one so the live-view player shows it.
        try { await page.bringToFront(); } catch { /* ignore */ }
        return okText(`Navigated to ${page.url()} — title: "${await page.title()}"`);
      }),
    ),

    defineTool(
      "browser_read_page",
      `Read the active page as structured data: URL, title, visible text, and a
numbered list of interactive elements (links/buttons/inputs) with suggested
selectors for browser_click / browser_fill. Use this for DOM-driven automation;
use browser_screenshot when the layout matters or the DOM is opaque.`,
      { max_chars: z.number().optional().describe("Max characters of visible text (default 6000)") },
      async ({ max_chars }) => withBrowser(async () => {
        await pw.touch(sessionId);
        const page = pw.activePage(sessionId);
        const limit = max_chars ?? 6000;
        const text: string = await page.evaluate(() => (document.body?.innerText ?? "").trim());
        const els = (await page.evaluate(() => {
          const out: { tag: string; role: string; name: string; selector: string }[] = [];
          const nodes = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"]'));
          for (const el of nodes.slice(0, 120)) {
            const h = el as HTMLElement;
            const style = window.getComputedStyle(h);
            if (style.display === "none" || style.visibility === "hidden" || h.offsetParent === null) continue;
            const tag = h.tagName.toLowerCase();
            const role = h.getAttribute("role") ?? "";
            const name = (h.getAttribute("aria-label") || (h as HTMLInputElement).placeholder || h.innerText || (h as HTMLInputElement).value || h.getAttribute("name") || h.getAttribute("title") || "").trim().slice(0, 80);
            let selector = "";
            if (h.id) selector = `#${CSS.escape(h.id)}`;
            else if (h.getAttribute("name")) selector = `${tag}[name="${h.getAttribute("name")}"]`;
            else if (h.getAttribute("aria-label")) selector = `${tag}[aria-label="${h.getAttribute("aria-label")}"]`;
            else if (tag === "a" && h.getAttribute("href")) selector = `a[href="${h.getAttribute("href")}"]`;
            out.push({ tag, role, name, selector });
          }
          return out;
        })) as InteractiveEl[];
        const elLines = els.map((e, i) =>
          `[${i}] <${e.tag}${e.role ? ` role=${e.role}` : ""}> ${e.name ? `"${e.name}"` : ""}${e.selector ? `  selector: ${e.selector}` : "  (no stable selector — use text= or screenshot+click_xy)"}`,
        );
        const body = text.length > limit ? text.slice(0, limit) + `\n…[truncated, ${text.length} chars total]` : text;
        return okText(`URL: ${page.url()}\nTitle: ${await page.title()}\n\n--- Interactive elements ---\n${elLines.join("\n") || "(none found)"}\n\n--- Visible text ---\n${body}`);
      }),
    ),

    defineTool(
      "browser_screenshot",
      `Capture a screenshot of the active tab and return it as an image so you
can SEE the page. Use full_page for long pages; default captures the viewport.
After a screenshot you can act with browser_click_xy on pixel coordinates.`,
      { full_page: z.boolean().optional().describe("Capture the entire scrollable page (default false = viewport)") },
      async ({ full_page }) => withBrowser(async () => {
        await pw.touch(sessionId);
        const page = pw.activePage(sessionId);
        const buf = await page.screenshot({ type: "png", fullPage: full_page ?? false });
        return {
          content: [
            { type: "text", text: `Screenshot of ${page.url()} (${page.viewportSize()?.width ?? "?"}x${page.viewportSize()?.height ?? "?"})` },
            { type: "image", data: buf.toString("base64"), mimeType: "image/png" },
          ],
        };
      }),
    ),

    defineTool(
      "browser_click",
      `Click an element by Playwright selector. Accepts CSS (#id, button[name=..]),
text (text="Sign in"), or role engines. Prefer stable selectors from
browser_read_page; fall back to browser_click_xy for opaque/rotating DOMs.`,
      { selector: z.string().describe('e.g. "#submit", \'text="Log in"\', \'a[href*="/feed"]\'') },
      async ({ selector }) => withBrowser(async () => {
        await pw.touch(sessionId);
        const page = pw.activePage(sessionId);
        await page.click(selector, { timeout: 10000 });
        return okText(`Clicked ${selector}. Now on ${page.url()}`);
      }),
    ),

    defineTool(
      "browser_fill",
      `Type text into an input/textarea identified by a Playwright selector
(clears existing value first). For non-text inputs or when no selector is
stable, use browser_click_xy + browser_type.`,
      {
        selector: z.string().describe("Selector for the input"),
        text: z.string().describe("Text to enter"),
      },
      async ({ selector, text }) => withBrowser(async () => {
        await pw.touch(sessionId);
        const page = pw.activePage(sessionId);
        await page.fill(selector, text, { timeout: 10000 });
        return okText(`Filled ${selector}.`);
      }),
    ),

    defineTool(
      "browser_extract",
      `Extract text content of all elements matching a selector (for scraping
lists/tables). Returns up to 200 matches.`,
      { selector: z.string().describe("CSS/text/role selector to match many elements") },
      async ({ selector }) => withBrowser(async () => {
        await pw.touch(sessionId);
        const page = pw.activePage(sessionId);
        const texts = await page.locator(selector).allInnerTexts();
        const slice = texts.slice(0, 200);
        return okText(`Matched ${texts.length} element(s)${texts.length > 200 ? " (showing 200)" : ""}:\n${slice.map((t, i) => `[${i}] ${t.replace(/\s+/g, " ").trim()}`).join("\n") || "(no matches)"}`);
      }),
    ),

    defineTool(
      "browser_click_xy",
      `Click at pixel coordinates in the viewport (vision-driven). Pair with
browser_screenshot to locate targets when selectors aren't reliable.`,
      { x: z.number().describe("X pixels from left"), y: z.number().describe("Y pixels from top") },
      async ({ x, y }) => withBrowser(async () => {
        await pw.touch(sessionId);
        const page = pw.activePage(sessionId);
        await page.mouse.click(x, y);
        return okText(`Clicked at (${x}, ${y}).`);
      }),
    ),

    defineTool(
      "browser_type",
      `Type text into whatever element currently has focus (e.g. after a
browser_click_xy on an input). For selector-targeted inputs prefer browser_fill.`,
      { text: z.string().describe("Text to type"), submit: z.boolean().optional().describe("Press Enter after typing") },
      async ({ text, submit }) => withBrowser(async () => {
        await pw.touch(sessionId);
        const page = pw.activePage(sessionId);
        await page.keyboard.type(text);
        if (submit) await page.keyboard.press("Enter");
        return okText(`Typed ${text.length} chars${submit ? " + Enter" : ""}.`);
      }),
    ),

    defineTool(
      "browser_press",
      `Press a keyboard key on the active page (e.g. "Enter", "Escape",
"PageDown", "Control+A").`,
      { key: z.string().describe('Playwright key, e.g. "Enter", "Escape", "PageDown"') },
      async ({ key }) => withBrowser(async () => {
        await pw.touch(sessionId);
        const page = pw.activePage(sessionId);
        await page.keyboard.press(key);
        return okText(`Pressed ${key}.`);
      }),
    ),

    defineTool(
      "browser_scroll",
      `Scroll the active page vertically by a pixel delta (positive = down).`,
      { dy: z.number().describe("Pixels to scroll; positive scrolls down") },
      async ({ dy }) => withBrowser(async () => {
        await pw.touch(sessionId);
        const page = pw.activePage(sessionId);
        await page.mouse.wheel(0, dy);
        return okText(`Scrolled ${dy}px.`);
      }),
    ),

    defineTool(
      "browser_get_url",
      `Return the active tab's current URL and title.`,
      {},
      async () => withBrowser(async () => {
        const page = pw.activePage(sessionId);
        return okText(`${page.url()} — "${await page.title()}"`);
      }),
    ),

    defineTool(
      "browser_list_tabs",
      `List open tabs in this browser session with their index, URL and title.`,
      {},
      async () => withBrowser(async () => {
        const pages = pw.listPages(sessionId);
        const lines = await Promise.all(pages.map(async (p, i) => `[${i}] ${p.url()} — "${await p.title()}"`));
        return okText(`Tabs:\n${lines.join("\n")}`);
      }),
    ),

    defineTool(
      "browser_open_tab",
      `Open a new tab (optionally navigating to a URL) and make it active.`,
      { url: z.string().optional().describe("URL to open; omit for about:blank") },
      async ({ url }) => withBrowser(async () => {
        await pw.touch(sessionId);
        const page = await pw.newTab(sessionId, url);
        return okText(`Opened tab → ${page.url()}`);
      }),
    ),

    defineTool(
      "browser_switch_tab",
      `Make a different tab active by its index (see browser_list_tabs).`,
      { index: z.number().describe("Tab index") },
      async ({ index }) => withBrowser(async () => {
        const page = pw.switchTab(sessionId, index);
        await page.bringToFront();
        return okText(`Active tab is now [${index}] ${page.url()}`);
      }),
    ),

    defineTool(
      "browser_request_human",
      `Hand off to the human for a step you must NOT do programmatically: logging
in, solving 2FA, or clearing a captcha. This PAUSES your run and shows a card in
chat with the live browser view and a "Done, continue" button. When the user
finishes and clicks continue, this returns — then re-assess the page with
browser_screenshot/browser_read_page before proceeding. Never type passwords or
attempt to defeat captchas yourself.`,
      { reason: z.string().describe("What the human needs to do, e.g. 'Log in to LinkedIn and solve any 2FA'") },
      async ({ reason }) => withBrowser(async () => {
        const b = pw.getBinding(sessionId);
        if (!b) return errText("No browser session bound. Call browser_use_profile first.");
        await pw.touch(sessionId);
        const promise = requestBrowserHandoff(sessionId, {
          reason,
          viewerUrl: b.viewerUrl,
          steelUiUrl: b.steelUiUrl,
          profile: b.profile,
        });
        if (!promise) return errText("Session not found in registry; cannot request handoff.");
        const result = await promise;
        if (result.behavior === "deny") {
          return okText("User cancelled the manual handoff. Do not proceed with the blocked action; report the blocker.");
        }
        return okText("User reported the manual step is complete. Re-assess the page (browser_screenshot or browser_read_page) before continuing.");
      }),
    ),

    defineTool(
      "browser_release",
      `Release this chat session's browser: detaches Playwright AND stops the
control-plane container (cookies persist in the profile). Call when the browser
task is fully done. Releasing does NOT log the profile out.`,
      {},
      async () => withBrowser(async () => {
        if (!pw.hasBrowser(sessionId)) return okText("No browser session was bound.");
        await pw.releaseBrowser(sessionId);
        return okText("Browser session released (profile cookies preserved).");
      }),
    ),
  ];
}
