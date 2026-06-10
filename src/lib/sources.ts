// Workspace sources. Cowork resolves workspaces from two roots:
//   • "local" — <WORKSPACE_ROOT>/workspaces/ (the user's repo/folder)
//   • "cloud" — a separate directory (default ~/Documents/Cowork/Cloud)
//
// A workspace's identity everywhere (URLs, session meta, API routes) is its
// slug-chain `path: string[]`. To carry the source in that identity without a
// migration, cloud workspaces get a reserved first segment `@cloud`; local
// workspaces keep their bare paths unchanged. The sentinel is only interpreted
// at the filesystem boundary (src/lib/fs.ts) and for the agent cwd
// (src/lib/sessions.ts) — every path-based route, URL helper, and the session
// meta shape just carry one extra segment transparently.
//
// This module is client-safe (no Node imports) so both the server (fs.ts) and
// the client (SidebarNav.tsx) can share the constant.

export type WorkspaceSource = "local" | "cloud";

// Reserved first path segment marking a workspace as living in the cloud root.
// Chosen with a leading `@` so it can't collide with a real local top-level
// slug (sanitizeName in fs.ts also strips/reserves it defensively).
export const CLOUD_PREFIX = "@cloud";

// Which source a workspace slug-chain belongs to.
export function sourceOf(path: string[]): WorkspaceSource {
  return path[0] === CLOUD_PREFIX ? "cloud" : "local";
}
