// cloud-browser entry point.
// Stdio MCP server. Spawns Chromium-in-Docker containers per profile,
// persists profile state to R2 or to a local folder (whichever is configured).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import * as reg from "./session-registry.js";
import { log } from "./log.js";
import {
  CHROME_IMAGE,
  DOCKER_SOCKET,
  IDLE_TIMEOUT_MS,
  LOCAL_STORE_DIR,
  PERSISTENCE_BACKEND,
  R2,
} from "./config.js";

async function main() {
  log.info("cloud-browser starting", {
    chromeImage: CHROME_IMAGE,
    dockerSocket: DOCKER_SOCKET ?? "(default)",
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    persistence:
      PERSISTENCE_BACKEND === "r2"
        ? { backend: "r2", bucket: R2!.bucket, endpoint: R2!.endpoint }
        : { backend: "local", dir: LOCAL_STORE_DIR },
  });

  const server = new McpServer({ name: "cloud-browser", version: "0.1.0" });
  registerTools(server);

  // Graceful shutdown: release every live session before exit.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown signal received", { signal });
    try {
      await reg.releaseAll();
    } catch (e) {
      log.error("error during shutdown release", { err: String(e) });
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("stdio transport connected — ready");
}

main().catch((e) => {
  log.error("fatal", { err: e instanceof Error ? e.stack ?? e.message : String(e) });
  process.exit(1);
});
