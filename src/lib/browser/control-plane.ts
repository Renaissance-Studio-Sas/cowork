// Typed client for the browser-control-plane REST API (default :4001).
// The control plane spawns one Steel browser container per session, each
// mounting a named, reusable Chrome profile (persistent cookies/logins).
// We only talk to its REST API here; CDP driving lives in playwright-manager.ts.

// Compose mode serves steelyard's API (and UI) on host :4000.
const BASE_URL = (process.env.BROWSER_CONTROL_PLANE_URL ?? "http://localhost:4000").replace(/\/$/, "");

export interface CpProfile {
  name: string;
  description: string | null;
  notes: string | null;
  created_at: string;
  last_used_at: string | null;
  liveSessionId: string | null;
}

export interface CpSessionView {
  id: string;
  container_id: string;
  profile_name: string;
  api_port: number;
  cdp_port: number;
  ui_port: number | null;
  status: "starting" | "live" | "stopped" | "error";
  created_at: string;
  last_used_at: string;
  urls: {
    steelApi: string;
    cdp: string;
    viewer: string;
    steelUi: string | null;
  };
}

export class ControlPlaneError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ControlPlaneError";
    this.status = status;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (e) {
    throw new ControlPlaneError(
      `Cannot reach browser-control-plane at ${BASE_URL}. Is it running (npm run start in browser-control-plane) and is Docker up? (${e instanceof Error ? e.message : String(e)})`,
      0,
    );
  }
  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!res.ok) {
    const msg = (body && typeof body === "object" && "error" in body)
      ? String((body as { error: unknown }).error)
      : `HTTP ${res.status}`;
    throw new ControlPlaneError(msg, res.status);
  }
  return body as T;
}

export async function isControlPlaneUp(): Promise<boolean> {
  try {
    const r = await req<{ ok: boolean }>("/health");
    return !!r.ok;
  } catch {
    return false;
  }
}

export function listProfiles(): Promise<CpProfile[]> {
  return req<CpProfile[]>("/profiles");
}

export function createProfile(name: string, description?: string, notes?: string): Promise<CpProfile> {
  return req<CpProfile>("/profiles", {
    method: "POST",
    body: JSON.stringify({ name, description, notes }),
  });
}

export function listSessions(): Promise<CpSessionView[]> {
  return req<CpSessionView[]>("/sessions");
}

// Acquire (or reuse) a live session for a profile. ~3-5s on cold spawn.
// The profile is auto-created if it doesn't exist.
export function acquireSession(profile: string): Promise<CpSessionView> {
  return req<CpSessionView>("/sessions", {
    method: "POST",
    body: JSON.stringify({ profile }),
  });
}

// Fetch a session. Side effect on the control plane: resets the idle clock.
export function getSession(id: string): Promise<CpSessionView> {
  return req<CpSessionView>(`/sessions/${encodeURIComponent(id)}`);
}

// Touch the idle clock without caring about the result (best-effort).
export async function touchSession(id: string): Promise<void> {
  try { await getSession(id); } catch { /* ignore */ }
}

export function releaseSession(id: string): Promise<{ ok: boolean }> {
  return req<{ ok: boolean }>(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function openTab(id: string, url?: string): Promise<{ ok: boolean; tab: unknown }> {
  return req<{ ok: boolean; tab: unknown }>(`/sessions/${encodeURIComponent(id)}/tabs`, {
    method: "POST",
    body: JSON.stringify(url ? { url } : {}),
  });
}

export function controlPlaneUiUrl(): string {
  return process.env.BROWSER_UI_URL ?? "http://localhost:4000";
}
