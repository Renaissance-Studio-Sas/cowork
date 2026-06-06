"use client";

import { Link, usePathname, useRouter, useSearchParams } from "@/lib/navigation";
import { useEffect, useState } from "react";
import type { SessionSummaryDTO, WorkspaceDTO } from "@/lib/types";
import { isPending, useWorkspace } from "@/lib/workspace-context";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { WorkingIndicator } from "./WorkingIndicator";
import {
  decodeWorkspacePath,
  encodeWorkspacePath,
  getWorkspaceRestoreRoute,
  workspaceSessionRoute,
} from "@/lib/routes";

const COLLAPSED_KEY = "wb-workspaces-collapsed";
const RECENT_COLLAPSED_KEY = "wb-recent-sessions-collapsed";
const BACKLOG_COLLAPSED_KEY = "wb-backlog-sessions-collapsed";
const ROOT_COLLAPSED_KEY = "wb-workspaces-section-collapsed";

// Key a workspace's collapsed-state in localStorage by its full slug-chain so
// every node in the tree (top-level or nested) gets a unique entry.
function pathKey(path: string[]): string { return path.join("/"); }

function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, boolean>;
  } catch { return {}; }
}

interface Props {
  /** Open the "new workspace" modal targeting this parent (empty for root). */
  onNewWorkspace: (parentPath: string[]) => void;
  onClose: () => void;
}

export function SidebarNav({ onNewWorkspace, onClose }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedChatId = searchParams.get("chat") ?? "";
  const { workspaces, sessions, pendingCount, refresh } = useWorkspace();

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [recentCollapsed, setRecentCollapsed] = useState(false);
  // Backlog section defaults to collapsed — it's a parked-work list, not the
  // top-of-mind one, so it stays out of the way until the user expands it.
  const [backlogCollapsed, setBacklogCollapsed] = useState(true);
  const [rootCollapsed, setRootCollapsed] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<{ path: string[] } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Drag-over target: the full slug-chain of the workspace currently being
  // hovered as a drop target.
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Slug-chain of the workspace identified by the current URL, if any.
  const selectedPath = parsePathname(pathname);

  // Hydrate collapsed-section state from localStorage on mount. Effect rather
  // than lazy init: localStorage is SSR-unavailable and seeding during render
  // would mismatch hydration.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only localStorage hydration
    setCollapsed(loadCollapsed());
    try {
      setRecentCollapsed(localStorage.getItem(RECENT_COLLAPSED_KEY) === "true");
      // Default-collapsed: only expand if the user previously expanded it.
      setBacklogCollapsed(localStorage.getItem(BACKLOG_COLLAPSED_KEY) !== "false");
      setRootCollapsed(localStorage.getItem(ROOT_COLLAPSED_KEY) === "true");
    } catch { /* ignore */ }
  }, []);

  const updateCollapsed = (path: string[], value: boolean) => {
    const key = pathKey(path);
    setCollapsed((prev) => {
      const next = { ...prev, [key]: value };
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const updateRecentCollapsed = (value: boolean) => {
    setRecentCollapsed(value);
    try { localStorage.setItem(RECENT_COLLAPSED_KEY, String(value)); } catch { /* ignore */ }
  };

  const updateBacklogCollapsed = (value: boolean) => {
    setBacklogCollapsed(value);
    try { localStorage.setItem(BACKLOG_COLLAPSED_KEY, String(value)); } catch { /* ignore */ }
  };

  const updateRootCollapsed = (value: boolean) => {
    setRootCollapsed(value);
    try { localStorage.setItem(ROOT_COLLAPSED_KEY, String(value)); } catch { /* ignore */ }
  };

  const visibleWorkspaces = [...workspaces].sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return a.slug.localeCompare(b.slug);
  });

  // Session counts for a workspace by its slug-chain. Looks at every session
  // whose workspacePath matches this chain exactly (no descendants).
  const sessionsAt = (path: string[]): SessionSummaryDTO[] => {
    const key = pathKey(path);
    return sessions.filter((s) => pathKey(s.workspacePath) === key);
  };

  // Counts aggregated across this workspace AND every descendant — used for
  // the parent's pending/working pill.
  const sessionsAtOrUnder = (path: string[]): SessionSummaryDTO[] => {
    const prefix = pathKey(path);
    return sessions.filter((s) => {
      const sp = pathKey(s.workspacePath);
      return sp === prefix || sp.startsWith(prefix + "/");
    });
  };

  // Get the 10 most recent active sessions sorted by lastActivity.
  // Completed sessions are deliberately excluded — once the user (or agent +
  // approval) marks a session done, it falls out of the top-of-mind list.
  // Backlog sessions are excluded too — they live in their own list below.
  const activeSessions = [...sessions]
    .filter((s) => !s.completed && !s.backlog)
    .sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1))
    .slice(0, 10);

  // Sessions parked on an external dependency. Shown in a separate, foldable
  // "Backlog" list below the active one. Completed sessions never appear here —
  // a finished session isn't waiting on anything.
  const backlogSessions = [...sessions]
    .filter((s) => s.backlog && !s.completed)
    .sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));

  const startRename = (path: string[]) => {
    setRenaming({ path });
    setRenameValue(path[path.length - 1] ?? "");
  };

  const commitRename = async () => {
    if (!renaming) return;
    const target = renaming;
    setRenaming(null);
    const newSlug = renameValue.trim();
    if (!newSlug) return;
    const currentSlug = target.path[target.path.length - 1];
    if (newSlug === currentSlug) return;
    const r = await fetch(
      `/api/workspaces/rename/${encodeWorkspacePath(target.path)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newSlug }),
      },
    );
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(j.error ?? "rename failed");
    }
    refresh();
  };

  const deleteWorkspace = async (path: string[]) => {
    const slug = path[path.length - 1];
    if (!confirm(`Delete workspace "${slug}" and everything in it?`)) return;
    const r = await fetch(`/api/workspaces/${encodeWorkspacePath(path)}`, { method: "DELETE" });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(j.error ?? "delete failed");
      return;
    }
    refresh();
  };

  const markAllAsRead = async (path: string[]) => {
    const key = pathKey(path);
    const unreadSessions = sessions.filter((s) => pathKey(s.workspacePath) === key && s.unread);
    if (unreadSessions.length === 0) return;
    await Promise.all(
      unreadSessions.map((s) =>
        fetch(`/api/sessions/${s.id}/seen`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace: path }),
        })
      )
    );
    refresh();
  };

  const markAllAsCompleted = async (path: string[]) => {
    const key = pathKey(path);
    const openSessions = sessions.filter((s) => pathKey(s.workspacePath) === key && !s.completed);
    if (openSessions.length === 0) return;
    await Promise.all(
      openSessions.map((s) =>
        fetch(`/api/sessions/${s.id}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace: path, completed: true }),
        })
      )
    );
    refresh();
  };

  // Move a workspace under a new parent (or `[]` for the root). Backend route:
  // POST /api/workspaces/move/<from-chain>  body: { toParentPath }
  const moveWorkspaceTo = async (fromPath: string[], toParentPath: string[]) => {
    const fromKey = pathKey(fromPath);
    const toKey = pathKey(toParentPath);
    if (fromKey === toKey) return; // moving onto self
    // Refuse to move a workspace under one of its own descendants — the server
    // would 400, but bail early so the alert doesn't trigger.
    if ((toKey + "/").startsWith(fromKey + "/")) return;
    const r = await fetch(
      `/api/workspaces/move/${encodeWorkspacePath(fromPath)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toParentPath }),
      },
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { alert(j.error ?? "move failed"); return; }
    refresh();
  };

  const toggleSessionBacklog = async (s: SessionSummaryDTO, backlog: boolean) => {
    await fetch(`/api/sessions/${s.id}/backlog`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: s.workspacePath, backlog }),
    });
    refresh();
  };

  const toggleSessionCompleted = async (s: SessionSummaryDTO, completed: boolean) => {
    await fetch(`/api/sessions/${s.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: s.workspacePath, completed }),
    });
    refresh();
  };

  const deleteSession = async (s: SessionSummaryDTO) => {
    if (!confirm(`Delete session "${s.title || "Untitled"}"?`)) return;
    const r = await fetch(`/api/sessions/${s.id}/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: s.workspacePath }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(j.error ?? "delete failed");
      return;
    }
    refresh();
  };

  const openSessionMenu = (e: React.MouseEvent, s: SessionSummaryDTO) => {
    e.preventDefault();
    // A running/awaiting session can't be deleted (the server refuses it).
    const isRunning = s.state === "running" || s.state === "awaiting_input";
    const items: MenuItem[] = [
      {
        label: s.completed ? "Reopen" : "Mark complete",
        onClick: () => toggleSessionCompleted(s, !s.completed),
      },
      {
        label: s.backlog ? "Move to active" : "Move to backlog",
        onClick: () => toggleSessionBacklog(s, !s.backlog),
      },
      { label: "Delete", danger: true, onClick: () => deleteSession(s), disabled: isRunning },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const openWorkspaceMenu = (e: React.MouseEvent, path: string[]) => {
    e.preventDefault();
    const key = pathKey(path);
    const ws = sessions.filter((s) => pathKey(s.workspacePath) === key);
    const unreadCount = ws.filter((s) => s.unread).length;
    const openCount = ws.filter((s) => !s.completed).length;
    const items: MenuItem[] = [
      { label: "Rename  ↵", onClick: () => startRename(path) },
      {
        label: unreadCount > 0 ? `Mark all as read (${unreadCount})` : "Mark all as read",
        onClick: () => markAllAsRead(path),
        disabled: unreadCount === 0,
      },
      {
        label: openCount > 0 ? `Mark all as completed (${openCount})` : "Mark all as completed",
        onClick: () => markAllAsCompleted(path),
        disabled: openCount === 0,
      },
      { label: "Delete", danger: true, onClick: () => deleteWorkspace(path) },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // Enter on a selected workspace → start renaming. Skip when typing in an
  // input or when a modal/menu is already up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (renaming || menu) return;
      if (selectedPath.length > 0) {
        e.preventDefault();
        startRename(selectedPath);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedPath, renaming, menu]);

  return (
    <aside className="w-[300px] shrink-0 bg-[var(--bg-2)] border-r border-[var(--border)] flex flex-col">
      <div className="px-4 pt-5 pb-3 flex items-start gap-2">
        <Link href="/" className="flex-1 min-w-0 flex items-center gap-2.5">
          {/* The hex-cluster mark from /icon.svg — same asset as the favicon. */}
          <img src="/icon.svg" width="32" height="32" alt="" aria-hidden="true" className="shrink-0" />
          <div className="min-w-0">
            <div className="text-[15px] font-semibold leading-tight">Cowork</div>
            <div className="text-[12.5px] text-[var(--muted)] leading-snug mt-0.5">where humans and AI collaborate</div>
          </div>
        </Link>
        <button
          onClick={onClose}
          className="text-[var(--muted)] hover:text-[var(--text)] w-7 h-7 rounded-md hover:bg-[var(--panel)] flex items-center justify-center"
          title="Hide menu"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4 pt-1">
        {/* Active Sessions */}
        {activeSessions.length > 0 && (
          <div className="mb-3">
            <div className="flex items-center gap-1 px-1 py-1.5">
              <button
                onClick={() => updateRecentCollapsed(!recentCollapsed)}
                className="w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--panel)] shrink-0"
                title={recentCollapsed ? "Expand" : "Collapse"}
              >
                <svg
                  width="18" height="18" viewBox="0 0 24 24"
                  className={`text-[var(--muted)] transition-transform ${recentCollapsed ? "" : "rotate-90"}`}
                  fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden
                ><path d="M9 6l6 6-6 6" /></svg>
              </button>
              <span className="text-[11px] uppercase tracking-wider font-semibold text-[var(--muted)]">
                Active Sessions
              </span>
            </div>
            {!recentCollapsed && (
              <div className="space-y-0.5">
                {activeSessions.map((s) => (
                  <RecentSessionRow
                    key={s.id}
                    session={s}
                    selected={selectedChatId === s.id}
                    onContextMenu={openSessionMenu}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Backlog Sessions — parked on an external dependency. Foldable, and
            hidden entirely when nothing is in the backlog. */}
        {backlogSessions.length > 0 && (
          <div className="mb-3">
            <div className="flex items-center gap-1 px-1 py-1.5">
              <button
                onClick={() => updateBacklogCollapsed(!backlogCollapsed)}
                className="w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--panel)] shrink-0"
                title={backlogCollapsed ? "Expand" : "Collapse"}
              >
                <svg
                  width="18" height="18" viewBox="0 0 24 24"
                  className={`text-[var(--muted)] transition-transform ${backlogCollapsed ? "" : "rotate-90"}`}
                  fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden
                ><path d="M9 6l6 6-6 6" /></svg>
              </button>
              <span className="flex-1 text-[11px] uppercase tracking-wider font-semibold text-[var(--muted)]">
                Backlog
              </span>
              <span className="text-[10px] text-[var(--muted)] shrink-0" title={`${backlogSessions.length} in backlog`}>
                {backlogSessions.length}
              </span>
            </div>
            {!backlogCollapsed && (
              <div className="space-y-0.5">
                {backlogSessions.map((s) => (
                  <RecentSessionRow
                    key={s.id}
                    session={s}
                    selected={selectedChatId === s.id}
                    onContextMenu={openSessionMenu}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Workspaces */}
        <div className="group flex items-center gap-1 px-1 py-1.5">
          <button
            onClick={() => updateRootCollapsed(!rootCollapsed)}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--panel)] shrink-0"
            title={rootCollapsed ? "Expand" : "Collapse"}
          >
            <svg
              width="18" height="18" viewBox="0 0 24 24"
              className={`text-[var(--muted)] transition-transform ${rootCollapsed ? "" : "rotate-90"}`}
              fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden
            ><path d="M9 6l6 6-6 6" /></svg>
          </button>
          <span className="flex-1 text-[11px] uppercase tracking-wider font-semibold text-[var(--muted)]">
            Workspaces
          </span>
          {pendingCount > 0 && (
            <span className="text-[10px] text-[var(--warn)] pulse whitespace-nowrap" title={`${pendingCount} pending session(s)`}>
              ●{pendingCount}
            </span>
          )}
          <span
            role="button" tabIndex={0}
            onClick={() => onNewWorkspace([])}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onNewWorkspace([]);
              }
            }}
            className="text-[var(--muted)] hover:text-[var(--text)] text-[16px] leading-none px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--panel-2)] transition cursor-pointer"
            title="New workspace"
          >+</span>
        </div>
        {!rootCollapsed && visibleWorkspaces.length === 0 && (
          <div className="px-3 py-4 text-[12.5px] text-[var(--muted)]">No workspaces yet.</div>
        )}

        {!rootCollapsed && visibleWorkspaces.map((ws) => (
          <WorkspaceNode
            key={ws.slug}
            workspace={ws}
            path={[ws.slug]}
            depth={0}
            selectedPath={selectedPath}
            collapsed={collapsed}
            renaming={renaming}
            renameValue={renameValue}
            dragOver={dragOver}
            sessionsAt={sessionsAt}
            sessionsAtOrUnder={sessionsAtOrUnder}
            onToggleCollapsed={updateCollapsed}
            onContextMenu={openWorkspaceMenu}
            onNewChild={(parentPath) => onNewWorkspace(parentPath)}
            onRenameValueChange={setRenameValue}
            onRenameCommit={commitRename}
            onRenameCancel={() => setRenaming(null)}
            onDragOverPath={setDragOver}
            onDropOnPath={moveWorkspaceTo}
          />
        ))}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  );
}

interface WorkspaceNodeProps {
  workspace: WorkspaceDTO;
  /** Full slug-chain of this node. */
  path: string[];
  depth: number;
  selectedPath: string[];
  collapsed: Record<string, boolean>;
  renaming: { path: string[] } | null;
  renameValue: string;
  dragOver: string | null;
  sessionsAt: (path: string[]) => SessionSummaryDTO[];
  sessionsAtOrUnder: (path: string[]) => SessionSummaryDTO[];
  onToggleCollapsed: (path: string[], value: boolean) => void;
  onContextMenu: (e: React.MouseEvent, path: string[]) => void;
  onNewChild: (parentPath: string[]) => void;
  onRenameValueChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onDragOverPath: (key: string | null) => void;
  onDropOnPath: (fromPath: string[], toParentPath: string[]) => void;
}

// Recursive sidebar node: header row for this workspace + nested rows for its
// children. Each level indents 12px so deep nesting reads cleanly. Drag-and-
// drop reparents a workspace under whichever node accepts the drop.
function WorkspaceNode({
  workspace, path, depth, selectedPath, collapsed, renaming, renameValue, dragOver,
  sessionsAt, sessionsAtOrUnder, onToggleCollapsed, onContextMenu, onNewChild,
  onRenameValueChange, onRenameCommit, onRenameCancel, onDragOverPath, onDropOnPath,
}: WorkspaceNodeProps) {
  const router = useRouter();
  const key = pathKey(path);
  const isCollapsed = !!collapsed[key];
  const isDragOver = dragOver === key;
  const isSelected = pathKey(selectedPath) === key;
  const isArchived = workspace.status === "archived";
  const isRenaming = renaming && pathKey(renaming.path) === key;

  // Sort active before archived, then alphabetically.
  const children = [...workspace.children].sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return a.slug.localeCompare(b.slug);
  });

  const ownCounts = sessionsAt(path);
  const unread = ownCounts.filter((s) => s.unread).length;
  const subtreeCounts = sessionsAtOrUnder(path);
  const pending = subtreeCounts.filter(isPending).length;
  const running = subtreeCounts.filter((s) => s.state === "running" && !s.hasPendingPrompt).length;

  const hasUnreadInSubtree = subtreeCounts.some((s) => s.unread);

  const handleNavigate = (e: React.MouseEvent | React.KeyboardEvent) => {
    if (isRenaming) return;
    if ("preventDefault" in e) e.preventDefault();
    const target = getWorkspaceRestoreRoute(path);
    router.push(target);
  };

  return (
    <div className="mb-1">
      <div
        onContextMenu={(e) => onContextMenu(e, path)}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; onDragOverPath(key); }}
        onDragLeave={() => onDragOverPath(null)}
        onDrop={(e) => {
          e.preventDefault();
          onDragOverPath(null);
          const data = e.dataTransfer.getData("application/x-wb-workspace");
          if (!data) return;
          try {
            const from = JSON.parse(data) as { path: string[] };
            if (Array.isArray(from.path) && from.path.length > 0) {
              onDropOnPath(from.path, path);
              onToggleCollapsed(path, false);
            }
          } catch { /* ignore */ }
        }}
        style={{ paddingLeft: depth * 12 }}
        className={`w-full flex items-center gap-1 px-1 py-1.5 rounded-md group transition cursor-pointer ${isDragOver ? "bg-[var(--accent-soft)] ring-2 ring-[var(--accent)]" : ""} ${isSelected ? "bg-[var(--panel-2)]" : "hover:bg-[var(--panel)]"}`}
        draggable={!isRenaming}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(
            "application/x-wb-workspace",
            JSON.stringify({ path }),
          );
        }}
      >
        <button
          onClick={(e) => { e.stopPropagation(); onToggleCollapsed(path, !isCollapsed); }}
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-[var(--panel-2)] shrink-0"
          title={isCollapsed ? "Expand" : "Collapse"}
          aria-label={isCollapsed ? "Expand" : "Collapse"}
        >
          {children.length > 0 ? (
            <svg
              width="12" height="12" viewBox="0 0 24 24"
              className={`text-[var(--text)] transition-transform ${isCollapsed ? "" : "rotate-90"}`}
              fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden
            ><path d="M9 6l6 6-6 6" /></svg>
          ) : (
            <span className="block w-1.5 h-1.5 rounded-full bg-[var(--border-strong)]" />
          )}
        </button>
        {isRenaming ? (
          <input
            autoFocus
            value={renameValue}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onRenameValueChange(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") onRenameCommit();
              else if (e.key === "Escape") onRenameCancel();
            }}
            onBlur={onRenameCommit}
            className="flex-1 bg-transparent border-b border-[var(--accent)] outline-none text-[13.5px]"
          />
        ) : (
          <button
            onClick={handleNavigate}
            onKeyDown={(e) => { if (e.key === "Enter") handleNavigate(e); }}
            className={`flex-1 text-left text-[13.5px] truncate px-1 ${isArchived ? "text-[var(--muted)] line-through" : hasUnreadInSubtree ? "font-semibold" : "text-[var(--text)]"}`}
            title={workspace.overview || workspace.slug}
          >
            {workspace.slug}
          </button>
        )}
        {unread > 0 && (
          <span className="text-[9px] bg-[var(--accent)] text-[var(--accent-text)] font-semibold rounded px-1 py-0.5 shrink-0" title={`${unread} unread`}>
            {unread}
          </span>
        )}
        {pending > 0 ? (
          <span className="pulse text-[10px] text-[var(--warn)] shrink-0" title={`${pending} pending`}>●{pending}</span>
        ) : running > 0 ? (
          <span className="text-[10px] text-[var(--accent)] shrink-0" title={`${running} working`}>●{running}</span>
        ) : null}
        <span
          role="button" tabIndex={0}
          onClick={(e) => { e.stopPropagation(); onNewChild(path); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault(); e.stopPropagation();
              onNewChild(path);
            }
          }}
          className="text-[var(--muted)] hover:text-[var(--text)] text-[16px] leading-none px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--panel-2)] transition shrink-0"
          title="New child workspace"
        >+</span>
      </div>

      {!isCollapsed && children.length > 0 && (
        <div className="space-y-0.5 mt-0.5">
          {children.map((child) => (
            <WorkspaceNode
              key={child.slug}
              workspace={child}
              path={[...path, child.slug]}
              depth={depth + 1}
              selectedPath={selectedPath}
              collapsed={collapsed}
              renaming={renaming}
              renameValue={renameValue}
              dragOver={dragOver}
              sessionsAt={sessionsAt}
              sessionsAtOrUnder={sessionsAtOrUnder}
              onToggleCollapsed={onToggleCollapsed}
              onContextMenu={onContextMenu}
              onNewChild={onNewChild}
              onRenameValueChange={onRenameValueChange}
              onRenameCommit={onRenameCommit}
              onRenameCancel={onRenameCancel}
              onDragOverPath={onDragOverPath}
              onDropOnPath={onDropOnPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Pull the workspace slug-chain out of the URL. Returns `[]` for non-workspace
// pages (Welcome, redirects, etc.).
function parsePathname(pathname: string): string[] {
  const match = pathname.match(/^\/workspace\/(.*)$/);
  if (!match) return [];
  return decodeWorkspacePath(match[1] ?? "");
}

function RecentSessionRow({ session, selected, onContextMenu }: {
  session: SessionSummaryDTO;
  selected: boolean;
  onContextMenu?: (e: React.MouseEvent, s: SessionSummaryDTO) => void;
}) {
  const href = session.workspacePath.length > 0
    ? workspaceSessionRoute(session.workspacePath, session.id)
    : "/";

  // Format relative time
  const formatRelativeTime = (isoDate: string) => {
    const date = new Date(isoDate);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const stateIcon = () => {
    if (session.completed) return null;
    // Backlog sessions are intentionally parked — show a static "on hold" mark
    // rather than the pulsing "pending" dot so they don't read as needing action.
    if (session.backlog) return <span className="text-[var(--muted)]" title="Backlog">⏸</span>;
    if (session.state === "error") return <span className="text-red-500" title="Error">●</span>;
    if (session.state === "running" && !session.hasPendingPrompt) {
      return <WorkingIndicator size={11} title="Working" />;
    }
    return <span className="pulse text-[var(--warn)]" title="Pending">●</span>;
  };

  // Show the last segment of the workspace path (the leaf) as the secondary
  // label — that's the workspace the session lives in.
  const workspaceLabel = session.workspacePath.length > 0
    ? session.workspacePath[session.workspacePath.length - 1]
    : "(no workspace)";

  return (
    <Link
      href={href}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, session) : undefined}
      className={`block w-full text-left rounded-lg px-3 py-1.5 transition cursor-pointer ${
        selected ? "bg-[var(--panel-2)]" : "hover:bg-[var(--panel)]"
      }`}
    >
      <div className="flex items-center gap-2">
        {stateIcon()}
        <span className={`text-[12.5px] truncate flex-1 ${session.unread ? "font-semibold" : "text-[var(--text-soft)]"}`}>
          {session.title || "Untitled"}
        </span>
        {session.unread && (
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" title="Unread" />
        )}
      </div>
      <div className="text-[10.5px] text-[var(--muted)] truncate mt-0.5">
        {workspaceLabel} · {formatRelativeTime(session.lastActivity)}
      </div>
    </Link>
  );
}
