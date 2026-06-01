// Route helpers for the app.
// One canonical page per workspace; modes are driven by query params:
//   ?dir=<folder>       — current folder in the artifact list
//   ?artifact=<path>    — expanded file in the artifact column
//   ?chat=<sessionId>   — expanded session in the sessions column
//   ?split=<0.1..0.9>   — artifact column fraction when both are expanded
//
// Maps to:
//   /                                    → Welcome
//   /workspace/[...path]                 → Workspace page
//
// The legacy /file/[...path], /dir/[...path] and /session/[id] segments are
// preserved as redirect-only pages so old deep links still resolve.

export interface WorkspaceParams {
  dir?: string;
  artifact?: string;
  chat?: string;
  split?: number;
}

export function buildWorkspaceQuery(p: WorkspaceParams): string {
  const sp = new URLSearchParams();
  if (p.dir) sp.set("dir", p.dir);
  if (p.artifact) sp.set("artifact", p.artifact);
  if (p.chat) sp.set("chat", p.chat);
  if (typeof p.split === "number") sp.set("split", p.split.toFixed(3));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// Encode a workspace slug-chain as a URL path segment. Each slug is
// URL-encoded individually, then joined with `/` — so the route looks like
// `/workspace/HR/pay-contractors` and natural-text slugs with spaces or
// accents round-trip correctly.
export function encodeWorkspacePath(slugPath: string[]): string {
  return slugPath.map(encodeURIComponent).join("/");
}

export function decodeWorkspacePath(encoded: string): string[] {
  if (!encoded) return [];
  return encoded.split("/").filter(Boolean).map(decodeURIComponent);
}

export function workspaceRoute(slugPath: string[], params: WorkspaceParams = {}) {
  return `/workspace/${encodeWorkspacePath(slugPath)}${buildWorkspaceQuery(params)}`;
}

export function workspaceDirRoute(slugPath: string[], dirPath: string) {
  return workspaceRoute(slugPath, { dir: dirPath });
}

export function workspaceFileRoute(slugPath: string[], filePath: string) {
  return workspaceRoute(slugPath, { artifact: filePath });
}

export function workspaceSessionRoute(slugPath: string[], sessionId: string) {
  return workspaceRoute(slugPath, { chat: sessionId });
}

// Workspace state persistence — remembers last visited path for each workspace.
const WORKSPACE_STATE_KEY = "wb-workspace-state";

interface WorkspaceState {
  [workspaceKey: string]: string; // Maps slash-joined path to the last visited URL path
}

function workspaceKey(slugPath: string[]): string {
  return slugPath.join("/");
}

export function saveWorkspacePath(slugPath: string[], path: string): void {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(WORKSPACE_STATE_KEY);
    const state: WorkspaceState = raw ? JSON.parse(raw) : {};
    state[workspaceKey(slugPath)] = path;
    localStorage.setItem(WORKSPACE_STATE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

export function getSavedWorkspacePath(slugPath: string[]): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(WORKSPACE_STATE_KEY);
    if (!raw) return null;
    const state: WorkspaceState = JSON.parse(raw);
    return state[workspaceKey(slugPath)] || null;
  } catch { return null; }
}

export function getWorkspaceRestoreRoute(slugPath: string[]): string {
  const savedPath = getSavedWorkspacePath(slugPath);
  if (savedPath) return savedPath;
  return workspaceRoute(slugPath);
}
