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

export const SKIP_R2 = process.env.SKIP_R2 === "true";

export const CHROME_IMAGE = envOr("CHROME_IMAGE", "cloud-browser/chromium:latest");

export const IDLE_TIMEOUT_MS = Number(envOr("IDLE_TIMEOUT_MS", String(30 * 60 * 1000)));

export const PROFILE_CACHE_DIR = expandHome(
  envOr("PROFILE_CACHE_DIR", "~/.cloud-browser/profiles"),
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

export const R2 = SKIP_R2
  ? null
  : {
      bucket: envOrThrow("R2_BUCKET"),
      accountId: envOrThrow("R2_ACCOUNT_ID"),
      accessKeyId: envOrThrow("R2_ACCESS_KEY_ID"),
      secretAccessKey: envOrThrow("R2_SECRET_ACCESS_KEY"),
      get endpoint() {
        return `https://${this.accountId}.r2.cloudflarestorage.com`;
      },
    };

// Tagged on every container we spawn so we can find/clean up orphans.
export const CONTAINER_LABEL = "cloud-browser.managed=true";
export const CONTAINER_PROFILE_LABEL = "cloud-browser.profile";
