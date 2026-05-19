"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ProjectDTO, SessionSummaryDTO, TaskDTO } from "@/lib/types";
import { useWorkspace } from "@/lib/workspace-context";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { StatusChip } from "./StatusChip";
import { projectRoute, taskRoute, taskSessionRoute, projectSessionRoute, getTaskRestoreRoute } from "@/lib/routes";

const COLLAPSED_KEY = "wb-projects-collapsed";

function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, boolean>;
  } catch { return {}; }
}

interface Props {
  onNewTask: (project: string) => void;
  onNewProject: () => void;
  onClose: () => void;
}

export function SidebarNav({ onNewTask, onNewProject, onClose }: Props) {
  const pathname = usePathname();
  const { projects, sessions, awaitingCount, refresh } = useWorkspace();

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  type Rename = { kind: "task"; project: string; task: string } | { kind: "project"; project: string };
  const [renaming, setRenaming] = useState<Rename | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Parse current selection from pathname
  const selected = parsePathname(pathname);

  useEffect(() => { setCollapsed(loadCollapsed()); }, []);

  const updateCollapsed = (project: string, value: boolean) => {
    setCollapsed((prev) => {
      const next = { ...prev, [project]: value };
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const visibleProjects = [...projects].sort((a, b) => {
    if (a.status !== b.status) return a.status === "wip" ? -1 : 1;
    return a.slug.localeCompare(b.slug);
  });
  const wipProjects = visibleProjects.filter((p) => p.status === "wip");

  const taskCounts = (project: string, task: string) => {
    const list = sessions.filter((s) => s.projectSlug === project && s.taskSlug === task);
    return {
      total: list.length,
      awaiting: list.filter((s) => s.state === "awaiting_input").length,
      running: list.filter((s) => s.state === "running").length,
      unread: list.filter((s) => s.unread).length,
    };
  };

  // Check if a project has any unread sessions (across all its tasks)
  const projectHasUnread = (projectSlug: string) => {
    return sessions.some((s) => s.projectSlug === projectSlug && s.unread);
  };

  // Get the 10 most recent sessions sorted by lastActivity
  const recentSessions = [...sessions]
    .sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1))
    .slice(0, 10);

  const startRenameTask = (projectSlug: string, taskSlug: string) => {
    setRenaming({ kind: "task", project: projectSlug, task: taskSlug });
    setRenameValue(taskSlug);
  };
  const startRenameProject = (projectSlug: string) => {
    setRenaming({ kind: "project", project: projectSlug });
    setRenameValue(projectSlug);
  };

  const commitRename = async () => {
    if (!renaming) return;
    const target = renaming;
    setRenaming(null);
    const newSlug = renameValue.trim();
    if (!newSlug) return;
    if (target.kind === "task") {
      if (newSlug === target.task) return;
      const r = await fetch(`/api/projects/${target.project}/tasks/${target.task}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: newSlug }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j.error ?? "rename failed"); }
    } else {
      if (newSlug === target.project) return;
      const r = await fetch(`/api/projects/${target.project}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: newSlug }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j.error ?? "rename failed"); }
    }
    refresh();
  };

  const deleteTask = async (projectSlug: string, taskSlug: string) => {
    if (!confirm(`Delete task "${taskSlug}" and everything in it?`)) return;
    const r = await fetch(`/api/projects/${projectSlug}/tasks/${taskSlug}`, { method: "DELETE" });
    if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j.error ?? "delete failed"); return; }
    refresh();
  };

  const deleteProject = async (projectSlug: string) => {
    if (!confirm(`Delete project "${projectSlug}" and all its tasks?`)) return;
    const r = await fetch(`/api/projects/${projectSlug}`, { method: "DELETE" });
    if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j.error ?? "delete failed"); return; }
    refresh();
  };

  const moveTaskTo = async (fromProject: string, taskSlug: string, toProject: string) => {
    const r = await fetch(`/api/projects/${fromProject}/tasks/${taskSlug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: toProject }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { alert(j.error ?? "move failed"); return; }
    refresh();
  };

  const openTaskMenu = (e: React.MouseEvent, projectSlug: string, taskSlug: string) => {
    e.preventDefault();
    const items: MenuItem[] = [
      { label: "Rename  ↵", onClick: () => startRenameTask(projectSlug, taskSlug) },
    ];
    for (const p of wipProjects) {
      if (p.slug === projectSlug) continue;
      items.push({
        label: `Move to ${p.slug}`,
        onClick: () => moveTaskTo(projectSlug, taskSlug, p.slug),
      });
    }
    items.push({ label: "Delete", danger: true, onClick: () => deleteTask(projectSlug, taskSlug) });
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const openProjectMenu = (e: React.MouseEvent, projectSlug: string) => {
    e.preventDefault();
    const items: MenuItem[] = [
      { label: "Rename", onClick: () => startRenameProject(projectSlug) },
      { label: "Delete", danger: true, onClick: () => deleteProject(projectSlug) },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // Enter on a selected task or project → start renaming.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (renaming || menu) return;
      if (selected.project && selected.task) {
        e.preventDefault();
        startRenameTask(selected.project, selected.task);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.project, selected.task, renaming, menu]);

  return (
    <aside className="w-[300px] shrink-0 bg-[var(--bg-2)] border-r border-[var(--border)] flex flex-col">
      <div className="px-4 pt-5 pb-3 flex items-start gap-2">
        <Link href="/" className="flex-1 min-w-0">
          <div className="text-[15px] font-semibold leading-tight">Coworking space</div>
          <div className="text-[12.5px] text-[var(--muted)] leading-snug mt-0.5">where humans and AI collaborate</div>
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

      <div className="px-3 pb-3 flex items-center gap-2">
        <button
          onClick={onNewProject}
          className="flex-1 rounded-xl border border-[var(--border-strong)] bg-[var(--panel)] text-[var(--text)] px-3 py-2 text-[13px] font-medium hover:bg-[var(--panel-2)] transition"
        >
          + Project
        </button>
        {awaitingCount > 0 && (
          <span className="text-[11.5px] text-[var(--warn)] pulse whitespace-nowrap" title={`${awaitingCount} agent(s) awaiting input`}>
            ● {awaitingCount}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {/* Recent Sessions */}
        {recentSessions.length > 0 && (
          <div className="mb-3">
            <div className="px-2 py-1.5 text-[11px] uppercase tracking-wider font-semibold text-[var(--muted)]">
              Recent Sessions
            </div>
            <div className="space-y-0.5">
              {recentSessions.map((s) => (
                <RecentSessionRow key={s.id} session={s} selected={pathname.includes(`/session/${s.id}`)} />
              ))}
            </div>
          </div>
        )}

        {/* Projects */}
        <div className="px-2 py-1.5 text-[11px] uppercase tracking-wider font-semibold text-[var(--muted)]">
          Projects
        </div>
        {visibleProjects.length === 0 && (
          <div className="px-3 py-4 text-[12.5px] text-[var(--muted)]">No projects yet.</div>
        )}

        {visibleProjects.map((p) => {
          const visibleTasks = [...p.tasks].sort((a, b) => {
            if (a.status !== b.status) return a.status === "wip" ? -1 : 1;
            return a.slug.localeCompare(b.slug);
          });
          const isCollapsed = !!collapsed[p.slug];
          const label = p.slug.replace(/-/g, " ");
          const isDragOver = dragOver === p.slug;
          const projectDone = p.status === "done";
          const isProjectSelected = selected.project === p.slug && !selected.task;

          return (
            <div key={p.slug} className="mb-2">
              <div
                onContextMenu={(e) => openProjectMenu(e, p.slug)}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOver(p.slug); }}
                onDragLeave={() => setDragOver((d) => (d === p.slug ? null : d))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(null);
                  const data = e.dataTransfer.getData("application/x-wb-task");
                  if (!data) return;
                  try {
                    const { project: fromProject, task: taskSlug } = JSON.parse(data);
                    if (fromProject && taskSlug && fromProject !== p.slug) {
                      moveTaskTo(fromProject, taskSlug, p.slug);
                      updateCollapsed(p.slug, false);
                    }
                  } catch { /* ignore */ }
                }}
                className={`w-full flex items-center gap-1 px-1 py-1.5 rounded-md group transition ${isDragOver ? "bg-[var(--accent-soft)] ring-2 ring-[var(--accent)]" : ""} ${isProjectSelected ? "bg-[var(--panel-2)]" : ""}`}
              >
                <button
                  onClick={() => updateCollapsed(p.slug, !isCollapsed)}
                  className="w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--panel)] shrink-0"
                  title={isCollapsed ? "Expand" : "Collapse"}
                >
                  <svg
                    width="18" height="18" viewBox="0 0 24 24"
                    className={`text-[var(--text)] transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                    fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    aria-hidden
                  ><path d="M9 6l6 6-6 6" /></svg>
                </button>
                <StatusChip status={p.status} />
                {renaming?.kind === "project" && renaming.project === p.slug ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") setRenaming(null);
                    }}
                    onBlur={commitRename}
                    className="flex-1 bg-transparent border-b border-[var(--accent)] outline-none text-[12px] uppercase tracking-wider font-semibold"
                  />
                ) : (
                  <Link
                    href={projectRoute(p.slug)}
                    className={`flex-1 text-left text-[12px] uppercase tracking-wider truncate transition px-1 ${projectDone ? "text-[var(--muted)] line-through font-semibold" : projectHasUnread(p.slug) ? "text-[var(--text)] font-bold" : "text-[var(--text-soft)] hover:text-[var(--text)] font-semibold"}`}
                    title={`Open project ${label}`}
                  >
                    {label}
                  </Link>
                )}
                <span
                  role="button" tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); onNewTask(p.slug); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault(); e.stopPropagation();
                      onNewTask(p.slug);
                    }
                  }}
                  className="text-[var(--muted)] hover:text-[var(--text)] text-[16px] leading-none px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--panel-2)] transition"
                  title="New task in this project"
                >+</span>
              </div>

              {!isCollapsed && (
                <div className="space-y-0.5 mt-0.5">
                  {visibleTasks.length === 0 && (
                    <div className="text-[11.5px] text-[var(--muted)] px-3 py-1.5 italic">no tasks</div>
                  )}
                  {visibleTasks.map((t) => (
                    <TaskRow
                      key={t.slug}
                      projectSlug={p.slug}
                      task={t}
                      counts={taskCounts(p.slug, t.slug)}
                      selected={selected.project === p.slug && selected.task === t.slug}
                      renaming={renaming?.kind === "task" && renaming.project === p.slug && renaming.task === t.slug ? renameValue : null}
                      onRenameChange={setRenameValue}
                      onRenameCommit={commitRename}
                      onRenameCancel={() => setRenaming(null)}
                      onContextMenu={(e) => openTaskMenu(e, p.slug, t.slug)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  );
}

function TaskRow({
  projectSlug, task, counts, selected, renaming,
  onRenameChange, onRenameCommit, onRenameCancel,
  onContextMenu,
}: {
  projectSlug: string;
  task: TaskDTO;
  counts: { total: number; awaiting: number; running: number; unread: number };
  selected: boolean;
  renaming: string | null;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const router = useRouter();
  const tooltip = (task.description || "").split("\n")[0].replace(/^#+\s*/, "");

  const handleClick = (e: React.MouseEvent) => {
    if (renaming !== null) return; // Let input handle clicks
    e.preventDefault();
    // Navigate to the last visited path for this task, or task root
    const targetRoute = getTaskRestoreRoute(projectSlug, task.slug);
    router.push(targetRoute);
  };

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" && renaming === null) {
          e.preventDefault();
          const targetRoute = getTaskRestoreRoute(projectSlug, task.slug);
          router.push(targetRoute);
        }
      }}
      onContextMenu={onContextMenu}
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(
          "application/x-wb-task",
          JSON.stringify({ project: projectSlug, task: task.slug }),
        );
      }}
      className={`block w-full text-left rounded-lg px-3 py-2 transition cursor-pointer ${
        selected ? "bg-[var(--panel-2)]" : "hover:bg-[var(--panel)]"
      }`}
    >
      {renaming !== null ? (
        <input
          autoFocus
          value={renaming}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") onRenameCommit();
            else if (e.key === "Escape") onRenameCancel();
          }}
          onBlur={onRenameCommit}
          className="w-full bg-transparent border-b border-[var(--accent)] outline-none text-[13.5px]"
        />
      ) : (
        <div className="flex items-center gap-2" title={tooltip || undefined}>
          <StatusChip status={task.status} />
          <span className={`text-[13.5px] truncate flex-1 ${task.status === "done" ? "text-[var(--muted)] line-through" : counts.unread > 0 ? "font-semibold" : ""}`}>{task.slug}</span>
          {counts.unread > 0 && (
            <span className="text-[9px] bg-[var(--accent)] text-[var(--accent-text)] font-semibold rounded px-1 py-0.5" title={`${counts.unread} unread`}>
              {counts.unread}
            </span>
          )}
          {counts.awaiting > 0 ? (
            <span className="pulse text-[10px] text-[var(--warn)]" title={`${counts.awaiting} awaiting`}>●{counts.awaiting}</span>
          ) : counts.running > 0 ? (
            <span className="text-[10px] text-[var(--accent)]" title={`${counts.running} running`}>●{counts.running}</span>
          ) : counts.total > 0 ? (
            <span className="text-[10px] text-[var(--muted)]" title={`${counts.total} session(s)`}>{counts.total}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function parsePathname(pathname: string): { project?: string; task?: string } {
  // /project/[slug] or /project/[slug]/task/[taskSlug]/...
  const match = pathname.match(/^\/project\/([^/]+)(?:\/task\/([^/]+))?/);
  if (match) {
    return {
      project: decodeURIComponent(match[1]),
      task: match[2] ? decodeURIComponent(match[2]) : undefined,
    };
  }
  return {};
}

function RecentSessionRow({ session, selected }: { session: SessionSummaryDTO; selected: boolean }) {
  const href = session.taskSlug
    ? taskSessionRoute(session.projectSlug, session.taskSlug, session.id)
    : projectSessionRoute(session.projectSlug, session.id);

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
    switch (session.state) {
      case "running":
        return <span className="text-[var(--accent)]" title="Running">●</span>;
      case "awaiting_input":
        return <span className="pulse text-[var(--warn)]" title="Awaiting input">●</span>;
      case "error":
        return <span className="text-red-500" title="Error">●</span>;
      default:
        return null;
    }
  };

  return (
    <Link
      href={href}
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
        {session.taskSlug || session.projectSlug} · {formatRelativeTime(session.lastActivity)}
      </div>
    </Link>
  );
}
