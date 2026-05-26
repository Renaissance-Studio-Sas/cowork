// The 19 agent-facing tools. Each takes a `profile` parameter (the browser
// handle). Tools live as a flat array and get registered in src/index.ts.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as reg from "./session-registry.js";
import * as persistence from "./persistence.js";
import { saveArtifactInstruction, deleteArtifactInstruction } from "./artifacts.js";

type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
};

function textOk(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
function textErr(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

async function wrap(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    return textErr(e instanceof Error ? e.message : String(e));
  }
}

interface InteractiveEl {
  tag: string;
  role: string;
  name: string;
  selector: string;
}

export function registerTools(server: McpServer): void {
  // ─── Lifecycle ──────────────────────────────────────────────────────────

  server.registerTool(
    "browser_list_profiles",
    {
      description:
        "List browser profiles available in persistent storage + show which are currently active in this MCP session. A profile = persistent cookies/login state for one Chrome identity.",
      inputSchema: {},
    },
    async () =>
      wrap(async () => {
        const stored = await persistence.listProfiles();
        const live = new Set(reg.listSessions().map((s) => s.profile));
        const backendLabel = persistence.describeBackend();
        if (stored.length === 0 && live.size === 0) {
          return textOk(
            `No profiles yet (storage: ${backendLabel}). Call browser_use_profile with any name to create one.`,
          );
        }
        const lines = stored.map((p) => {
          const liveTag = live.has(p.name) ? " (ACTIVE)" : "";
          const mtime = p.mtime ? p.mtime.toISOString() : "—";
          const size = p.sizeBytes != null ? `${(p.sizeBytes / 1024 / 1024).toFixed(1)} MB` : "—";
          return `- ${p.name}${liveTag}    saved=${mtime}    size=${size}`;
        });
        for (const profile of live) {
          if (!stored.some((p) => p.name === profile)) {
            lines.push(`- ${profile} (ACTIVE, unsaved)`);
          }
        }
        return textOk(`Profiles (storage: ${backendLabel}):\n${lines.join("\n")}`);
      }),
  );

  server.registerTool(
    "browser_use_profile",
    {
      description:
        "Acquire a live browser session for a profile (spawns a Chromium container, ~3–5s on cold start). Restores the profile's cookies/login state from persistent storage (R2 or local folder). Reuses an existing session if one is already live in this MCP for the same profile. Auto-creates the profile if no baseline exists (you'll get an empty, logged-out Chrome — use browser_request_human to log in, then browser_release will persist the new state).",
      inputSchema: {
        profile: z
          .string()
          .regex(/^[a-z0-9][a-z0-9._@-]{0,62}$/, "lowercase alphanumerics + . _ @ -, must start alphanumeric")
          .describe("Profile name, e.g. 'linkedin-personal' or 'admin@rowads.studio'"),
      },
    },
    async ({ profile }) =>
      wrap(async () => {
        const { session, reused } = await reg.acquire(profile);
        return textOk(
          `${reused ? "Reusing" : "Acquired"} browser session for profile "${session.profile}".\n` +
            `Live view (noVNC): ${session.novncUrl}\n` +
            `If the profile isn't logged into the target site, call browser_request_human so the user can log in once; state will be saved on release.` +
            saveArtifactInstruction(session.profile, session.novncUrl),
        );
      }),
  );

  server.registerTool(
    "browser_release",
    {
      description:
        "Release the browser session for a profile: stops the container and persists the (modified) profile state so future sessions start logged in. Storage backend is R2 if configured, otherwise a local folder. Always call when done — otherwise the idle reaper does it after IDLE_TIMEOUT_MS (default 30 min).",
      inputSchema: { profile: z.string() },
    },
    async ({ profile }) =>
      wrap(async () => {
        if (!reg.getSession(profile)) return textOk(`No active session for profile "${profile}".`);
        const { persisted } = await reg.release(profile);
        return textOk(
          (persisted
            ? `Released profile "${profile}". State saved to ${persistence.describeBackend()}.`
            : `Released profile "${profile}". (Persistence failed — state not saved; see server logs.)`) +
            deleteArtifactInstruction(profile),
        );
      }),
  );

  // ─── Page primitives ────────────────────────────────────────────────────

  server.registerTool(
    "browser_navigate",
    {
      description:
        "Navigate the active tab to a URL (waits for DOM ready). After navigating, inspect the page with browser_read_page or browser_screenshot — sites may show consent banners, login walls, or captchas.",
      inputSchema: { profile: z.string(), url: z.string().describe("Absolute URL") },
    },
    async ({ profile, url }) =>
      wrap(async () => {
        reg.touch(profile);
        const page = reg.activePage(profile);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return textOk(`Navigated to ${page.url()} — title: "${await page.title()}"`);
      }),
  );

  server.registerTool(
    "browser_get_url",
    {
      description: "Return the active tab's current URL and title.",
      inputSchema: { profile: z.string() },
    },
    async ({ profile }) =>
      wrap(async () => {
        reg.touch(profile);
        const page = reg.activePage(profile);
        return textOk(`${page.url()} — "${await page.title()}"`);
      }),
  );

  server.registerTool(
    "browser_read_page",
    {
      description:
        "Read the active page as structured data: URL, title, visible text, and a numbered list of interactive elements (links/buttons/inputs) with suggested selectors for browser_click / browser_fill. Use for DOM-driven automation; use browser_screenshot when the layout matters or the DOM is opaque.",
      inputSchema: {
        profile: z.string(),
        max_chars: z.number().int().positive().optional().describe("Max visible-text chars (default 6000)"),
      },
    },
    async ({ profile, max_chars }) =>
      wrap(async () => {
        reg.touch(profile);
        const page = reg.activePage(profile);
        const limit = max_chars ?? 6000;
        const text: string = await page.evaluate(() => (document.body?.innerText ?? "").trim());
        const els = (await page.evaluate(() => {
          const out: { tag: string; role: string; name: string; selector: string }[] = [];
          const nodes = Array.from(
            document.querySelectorAll(
              'a[href], button, input, textarea, select, [role="button"], [role="link"]',
            ),
          );
          for (const el of nodes.slice(0, 120)) {
            const h = el as HTMLElement;
            const style = window.getComputedStyle(h);
            if (style.display === "none" || style.visibility === "hidden" || h.offsetParent === null) continue;
            const tag = h.tagName.toLowerCase();
            const role = h.getAttribute("role") ?? "";
            const name = (
              h.getAttribute("aria-label") ||
              (h as HTMLInputElement).placeholder ||
              h.innerText ||
              (h as HTMLInputElement).value ||
              h.getAttribute("name") ||
              h.getAttribute("title") ||
              ""
            )
              .trim()
              .slice(0, 80);
            let selector = "";
            if (h.id) selector = `#${CSS.escape(h.id)}`;
            else if (h.getAttribute("name"))
              selector = `${tag}[name="${h.getAttribute("name")}"]`;
            else if (h.getAttribute("aria-label"))
              selector = `${tag}[aria-label="${h.getAttribute("aria-label")}"]`;
            else if (tag === "a" && h.getAttribute("href"))
              selector = `a[href="${h.getAttribute("href")}"]`;
            out.push({ tag, role, name, selector });
          }
          return out;
        })) as InteractiveEl[];
        const elLines = els.map(
          (e, i) =>
            `[${i}] <${e.tag}${e.role ? ` role=${e.role}` : ""}> ${e.name ? `"${e.name}"` : ""}${
              e.selector ? `  selector: ${e.selector}` : "  (no stable selector — use text= or screenshot+click_xy)"
            }`,
        );
        const body = text.length > limit ? text.slice(0, limit) + `\n…[truncated, ${text.length} chars total]` : text;
        return textOk(
          `URL: ${page.url()}\nTitle: ${await page.title()}\n\n--- Interactive elements ---\n${
            elLines.join("\n") || "(none found)"
          }\n\n--- Visible text ---\n${body}`,
        );
      }),
  );

  server.registerTool(
    "browser_screenshot",
    {
      description:
        "Capture a PNG of the active tab and return it as an image so you can SEE the page. Use full_page for long pages; default captures the viewport. Pair with browser_click_xy for vision-driven interaction.",
      inputSchema: {
        profile: z.string(),
        full_page: z.boolean().optional().describe("Capture the entire scrollable page (default false)"),
      },
    },
    async ({ profile, full_page }) =>
      wrap(async () => {
        reg.touch(profile);
        const page = reg.activePage(profile);
        const buf = await page.screenshot({ type: "png", fullPage: full_page ?? false });
        return {
          content: [
            {
              type: "text",
              text: `Screenshot of ${page.url()} (${page.viewportSize()?.width ?? "?"}x${
                page.viewportSize()?.height ?? "?"
              })`,
            },
            { type: "image", data: buf.toString("base64"), mimeType: "image/png" },
          ],
        };
      }),
  );

  // ─── DOM-driven interaction ─────────────────────────────────────────────

  server.registerTool(
    "browser_click",
    {
      description:
        "Click an element by Playwright selector. Accepts CSS (#id, button[name=…]), text (text=\"Sign in\"), or role engines. Prefer stable selectors from browser_read_page; fall back to browser_click_xy for opaque DOMs.",
      inputSchema: {
        profile: z.string(),
        selector: z.string().describe('e.g. "#submit", \'text="Log in"\', \'a[href*="/feed"]\''),
      },
    },
    async ({ profile, selector }) =>
      wrap(async () => {
        reg.touch(profile);
        const page = reg.activePage(profile);
        await page.click(selector, { timeout: 10000 });
        return textOk(`Clicked ${selector}. Now on ${page.url()}`);
      }),
  );

  server.registerTool(
    "browser_fill",
    {
      description:
        "Type text into an input/textarea (clears existing value first). For non-text inputs or rotating DOMs, use browser_click_xy + browser_type.",
      inputSchema: {
        profile: z.string(),
        selector: z.string(),
        text: z.string(),
      },
    },
    async ({ profile, selector, text }) =>
      wrap(async () => {
        reg.touch(profile);
        const page = reg.activePage(profile);
        await page.fill(selector, text, { timeout: 10000 });
        return textOk(`Filled ${selector}.`);
      }),
  );

  server.registerTool(
    "browser_extract",
    {
      description:
        "Extract text content of all elements matching a selector (lists/tables/etc.). Returns up to 200 matches.",
      inputSchema: {
        profile: z.string(),
        selector: z.string(),
      },
    },
    async ({ profile, selector }) =>
      wrap(async () => {
        reg.touch(profile);
        const page = reg.activePage(profile);
        const texts = await page.locator(selector).allInnerTexts();
        const slice = texts.slice(0, 200);
        return textOk(
          `Matched ${texts.length} element(s)${texts.length > 200 ? " (showing 200)" : ""}:\n${
            slice.map((t, i) => `[${i}] ${t.replace(/\s+/g, " ").trim()}`).join("\n") || "(no matches)"
          }`,
        );
      }),
  );

  // ─── Vision-driven interaction ──────────────────────────────────────────

  server.registerTool(
    "browser_click_xy",
    {
      description:
        "Click at pixel coordinates in the viewport (vision-driven). Pair with browser_screenshot to locate targets when selectors aren't reliable.",
      inputSchema: {
        profile: z.string(),
        x: z.number(),
        y: z.number(),
      },
    },
    async ({ profile, x, y }) =>
      wrap(async () => {
        reg.touch(profile);
        const page = reg.activePage(profile);
        await page.mouse.click(x, y);
        return textOk(`Clicked at (${x}, ${y}).`);
      }),
  );

  server.registerTool(
    "browser_type",
    {
      description:
        "Type text into whatever element currently has focus (e.g. after browser_click_xy on an input). For selector-targeted inputs prefer browser_fill.",
      inputSchema: {
        profile: z.string(),
        text: z.string(),
        submit: z.boolean().optional().describe("Press Enter after typing"),
      },
    },
    async ({ profile, text, submit }) =>
      wrap(async () => {
        reg.touch(profile);
        const page = reg.activePage(profile);
        await page.keyboard.type(text);
        if (submit) await page.keyboard.press("Enter");
        return textOk(`Typed ${text.length} chars${submit ? " + Enter" : ""}.`);
      }),
  );

  server.registerTool(
    "browser_press",
    {
      description: 'Press a single keyboard key on the active page (e.g. "Enter", "Escape", "PageDown", "Control+A").',
      inputSchema: {
        profile: z.string(),
        key: z.string(),
      },
    },
    async ({ profile, key }) =>
      wrap(async () => {
        reg.touch(profile);
        const page = reg.activePage(profile);
        await page.keyboard.press(key);
        return textOk(`Pressed ${key}.`);
      }),
  );

  server.registerTool(
    "browser_scroll",
    {
      description: "Scroll the active page vertically by a pixel delta (positive = down).",
      inputSchema: {
        profile: z.string(),
        dy: z.number(),
      },
    },
    async ({ profile, dy }) =>
      wrap(async () => {
        reg.touch(profile);
        const page = reg.activePage(profile);
        await page.mouse.wheel(0, dy);
        return textOk(`Scrolled ${dy}px.`);
      }),
  );

  // ─── Tabs ───────────────────────────────────────────────────────────────

  server.registerTool(
    "browser_list_tabs",
    {
      description: "List open tabs in this profile's browser with their index, URL, and title.",
      inputSchema: { profile: z.string() },
    },
    async ({ profile }) =>
      wrap(async () => {
        reg.touch(profile);
        const s = reg.getSession(profile);
        if (!s) throw new Error(`No active session for profile "${profile}"`);
        const pages = s.context.pages();
        const lines = await Promise.all(pages.map(async (p, i) => `[${i}] ${p.url()} — "${await p.title()}"`));
        return textOk(`Tabs:\n${lines.join("\n")}`);
      }),
  );

  server.registerTool(
    "browser_open_tab",
    {
      description: "Open a new tab in this profile's browser (optionally navigating to a URL) and make it active.",
      inputSchema: {
        profile: z.string(),
        url: z.string().optional(),
      },
    },
    async ({ profile, url }) =>
      wrap(async () => {
        reg.touch(profile);
        const s = reg.getSession(profile);
        if (!s) throw new Error(`No active session for profile "${profile}"`);
        const page = await s.context.newPage();
        if (url) await page.goto(url, { waitUntil: "domcontentloaded" });
        s.activePageIndex = s.context.pages().indexOf(page);
        try {
          await page.bringToFront();
        } catch {
          /* ignore */
        }
        return textOk(`Opened tab → ${page.url()}`);
      }),
  );

  server.registerTool(
    "browser_switch_tab",
    {
      description: "Make a different tab active by its index (see browser_list_tabs).",
      inputSchema: {
        profile: z.string(),
        index: z.number().int().nonnegative(),
      },
    },
    async ({ profile, index }) =>
      wrap(async () => {
        reg.touch(profile);
        const s = reg.getSession(profile);
        if (!s) throw new Error(`No active session for profile "${profile}"`);
        const pages = s.context.pages();
        if (index < 0 || index >= pages.length) {
          throw new Error(`Tab index ${index} out of range (0..${pages.length - 1})`);
        }
        s.activePageIndex = index;
        try {
          await pages[index]!.bringToFront();
        } catch {
          /* ignore */
        }
        return textOk(`Active tab is now [${index}] ${pages[index]!.url()}`);
      }),
  );

  // ─── Human handoff ──────────────────────────────────────────────────────

  server.registerTool(
    "browser_request_human",
    {
      description:
        "Hand off to the human for steps the agent must NOT do programmatically: logging in, solving 2FA, clearing captchas. Returns a noVNC URL where the human can interact with the browser visually. No callback — after asking the human to act, re-assess the page with browser_screenshot / browser_read_page before proceeding. Never type passwords yourself.",
      inputSchema: {
        profile: z.string(),
        reason: z.string().describe("What the human needs to do, e.g. 'Log in to LinkedIn and solve any 2FA'"),
      },
    },
    async ({ profile, reason }) =>
      wrap(async () => {
        reg.touch(profile);
        const s = reg.getSession(profile);
        if (!s) throw new Error(`No active session for profile "${profile}"`);
        return textOk(
          `Human handoff requested for profile "${profile}".\n` +
            `Reason: ${reason}\n` +
            `Live view (noVNC): ${s.novncUrl}\n` +
            `Tell the user to visit that URL, do the task, then continue. Verify completion with browser_screenshot or browser_read_page before proceeding.`,
        );
      }),
  );

  // ─── Escape hatch ───────────────────────────────────────────────────────

  server.registerTool(
    "browser_evaluate",
    {
      description:
        "Run arbitrary JavaScript in the active tab's MAIN world and return the result. Use when read_page/extract don't fit (complex DOM queries, page-internal data). The expression is evaluated as: `(async () => { <YOUR JS> })()`. Return JSON-serializable values.",
      inputSchema: {
        profile: z.string(),
        expression: z
          .string()
          .describe("JS expression or statement(s). The last expression's value is returned (use `return` in a block)."),
      },
    },
    async ({ profile, expression }) =>
      wrap(async () => {
        reg.touch(profile);
        const page = reg.activePage(profile);
        const wrapped = `(async () => { ${expression} })()`;
        const result = await page.evaluate(wrapped);
        const text =
          typeof result === "string" ? result : JSON.stringify(result, null, 2) ?? "undefined";
        return textOk(text.length > 6000 ? text.slice(0, 6000) + `\n…[truncated]` : text);
      }),
  );
}
