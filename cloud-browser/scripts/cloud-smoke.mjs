// Drive the local MCP daemon and verify it spawns a remote container,
// navigates, takes a screenshot, and releases cleanly.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFileSync } from "node:fs";

function header(msg) {
  process.stdout.write(`\n──── ${msg} ────\n`);
}

function summarize(result) {
  if (!result.content) return "(no content)";
  return result.content
    .map((c) => {
      if (c.type === "text") return c.text ?? "";
      if (c.type === "image") return `[image: ${c.data?.length ?? 0} base64 bytes, mime=${c.mimeType}]`;
      return `[${c.type}]`;
    })
    .join("\n");
}

async function main() {
  const profile = process.env.SMOKE_PROFILE ?? "smoke-cloud";
  const url = new URL("http://127.0.0.1:7400/mcp");

  header(`connect to MCP daemon at ${url}`);
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: "cloud-smoke", version: "0.1.0" });
  await client.connect(transport);

  header("list_tools");
  const tools = await client.listTools();
  console.log(`Registered ${tools.tools.length} tools`);

  header("browser_list_profiles (before)");
  console.log(summarize(await client.callTool({ name: "browser_list_profiles", arguments: {} })));

  header(`browser_use_profile (profile="${profile}")`);
  const acquired = await client.callTool({ name: "browser_use_profile", arguments: { profile } });
  // Strip the giant HTML artifact instruction so the log stays readable.
  const headLine = summarize(acquired).split("To let the user watch")[0];
  console.log(headLine);

  header("browser_navigate → https://example.com");
  console.log(summarize(await client.callTool({
    name: "browser_navigate",
    arguments: { profile, url: "https://example.com" },
  })));

  header("browser_get_url");
  console.log(summarize(await client.callTool({ name: "browser_get_url", arguments: { profile } })));

  header("browser_screenshot");
  const shot = await client.callTool({ name: "browser_screenshot", arguments: { profile } });
  const img = shot.content?.find((c) => c.type === "image");
  if (img) {
    const out = "/tmp/cloud-smoke-shot.png";
    writeFileSync(out, Buffer.from(img.data, "base64"));
    console.log(`screenshot saved to ${out} (${img.data.length} b64 chars)`);
  } else {
    console.log("NO IMAGE RETURNED — flags:", JSON.stringify(shot, null, 2).slice(0, 500));
  }

  header("browser_list_profiles (mid-session)");
  console.log(summarize(await client.callTool({ name: "browser_list_profiles", arguments: {} })));

  header("browser_release");
  const released = await client.callTool({ name: "browser_release", arguments: { profile } });
  const releaseHead = summarize(released).split("\n\nThe live view")[0];
  console.log(releaseHead);

  header("done");
  await client.close();
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
