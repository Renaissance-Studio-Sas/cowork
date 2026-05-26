// End-to-end smoke test: spawns the MCP server as a child, runs through a
// basic flow (list tools, acquire profile, navigate, screenshot, release).
//
// Run with:  npx tsx scripts/smoke-test.ts
//
// Forces the local-folder persistence backend (SKIP_R2=true) so the test runs
// without Cloudflare creds. The profile baseline is written to
// ~/.cloud-browser/store/<profile>/ — clear it to reset between runs.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function header(msg: string) {
  process.stdout.write(`\n──── ${msg} ────\n`);
}

function summarize(result: { content?: { type: string; text?: string; data?: string }[]; isError?: boolean }): string {
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
  const profile = process.env.SMOKE_PROFILE ?? "smoke-test";

  header(`spawning server (profile="${profile}")`);
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", path.join(ROOT, "src/index.ts")],
    env: { ...process.env, SKIP_R2: process.env.SKIP_R2 ?? "true" } as Record<string, string>,
  });
  const client = new Client({ name: "smoke-test", version: "0.1.0" });
  await client.connect(transport);

  header("list_tools");
  const tools = await client.listTools();
  console.log(`Registered ${tools.tools.length} tools:`);
  for (const t of tools.tools) console.log(`  - ${t.name}`);

  header("browser_list_profiles");
  console.log(summarize(await client.callTool({ name: "browser_list_profiles", arguments: {} })));

  header(`browser_use_profile (profile="${profile}")`);
  console.log(summarize(await client.callTool({ name: "browser_use_profile", arguments: { profile } })));

  header(`browser_navigate → https://example.com`);
  console.log(
    summarize(
      await client.callTool({
        name: "browser_navigate",
        arguments: { profile, url: "https://example.com" },
      }),
    ),
  );

  header("browser_read_page");
  console.log(
    summarize(
      await client.callTool({
        name: "browser_read_page",
        arguments: { profile, max_chars: 500 },
      }),
    ),
  );

  header("browser_screenshot");
  const shot = await client.callTool({ name: "browser_screenshot", arguments: { profile } });
  console.log(summarize(shot));
  for (const c of (shot.content ?? []) as { type: string; data?: string }[]) {
    if (c.type === "image" && c.data) {
      const out = path.join(ROOT, "scripts", "smoke-test-screenshot.png");
      writeFileSync(out, Buffer.from(c.data, "base64"));
      console.log(`  ↳ saved screenshot → ${out}`);
    }
  }

  header("browser_evaluate");
  console.log(
    summarize(
      await client.callTool({
        name: "browser_evaluate",
        arguments: { profile, expression: "return { ua: navigator.userAgent, title: document.title }" },
      }),
    ),
  );

  header("browser_release");
  console.log(summarize(await client.callTool({ name: "browser_release", arguments: { profile } })));

  await client.close();
  process.stdout.write("\n✓ smoke test complete\n");
  process.exit(0);
}

main().catch((e) => {
  console.error("smoke test failed:", e);
  process.exit(1);
});
