"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ProjectDTO, SessionSummaryDTO } from "./types";

interface WorkspaceContextValue {
  projects: ProjectDTO[];
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

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<ProjectDTO[]>([]);
  const [sessions, setSessions] = useState<SessionSummaryDTO[]>([]);

  const refresh = useCallback(async () => {
    const [w, s] = await Promise.all([
      fetch("/api/workspace", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/sessions", { cache: "no-store" }).then((r) => r.json()),
    ]);
    setProjects(w.projects);
    setSessions(s.sessions);
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
    () => ({ projects, sessions, pendingCount, refresh }),
    [projects, sessions, pendingCount, refresh],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

const defaultContext: WorkspaceContextValue = {
  projects: [],
  sessions: [],
  pendingCount: 0,
  refresh: async () => {},
};

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  // Return a safe default if not inside provider (e.g., during prerendering)
  return ctx ?? defaultContext;
}
