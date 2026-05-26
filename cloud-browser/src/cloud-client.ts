// HTTP client for the remote cloud-browser worker
// (monorepo/infra/workers/cloud-browser). Replaces the previous local-Docker
// path — the MCP daemon stays on the host, but the actual Chrome container
// runs on Cloudflare and we drive it over CDP through the gateway.
//
// Surface:
//   createSession(profile?)  → { sessionId, cdpWsEndpoint, novncUrl }
//   terminateSession(id)     → fire-and-forget DELETE
//
// `cdpWsEndpoint` is a wss:// URL already rewritten to go through the
// gateway, so the caller just hands it to playwright's
// `chromium.connectOverCDP({ wsEndpoint, headers: authHeaders() })`.

import { authHeaders, loadCreds } from "./auth.js";
import { log } from "./log.js";

export interface RemoteSession {
  sessionId: string;
  /** wss://app.rowads.studio/api/browser/sessions/<id>/cdp/devtools/browser/<deviceId> */
  cdpWsEndpoint: string;
  /** https://app.rowads.studio/api/browser/sessions/<id>/novnc/embed.html */
  novncUrl: string;
}

interface CreateResponse {
  sessionId: string;
  profile: string | null;
  createdAt: number;
  novncUrl: string;
  cdpUrl: string;
}

interface CdpVersionResponse {
  webSocketDebuggerUrl: string;
}

async function explain(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (res.status === 401 || res.status === 403) {
    return `${res.status} ${res.statusText} — gateway rejected the session cookie. Run \`rw auth login\` to refresh. ${text}`;
  }
  return `${res.status} ${res.statusText}${text ? `: ${text.slice(0, 400)}` : ""}`;
}

export async function createSession(profile: string | null): Promise<RemoteSession> {
  const creds = loadCreds();
  const createRes = await fetch(`${creds.gateway}/api/browser/sessions`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(profile ? { profile } : {}),
  });
  if (!createRes.ok) throw new Error(`createSession: ${await explain(createRes)}`);
  const created = (await createRes.json()) as CreateResponse;

  // Discover the WebSocket path Chrome wants. /json/version returns something
  // like `ws://localhost/devtools/browser/<deviceId>` because the DO proxies
  // requests with Host=localhost (Chrome's DNS-rebind guard).
  const verRes = await fetch(`${creds.gateway}${created.cdpUrl}json/version`, {
    headers: authHeaders(),
  });
  if (!verRes.ok) throw new Error(`getCdpVersion: ${await explain(verRes)}`);
  const ver = (await verRes.json()) as CdpVersionResponse;

  const wsPath = ver.webSocketDebuggerUrl.replace(/^wss?:\/\/[^/]+/, "");
  // created.cdpUrl ends with "/", wsPath starts with "/devtools/...".
  // Join without double-slash: drop wsPath's leading slash.
  const gatewayWsBase = creds.gateway.replace(/^https?/, (m) => (m === "https" ? "wss" : "ws"));
  const cdpWsEndpoint = `${gatewayWsBase}${created.cdpUrl}${wsPath.replace(/^\//, "")}`;

  // Build a stable noVNC URL pointing at the minimal embed.html (no control
  // bar). The artifact iframe loads this; the user's browser already has the
  // gateway cookie set, so auth flows automatically.
  const novncUrl = `${creds.gateway}/api/browser/sessions/${created.sessionId}/novnc/embed.html`;

  log.info("remote session created", { sessionId: created.sessionId, profile });
  return {
    sessionId: created.sessionId,
    cdpWsEndpoint,
    novncUrl,
  };
}

export async function terminateSession(sessionId: string): Promise<void> {
  const creds = loadCreds();
  try {
    const res = await fetch(`${creds.gateway}/api/browser/sessions/${sessionId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) {
      log.debug("terminate non-OK (continuing)", {
        sessionId,
        status: res.status,
        body: (await res.text().catch(() => "")).slice(0, 200),
      });
    }
  } catch (e) {
    log.debug("terminate error (continuing)", { sessionId, err: String(e) });
  }
}
