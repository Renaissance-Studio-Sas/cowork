// Drive the in-container MCP server through the gateway (no local daemon
// involved). Creates a remote session, connects an MCP SDK client to its
// /mcp endpoint, runs navigate / screenshot / release.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFileSync, readFileSync } from "node:fs";

const GATEWAY = process.env.GATEWAY ?? "https://app.rowads.studio";
const COOKIE = JSON.parse(readFileSync(`${process.env.HOME}/.rw/credentials.json`, "utf8")).envs.production.cookie;

function header(msg) { process.stdout.write(`\n──── ${msg} ────\n`); }
function summarize(result) {
  if (!result.content) return "(no content)";
  return result.content
    .map((c) => {
      if (c.type === "text") return c.text ?? "";
      if (c.type === "image") return `[image: ${c.data?.length ?? 0} base64 bytes]`;
      return `[${c.type}]`;
    })
    .join("\n");
}

async function gatewayFetch(path, init = {}) {
  return fetch(`${GATEWAY}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Cookie: `__gateway_session=${COOKIE}`,
    },
  });
}

async function main() {
  header("create session");
  const createRes = await gatewayFetch("/api/browser/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "container-mcp-smoke" }),
  });
  if (!createRes.ok) throw new Error(`create failed: ${createRes.status} ${await createRes.text()}`);
  const { sessionId } = await createRes.json();
  console.log(`sessionId=${sessionId}`);

  // Wait for the container's MCP server to come up (Chrome boot + Playwright connect).
  header("wait for /mcp/health");
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const r = await gatewayFetch(`/api/browser/sessions/${sessionId}/mcp/health`).catch(() => null);
    if (r?.ok) { console.log(await r.json()); break; }
    await new Promise((res) => setTimeout(res, 1000));
  }

  try {
    header("connect MCP SDK client");
    const url = new URL(`${GATEWAY}/api/browser/sessions/${sessionId}/mcp`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Cookie: `__gateway_session=${COOKIE}` } },
    });
    const client = new Client({ name: "container-mcp-smoke", version: "0.1.0" });
    await client.connect(transport);

    header("list tools");
    const tools = await client.listTools();
    console.log(`Registered ${tools.tools.length} tools:`);
    for (const t of tools.tools) console.log(`  - ${t.name}`);

    header("browser_navigate → https://example.com");
    console.log(summarize(await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com" } })));

    header("browser_get_url");
    console.log(summarize(await client.callTool({ name: "browser_get_url", arguments: {} })));

    header("browser_screenshot");
    const shot = await client.callTool({ name: "browser_screenshot", arguments: {} });
    const img = shot.content?.find((c) => c.type === "image");
    if (img) {
      const out = "/tmp/container-mcp-shot.png";
      writeFileSync(out, Buffer.from(img.data, "base64"));
      console.log(`screenshot saved to ${out}`);
    } else {
      console.log("NO IMAGE:", JSON.stringify(shot).slice(0, 300));
    }

    header("browser_read_page");
    console.log(summarize(await client.callTool({ name: "browser_read_page", arguments: { max_chars: 400 } })));

    await client.close();
  } finally {
    header("terminate session");
    const del = await gatewayFetch(`/api/browser/sessions/${sessionId}`, { method: "DELETE" });
    console.log(await del.text());
  }
}

main().catch((e) => { console.error("SMOKE FAILED:", e); process.exit(1); });
