// Reads the platform session cookie from ~/.rw/credentials.json so we can
// authenticate calls into the gateway (POST /api/browser/sessions and the
// CDP / noVNC WebSocket connections that follow).

import fs from "node:fs";
import { GATEWAY_URL, RW_CREDS_FILE } from "./config.js";

interface RwCredentials {
  envs: Record<string, { gateway: string; cookie: string; email?: string }>;
}

interface ResolvedCreds {
  gateway: string;
  cookie: string;
  email: string;
  username: string;
}

let cached: ResolvedCreds | null = null;

export function loadCreds(): ResolvedCreds {
  if (cached) return cached;
  let raw: string;
  try {
    raw = fs.readFileSync(RW_CREDS_FILE, "utf8");
  } catch {
    throw new Error(
      `cloud-browser: rw credentials not found at ${RW_CREDS_FILE}. Run \`rw auth login\` first.`,
    );
  }
  const parsed = JSON.parse(raw) as RwCredentials;
  const env = parsed.envs?.production;
  if (!env?.cookie) {
    throw new Error(
      `cloud-browser: production credentials missing in ${RW_CREDS_FILE}. Run \`rw auth login\`.`,
    );
  }
  if (!env.email) {
    throw new Error(
      `cloud-browser: credentials file ${RW_CREDS_FILE} has no email. Re-run \`rw auth login\`.`,
    );
  }
  cached = {
    gateway: env.gateway || GATEWAY_URL,
    cookie: env.cookie,
    email: env.email,
    username: env.email.split("@")[0]!.toLowerCase(),
  };
  return cached;
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Cookie: `__gateway_session=${loadCreds().cookie}`, ...extra };
}
