// cloud-browser entry point.
//
// Streamable HTTP MCP server. One shared daemon per machine; all clients
// (cowork agents, Claude Desktop, …) connect over HTTP to a single instance
// that owns the profile registry. Profile state is global — if cowork agent A
// acquires "admin", cowork agent B's browser_use_profile("admin") reuses the
// same live container instead of spawning a second one.
//
// Survives parent (cowork) restarts: detached server, port-bound, PID-file
// coordinated. The previous stdio transport tied container lifetime to
// cowork's lifetime, which caused churn whenever cowork restarted mid-session.

import http from "node:http";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";
import * as reg from "./session-registry.js";
import { log } from "./log.js";
import {
  CHROME_IMAGE,
  DOCKER_SOCKET,
  HTTP_HOST,
  HTTP_PORT,
  IDLE_TIMEOUT_MS,
  LOCAL_STORE_DIR,
  PERSISTENCE_BACKEND,
  PID_FILE,
  R2,
} from "./config.js";

const SERVER_VERSION = "0.1.0";

// Best-effort: an existing daemon already owns the port. We exit so the caller
// (cowork's auto-spawn helper) just uses whatever's running. We do not race
// to take ownership — last-writer-wins on the port would orphan live sessions.
function bailIfAlreadyRunning(): void {
  try {
    const raw = readFileSync(PID_FILE, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0); // throws ESRCH if dead
        log.info("daemon already running, exiting", { pid, pidFile: PID_FILE });
        process.exit(0);
      } catch {
        // Stale PID; fall through and let port-bind decide.
      }
    }
  } catch {
    // No PID file; fall through.
  }
}

function writePidFile(): void {
  mkdirSync(path.dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, String(process.pid));
}

function removePidFile(): void {
  try {
    const raw = readFileSync(PID_FILE, "utf8").trim();
    if (Number.parseInt(raw, 10) === process.pid) unlinkSync(PID_FILE);
  } catch {
    /* already gone */
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  return JSON.parse(raw);
}

async function main() {
  bailIfAlreadyRunning();

  log.info("cloud-browser starting", {
    transport: "http",
    host: HTTP_HOST,
    port: HTTP_PORT,
    chromeImage: CHROME_IMAGE,
    dockerSocket: DOCKER_SOCKET ?? "(default)",
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    persistence:
      PERSISTENCE_BACKEND === "r2"
        ? { backend: "r2", bucket: R2!.bucket, endpoint: R2!.endpoint }
        : { backend: "local", dir: LOCAL_STORE_DIR },
  });

  // One transport per MCP session. The Streamable HTTP spec assigns a session
  // ID on initialize; subsequent requests carry it in mcp-session-id. The
  // browser registry is global across all sessions — see the file header.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function getOrCreateTransport(sessionId: string | undefined, body: unknown): Promise<StreamableHTTPServerTransport | null> {
    if (sessionId && transports.has(sessionId)) {
      return transports.get(sessionId)!;
    }
    // Only initialize requests are allowed to create a new session.
    const isInit =
      typeof body === "object" && body !== null && (body as { method?: string }).method === "initialize";
    if (!isInit) return null;

    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        transports.set(id, transport);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) transports.delete(id);
    };

    const server = new McpServer({ name: "cloud-browser", version: SERVER_VERSION });
    registerTools(server);
    await server.connect(transport);
    return transport;
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = req.url ?? "";

      if (req.method === "GET" && (url === "/health" || url.startsWith("/health?"))) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            version: SERVER_VERSION,
            pid: process.pid,
            persistence: PERSISTENCE_BACKEND,
            liveSessions: reg.listSessions().map((s) => s.profile),
          }),
        );
        return;
      }

      if (!url.startsWith("/mcp")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      const body = req.method === "POST" ? await readJsonBody(req).catch(() => undefined) : undefined;
      const sessionId = req.headers["mcp-session-id"];
      const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;

      const transport = await getOrCreateTransport(sid, body);
      if (!transport) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "No active MCP session; send initialize first" },
            id: null,
          }),
        );
        return;
      }

      await transport.handleRequest(req, res, body);
    } catch (e) {
      log.error("http request error", { err: e instanceof Error ? e.stack ?? e.message : String(e) });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      } else {
        res.end();
      }
    }
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.info("port already bound — daemon is already running, exiting", { port: HTTP_PORT });
      process.exit(0);
    }
    log.error("http server error", { err: String(err) });
    process.exit(1);
  });

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
    try {
      httpServer.close();
    } catch {
      /* ignore */
    }
    removePidFile();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // No SIGHUP / stdin-EOF handling: this is a detached daemon, not a child
  // process tied to a parent's stdio pipe. Parent restarts must NOT take down
  // live browser sessions — that's the whole point of the HTTP refactor.

  await new Promise<void>((resolve) => httpServer.listen(HTTP_PORT, HTTP_HOST, resolve));
  writePidFile();
  log.info("cloud-browser HTTP MCP ready", {
    url: `http://${HTTP_HOST}:${HTTP_PORT}/mcp`,
    health: `http://${HTTP_HOST}:${HTTP_PORT}/health`,
    pid: process.pid,
  });
}

main().catch((e) => {
  log.error("fatal", { err: e instanceof Error ? e.stack ?? e.message : String(e) });
  process.exit(1);
});
