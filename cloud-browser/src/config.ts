// Env-var-driven configuration. Loaded once at startup.

import os from "node:os";
import path from "node:path";

function envOr(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

// Where the MCP daemon talks to the gateway. Default points at production.
// Override with RW_GATEWAY for staging or a local gateway dev server.
export const GATEWAY_URL = envOr("RW_GATEWAY", "https://app.rowads.studio");

// Credentials file written by `rw auth login`. We pull the production
// session cookie from here to authenticate gateway calls + the CDP / noVNC
// WebSocket connections that follow.
export const RW_CREDS_FILE = expandHome(envOr("RW_CREDS_FILE", "~/.rw/credentials.json"));

// Local idle reaper — releases the MCP-side handle (and tells the remote to
// destroy its container) after this much inactivity. The remote also has its
// own 15-min idle timeout; whichever fires first wins.
export const IDLE_TIMEOUT_MS = Number(envOr("IDLE_TIMEOUT_MS", String(30 * 60 * 1000)));

// Local HTTP MCP transport. The server runs as a daemon — one shared
// instance per machine — that any MCP client (cowork agents, Claude Desktop,
// …) talks to over Streamable HTTP at PID-file-coordinated
// 127.0.0.1:CLOUD_BROWSER_HTTP_PORT. Loopback-only by design.
export const HTTP_HOST = envOr("CLOUD_BROWSER_HTTP_HOST", "127.0.0.1");
export const HTTP_PORT = Number(envOr("CLOUD_BROWSER_HTTP_PORT", "7400"));
export const PID_FILE = expandHome(
  envOr("CLOUD_BROWSER_PID_FILE", "~/.cloud-browser/server.pid"),
);
