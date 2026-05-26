// Drive the profile-aware MCP at /api/browser/mcp through the gateway. This
// is the surface cowork agents see — 19 tools, every one takes a `profile`,
// and the worker fans out to per-(caller, profile) containers under the
// hood. Creates a session by name, navigates, screenshots, releases.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFileSync, readFileSync } from "node:fs";

const GATEWAY = process.env.GATEWAY ?? "https://app.rowads.studio";
const COOKIE = JSON.parse(readFileSync(`${process.env.HOME}/.rw/credentials.json`, "utf8")).envs.production.cookie;
const PROFILE = process.env.PROFILE ?? "profile-smoke-test";

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

async function main() {
  header(`connect MCP — profile "${PROFILE}"`);
  const client = new Client({ name: "profile-mcp-smoke", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${GATEWAY}/api/browser/mcp`),
    {
      requestInit: {
        headers: { Cookie: `__gateway_session=${COOKIE}` },
      },
    },
  );
  await client.connect(transport);

  header("tools/list");
  const tools = await client.listTools();
  process.stdout.write(`Got ${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(", ")}\n`);

  header("browser_use_profile");
  process.stdout.write(summarize(await client.callTool({ name: "browser_use_profile", arguments: { profile: PROFILE } })) + "\n");

  header("browser_navigate");
  process.stdout.write(
    summarize(
      await client.callTool({ name: "browser_navigate", arguments: { profile: PROFILE, url: "https://example.com" } }),
    ) + "\n",
  );

  header("browser_screenshot");
  const shot = await client.callTool({ name: "browser_screenshot", arguments: { profile: PROFILE } });
  const img = shot.content?.find((c) => c.type === "image");
  if (img?.data) {
    const out = "/tmp/profile-mcp-shot.png";
    writeFileSync(out, Buffer.from(img.data, "base64"));
    process.stdout.write(`Screenshot saved → ${out}\n`);
  } else {
    process.stdout.write("No image in screenshot result\n");
  }

  header("browser_release");
  process.stdout.write(summarize(await client.callTool({ name: "browser_release", arguments: { profile: PROFILE } })) + "\n");

  await client.close();
}

main().catch((e) => {
  process.stderr.write(`FAILED: ${e?.stack ?? e}\n`);
  process.exit(1);
});
