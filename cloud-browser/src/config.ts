// Env-var-driven configuration. Loaded once at startup.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function envOr(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

// Persistence backend is chosen by env presence:
//   - R2_BUCKET set (and SKIP_R2 != "true")  →  R2
//   - otherwise                              →  local folder under LOCAL_STORE_DIR
// SKIP_R2=true is the explicit override that forces local even if R2 vars exist
// (useful when you want to iterate against the local store while R2 creds are present).
export const SKIP_R2 = process.env.SKIP_R2 === "true";
export const PERSISTENCE_BACKEND: "r2" | "local" =
  !SKIP_R2 && process.env.R2_BUCKET ? "r2" : "local";

export const CHROME_IMAGE = envOr("CHROME_IMAGE", "cloud-browser/chromium:latest");

export const IDLE_TIMEOUT_MS = Number(envOr("IDLE_TIMEOUT_MS", String(30 * 60 * 1000)));

export const PROFILE_CACHE_DIR = expandHome(
  envOr("PROFILE_CACHE_DIR", "~/.cloud-browser/profiles"),
);

// Local persistent store — one folder per profile, holding the post-exclusion
// userDataDir tree (cookies, Local Storage, IndexedDB, Login Data, …).
// Each session still gets its own ephemeral copy under PROFILE_CACHE_DIR.
export const LOCAL_STORE_DIR = expandHome(
  envOr("LOCAL_STORE_DIR", "~/.cloud-browser/store"),
);

// Shared Chromium component caches (component_crx_cache, WasmTtsEngine,
// OnDeviceHeadSuggestModel, …). Bind-mounted into every container so the
// downloads happen once and are reused across all profiles. Contents are
// Google-CDN-delivered, deterministic, and contain no user-specific state —
// safe to share. See SHARED_COMPONENT_DIRS in profile-store.ts for the full
// list of dirs that get symlinked into /profile on container start.
export const SHARED_COMPONENTS_DIR = expandHome(
  envOr("SHARED_COMPONENTS_DIR", "~/.cloud-browser/shared-components"),
);

// Resolve the Docker socket path. Honors DOCKER_HOST (unix://...) if set;
// otherwise picks the first existing socket from common locations (Docker
// Desktop, colima, Docker Engine). dockerode doesn't read `docker context`
// itself, so we have to do this lookup.
function resolveDockerSocket(): string | undefined {
  const env = process.env.DOCKER_HOST;
  if (env) {
    return env.startsWith("unix://") ? env.slice("unix://".length) : env;
  }
  const candidates = [
    "/var/run/docker.sock",
    path.join(os.homedir(), ".docker/run/docker.sock"), // Docker Desktop user-mode
    path.join(os.homedir(), ".colima/default/docker.sock"), // colima default profile
    path.join(os.homedir(), ".rd/docker.sock"), // Rancher Desktop
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isSocket()) return c;
    } catch { /* not present */ }
  }
  return undefined; // dockerode will fall back to its own default
}

export const DOCKER_SOCKET = resolveDockerSocket();

export const R2 =
  PERSISTENCE_BACKEND === "r2"
    ? {
        bucket: envOrThrow("R2_BUCKET"),
        accountId: envOrThrow("R2_ACCOUNT_ID"),
        accessKeyId: envOrThrow("R2_ACCESS_KEY_ID"),
        secretAccessKey: envOrThrow("R2_SECRET_ACCESS_KEY"),
        get endpoint() {
          return `https://${this.accountId}.r2.cloudflarestorage.com`;
        },
      }
    : null;

// Tagged on every container we spawn so we can find/clean up orphans.
export const CONTAINER_LABEL = "cloud-browser.managed=true";
export const CONTAINER_PROFILE_LABEL = "cloud-browser.profile";

// Local HTTP MCP transport. The server runs as a daemon — one shared instance
// per machine — that any MCP client (cowork agents, Claude Desktop, …) talks
// to over Streamable HTTP at PID-file-coordinated 127.0.0.1:CLOUD_BROWSER_HTTP_PORT.
// Loopback-only by design; not meant to be exposed off-host.
export const HTTP_HOST = envOr("CLOUD_BROWSER_HTTP_HOST", "127.0.0.1");
export const HTTP_PORT = Number(envOr("CLOUD_BROWSER_HTTP_PORT", "7400"));
export const PID_FILE = expandHome(
  envOr("CLOUD_BROWSER_PID_FILE", "~/.cloud-browser/server.pid"),
);
