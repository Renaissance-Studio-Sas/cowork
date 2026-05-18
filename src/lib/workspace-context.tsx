"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ProjectDTO, SessionSummaryDTO } from "./types";

interface WorkspaceContextValue {
  projects: ProjectDTO[];
  sessions: SessionSummaryDTO[];
  awaitingCount: number;
  refresh: () => Promise<void>;
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
    refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [refresh]);

  const awaitingCount = useMemo(
    () => sessions.filter((s) => s.state === "awaiting_input").length,
    [sessions],
  );

  const value = useMemo(
    () => ({ projects, sessions, awaitingCount, refresh }),
    [projects, sessions, awaitingCount, refresh],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

const defaultContext: WorkspaceContextValue = {
  projects: [],
  sessions: [],
  awaitingCount: 0,
  refresh: async () => {},
};

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  // Return a safe default if not inside provider (e.g., during prerendering)
  return ctx ?? defaultContext;
}
