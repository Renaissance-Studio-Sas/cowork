"use client";

import { useState, useEffect, Suspense, type ReactNode } from "react";
import { useRouter } from "@/lib/navigation";
import { SidebarNav } from "./SidebarNav";
import { NewProjectModal, NewTaskModal } from "./NewModal";
import { useWorkspace } from "@/lib/workspace-context";
import { projectRoute, taskRoute } from "@/lib/routes";

interface Props {
  children: ReactNode;
}

export function AppShell({ children }: Props) {
  const router = useRouter();
  const { pendingCount, refresh } = useWorkspace();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [newTaskFor, setNewTaskFor] = useState<string | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);

  // Read the persisted sidebar state on mount. Has to run in an effect rather
  // than a lazy initializer: localStorage is unavailable during SSR, and
  // seeding from it during render would cause a hydration mismatch.
  useEffect(() => {
    const stored = localStorage.getItem("wb-sidebar-open");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only localStorage hydration
    if (stored !== null) setSidebarOpen(stored === "1");
  }, []);

  useEffect(() => {
    localStorage.setItem("wb-sidebar-open", sidebarOpen ? "1" : "0");
  }, [sidebarOpen]);

  return (
    <div className="h-screen flex bg-[var(--bg)] text-[var(--text)]">
      {sidebarOpen ? (
        // SidebarNav reads useSearchParams(); a Suspense boundary keeps static
        // prerender (e.g. /_not-found) from bailing out of the whole route.
        // Fallback matches the sidebar's w-[300px] to avoid layout shift.
        <Suspense fallback={<aside className="w-[300px] shrink-0 bg-[var(--bg-2)] border-r border-[var(--border)]" />}>
          <SidebarNav
            onNewTask={(project) => setNewTaskFor(project)}
            onNewProject={() => setShowNewProject(true)}
            onClose={() => setSidebarOpen(false)}
          />
        </Suspense>
      ) : (
        <FoldedRail onExpand={() => setSidebarOpen(true)} pendingCount={pendingCount} />
      )}

      <main className="flex-1 min-w-0 flex flex-col bg-[var(--bg)] relative">
        {children}
      </main>

      {newTaskFor && (
        <NewTaskModal
          projectSlug={newTaskFor}
          onClose={() => setNewTaskFor(null)}
          onCreated={(slug) => {
            setNewTaskFor(null);
            router.push(taskRoute(newTaskFor, slug));
            refresh();
          }}
        />
      )}
      {showNewProject && (
        <NewProjectModal
          onClose={() => setShowNewProject(false)}
          onCreated={(slug) => {
            setShowNewProject(false);
            router.push(projectRoute(slug));
            refresh();
          }}
        />
      )}
    </div>
  );
}

function FoldedRail({ onExpand, pendingCount }: { onExpand: () => void; pendingCount: number }) {
  return (
    <aside className="w-12 shrink-0 bg-[var(--bg-2)] border-r border-[var(--border)] flex flex-col items-center pt-3 gap-3">
      <button
        onClick={onExpand}
        className="w-9 h-9 rounded-md hover:bg-[var(--panel)] flex items-center justify-center text-[var(--text)]"
        title="Show menu"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <line x1="4" y1="6" x2="20" y2="6" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="18" x2="20" y2="18" />
        </svg>
      </button>
      {pendingCount > 0 && (
        <span className="pulse text-[10.5px] text-[var(--warn)] font-medium" title={`${pendingCount} pending`}>
          ●{pendingCount}
        </span>
      )}
    </aside>
  );
}
