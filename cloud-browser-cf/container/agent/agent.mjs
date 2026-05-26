// In-container agent: drives Chromium over localhost CDP with playwright-core
// and exposes ops as HTTP for the Worker/DO to call. Also handles profile
// hydrate/save (tar of /profile, cache-filtered) so R2 creds stay in the Worker.
//
// Playwright calls served over HTTP from inside the container instead of from a
// host MCP. Port remaining tools (extract, request_human handoff, …) the same way.

import http from "node:http";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright-core";

const CDP = "http://127.0.0.1:9223"; // socat → chromium 9222 (see entrypoint.sh)
const PROFILE_DIR = "/profile";

// Login-relevant state to persist; throwaway caches excluded (mirror cloud-browser).
// Glob patterns (tar --exclude matches the whole path, so wrap in * to catch
// nested dirs like ./GraphiteDawnCache/…). Keep cookies/login state, drop caches.
const EXCLUDE = ["*Cache*", "*Crashpad*", "*Singleton*", "*Dawn*", "*ShaderCache*", "*GPUCache*"];

let browser, context;
async function page() {
  if (!browser) {
    const ver = await (await fetch(`${CDP}/json/version`)).json();
    const ws = ver.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, "ws://127.0.0.1:9223");
    browser = await chromium.connectOverCDP(ws);
  }
  context = browser.contexts()[0] ?? (await browser.newContext());
  return context.pages()[0] ?? (await context.newPage());
}

// op handlers — args come from the POST body { ...toolArgs }
const ops = {
  async navigate(a) { const p = await page(); await p.goto(a.url, { waitUntil: "domcontentloaded" }); await p.bringToFront(); return { url: p.url(), title: await p.title() }; },
  async get_url() { const p = await page(); return { url: p.url(), title: await p.title() }; },
  async read_page(a) {
    const p = await page();
    const text = await p.evaluate(() => (document.body?.innerText ?? "").trim());
    return { url: p.url(), title: await p.title(), text: text.slice(0, a.max_chars ?? 6000) };
  },
  async click(a) { const p = await page(); await p.click(a.selector, { timeout: 10000 }); return { ok: true, url: p.url() }; },
  async click_xy(a) { const p = await page(); await p.mouse.click(a.x, a.y); return { ok: true }; },
  async fill(a) { const p = await page(); await p.fill(a.selector, a.text, { timeout: 10000 }); return { ok: true }; },
  async type(a) { const p = await page(); await p.keyboard.type(a.text); if (a.submit) await p.keyboard.press("Enter"); return { ok: true }; },
  async press(a) { const p = await page(); await p.keyboard.press(a.key); return { ok: true }; },
  async scroll(a) { const p = await page(); await p.mouse.wheel(0, a.dy); return { ok: true }; },
  async list_tabs() { const c = (await page(), context); return { tabs: await Promise.all(c.pages().map(async (pg, i) => ({ index: i, url: pg.url(), title: await pg.title() }))) }; },
  async open_tab(a) { const c = (await page(), context); const pg = await c.newPage(); if (a.url) await pg.goto(a.url, { waitUntil: "domcontentloaded" }); return { ok: true, url: pg.url() }; },
  async switch_tab(a) { const c = (await page(), context); const pg = c.pages()[a.index]; if (!pg) throw new Error("no such tab"); await pg.bringToFront(); return { ok: true, url: pg.url() }; },
  async evaluate(a) { const p = await page(); return { result: await p.evaluate(a.expression) }; },
  async screenshot(a) { const p = await page(); const buf = await p.screenshot({ type: "png", fullPage: !!a.full_page }); return { __image: buf.toString("base64"), mimeType: "image/png" }; },
};

async function readBody(req) { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); }

const server = http.createServer(async (req, res) => {
  const path = req.url.replace(/^\//, "");
  try {
    if (path === "health") {
      const ok = await fetch(`${CDP}/json/version`).then((r) => r.ok).catch(() => false);
      return send(res, ok ? 200 : 503, { ready: ok });
    }
    if (path === "hydrate") { // receive a tarball, unpack into /profile
      const body = await readBody(req);
      spawnSync("tar", ["xzf", "-", "-C", PROFILE_DIR], { input: body });
      return send(res, 200, { ok: true });
    }
    if (path === "save") { // tar /profile back out, cache dirs excluded
      const excl = EXCLUDE.flatMap((e) => ["--exclude", e]);
      const out = spawnSync("tar", ["czf", "-", "-C", PROFILE_DIR, ...excl, "."], { maxBuffer: 1 << 30 });
      res.writeHead(200, { "content-type": "application/gzip" });
      return res.end(out.stdout);
    }
    const op = ops[path];
    if (!op) return send(res, 404, { error: "unknown op" });
    const args = (await readBody(req).then((b) => (b.length ? JSON.parse(b) : {}))) ?? {};
    const result = await op(args);
    if (result.__image) { res.writeHead(200, { "content-type": "image/png" }); return res.end(Buffer.from(result.__image, "base64")); }
    return send(res, 200, result);
  } catch (e) {
    return send(res, 500, { error: e?.message ?? String(e) });
  }
});

function send(res, code, obj) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }
server.listen(8080, () => console.log("[agent] listening on :8080"));
