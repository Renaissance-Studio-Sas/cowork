"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { WorkspaceDTO, SessionSummaryDTO } from "./types";

interface WorkspaceContextValue {
  // Tree of top-level workspaces; each carries its full nested `children` tree.
  workspaces: WorkspaceDTO[];
  sessions: SessionSummaryDTO[];
  pendingCount: number;
  refresh: () => Promise<void>;
}

// A session is "pending" — needs user attention — when it isn't actively
// working and hasn't been marked complete. That covers awaiting_input, idle,
// stopped, and "running but parked on a permission/question/completion card."
// "error" gets its own treatment.
export function isPending(s: SessionSummaryDTO): boolean {
  if (s.completed) return false;
  if (s.state === "error") return false;
  if (s.state === "running" && !s.hasPendingPrompt) return false;
  return true;
}

// Walk the workspace tree and yield every workspace, flattened. Useful for
// look-ups that need to find a workspace anywhere in the tree by slug-chain.
export function flattenWorkspaces(tree: WorkspaceDTO[]): WorkspaceDTO[] {
  const out: WorkspaceDTO[] = [];
  const walk = (list: WorkspaceDTO[]) => {
    for (const ws of list) {
      out.push(ws);
      if (ws.children.length > 0) walk(ws.children);
    }
  };
  walk(tree);
  return out;
}

// Find a workspace by its slug-chain. Returns null when no workspace matches.
export function findWorkspace(tree: WorkspaceDTO[], path: string[]): WorkspaceDTO | null {
  if (path.length === 0) return null;
  let list = tree;
  let found: WorkspaceDTO | null = null;
  for (const slug of path) {
    const next = list.find((ws) => ws.slug === slug);
    if (!next) return null;
    found = next;
    list = next.children;
  }
  return found;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceDTO[]>([]);
  const [sessions, setSessions] = useState<SessionSummaryDTO[]>([]);

  const refresh = useCallback(async () => {
    const [w, s] = await Promise.all([
      fetch("/api/workspace", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/sessions", { cache: "no-store" }).then((r) => r.json()),
    ]);
    setWorkspaces(w.workspaces ?? []);
    setSessions(s.sessions ?? []);
  }, []);

  useEffect(() => {
    // Initial fetch + 2.5s poll of workspace/session state. refresh() setting
    // state from the effect is the intended data-fetch-on-mount pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch + poll
    refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [refresh]);

  const pendingCount = useMemo(
    () => sessions.filter(isPending).length,
    [sessions],
  );

  const value = useMemo(
    () => ({ workspaces, sessions, pendingCount, refresh }),
    [workspaces, sessions, pendingCount, refresh],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

const defaultContext: WorkspaceContextValue = {
  workspaces: [],
  sessions: [],
  pendingCount: 0,
  refresh: async () => {},
};

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  // Return a safe default if not inside provider (e.g., during prerendering)
  return ctx ?? defaultContext;
}
