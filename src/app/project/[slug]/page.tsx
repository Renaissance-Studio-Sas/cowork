"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import type { ProjectDTO, SessionSummaryDTO, TaskDTO } from "@/lib/types";
import { useWorkspace } from "@/lib/workspace-context";
import { ContextMenu, type MenuItem } from "@/components/ContextMenu";
import { StatusChip } from "@/components/StatusChip";
import { handleComposerEnter } from "@/lib/composer";
import { taskRoute, projectSessionRoute, projectFileRoute, projectDirRoute } from "@/lib/routes";

interface Entry {
  type: "file" | "folder";
  name: string;
  path: string;
  count?: number;
}

function iconForFile(p: string): string {
  if (p === "project.md") return "📋";
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  if (["md", "markdown", "txt"].includes(ext)) return "📄";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "🖼";
  if (ext === "pdf") return "📕";
  if (ext === "html" || ext === "htm") return "🌐";
  if (["csv", "json", "yaml", "yml"].includes(ext)) return "📊";
  return "📎";
}

const STATE_LABEL: Record<SessionSummaryDTO["state"], string> = {
  awaiting_input: "needs your reply",
  running: "working",
  idle: "done",
  stopped: "stopped",
  error: "error",
};
const STATE_COLOR: Record<SessionSummaryDTO["state"], string> = {
  awaiting_input: "var(--warn)",
  running: "var(--accent)",
  idle: "var(--ok)",
  stopped: "var(--muted)",
  error: "#dc2626",
};

export default function ProjectPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const slug = decodeURIComponent(params.slug as string);
  const dirPath = searchParams.get("dir") ?? "";

  const { projects, sessions, refresh } = useWorkspace();

  const project = useMemo(
    () => projects.find((p) => p.slug === slug) ?? null,
    [projects, slug],
  );

  const projectSessions = useMemo(
    () => sessions.filter((s) => s.projectSlug === slug && !s.taskSlug),
    [sessions, slug],
  );

  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renamingSession, setRenamingSession] = useState<string | null>(null);
  const [sessionRenameValue, setSessionRenameValue] = useState("");

  const refreshFiles = useCallback(async () => {
    if (!slug) return;
    const r = await fetch(`/api/projects/${slug}/files`, { cache: "no-store" });
    const j = await r.json();
    setFiles(j.files ?? []);
  }, [slug]);

  const refreshCommentCounts = useCallback(async () => {
    if (!slug) return;
    const r = await fetch(
      `/api/comments/counts?project=${encodeURIComponent(slug)}&task=`,
      { cache: "no-store" },
    );
    const j = await r.json();
    setCommentCounts(j.counts ?? {});
  }, [slug]);

  useEffect(() => {
    refreshFiles();
    refreshCommentCounts();
  }, [refreshFiles, refreshCommentCounts]);

  const entries = useMemo<Entry[]>(() => {
    const prefix = dirPath ? dirPath.replace(/\/+$/, "") + "/" : "";
    const seenFolders = new Map<string, number>();
    const out: Entry[] = [];
    for (const f of files) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash < 0) {
        out.push({ type: "file", name: rest, path: f });
      } else {
        const folderName = rest.slice(0, slash);
        seenFolders.set(folderName, (seenFolders.get(folderName) ?? 0) + 1);
      }
    }
    const folderEntries: Entry[] = [...seenFolders.entries()].map(([name, count]) => ({
      type: "folder",
      name,
      path: (prefix + name).replace(/\/+$/, ""),
      count,
    }));
    const isRoot = !dirPath;
    const folders = folderEntries.sort((a, b) => a.name.localeCompare(b.name));
    const filesAtLevel = out
      .filter((e) => !(isRoot && e.name === "project.md"))
      .sort((a, b) => a.name.localeCompare(b.name));
    const pinned = isRoot ? out.find((e) => e.name === "project.md") : null;
    return [
      ...(pinned ? [pinned] : []),
      ...folders,
      ...filesAtLevel,
    ];
  }, [files, dirPath]);

  const breadcrumb = useMemo(() => {
    if (!dirPath) return [{ name: "Artifacts", path: "" }];
    const parts = dirPath.split("/").filter(Boolean);
    return [
      { name: "Artifacts", path: "" },
      ...parts.map((p, i) => ({ name: p, path: parts.slice(0, i + 1).join("/") })),
    ];
  }, [dirPath]);

  const start = async () => {
    if (!draft.trim() || starting || !slug) return;
    setStarting(true);
    try {
      const r = await fetch(`/api/projects/${slug}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: draft.trim() }),
      });
      const j = await r.json();
      if (j.id) {
        setDraft("");
        router.push(projectSessionRoute(slug, j.id));
      } else alert(j.error ?? "failed");
    } finally { setStarting(false); }
  };

  const markDone = async () => {
    if (!project) return;
    await fetch(`/api/projects/${slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: project.status === "wip" ? "done" : "wip" }),
    });
    refresh();
  };

  const navigateDir = (path: string) => {
    if (path) {
      router.push(projectDirRoute(slug, path));
    } else {
      router.push(`/project/${encodeURIComponent(slug)}`);
    }
  };

  const startRenameSession = (s: SessionSummaryDTO) => {
    setRenamingSession(s.id);
    setSessionRenameValue(s.title || "");
  };

  const commitSessionRename = async () => {
    if (!renamingSession) return;
    const newName = sessionRenameValue.trim();
    const sessionId = renamingSession;
    setRenamingSession(null);
    if (!newName) return;
    const res = await fetch(`/api/sessions/${sessionId}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectSlug: slug, taskSlug: "", name: newName }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "rename failed");
    }
    refresh();
  };

  const deleteSessionHandler = async (s: SessionSummaryDTO) => {
    if (!confirm(`Delete session "${s.title || s.id}"?`)) return;
    const res = await fetch(`/api/sessions/${s.id}/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectSlug: slug, taskSlug: "" }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "delete failed");
      return;
    }
    refresh();
  };

  const openSessionContextMenu = (e: React.MouseEvent, s: SessionSummaryDTO) => {
    e.preventDefault();
    const isRunning = s.state === "running" || s.state === "awaiting_input";
    const items: MenuItem[] = [
      { label: "Rename", onClick: () => startRenameSession(s) },
      { label: "Delete", danger: true, onClick: () => deleteSessionHandler(s), disabled: isRunning },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--muted)]">
        {projects.length === 0 ? "Loading..." : "Project not found"}
      </div>
    );
  }

  const wipTasks = project.tasks.filter((t) => t.status === "wip");
  const doneTasks = project.tasks.filter((t) => t.status === "done");

  return (
    <>
      <header className="h-14 border-b border-[var(--border)] flex items-center px-6 gap-3 shrink-0">
        <StatusChip status={project.status} size="md" />
        <div className="flex-1 min-w-0">
          <div className="text-[14px] truncate">
            <span className={project.status === "done" ? "text-[var(--muted)] line-through" : ""}>{project.slug}</span>
          </div>
          <div className="text-[11.5px] text-[var(--muted)]">project · {project.tasks.length} task{project.tasks.length === 1 ? "" : "s"}</div>
        </div>
        <button
          onClick={markDone}
          className="text-[12px] text-[var(--text-soft)] border border-[var(--border-strong)] rounded-lg px-3 py-1.5 hover:bg-[var(--panel-2)]"
        >
          {project.status === "wip" ? "✓ Mark done" : "↺ Reopen"}
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[760px] mx-auto px-6 py-6 space-y-6">
          {/* Artifacts */}
          {(entries.length > 0 || dirPath) && (
            <div>
              <div className="flex items-center gap-1.5 mb-2 px-1 text-[12px] uppercase tracking-wider text-[var(--muted)] font-medium">
                {breadcrumb.map((b, i) => (
                  <span key={i} className="flex items-center gap-1.5">
                    {i > 0 && <span className="text-[var(--border-strong)]">/</span>}
                    <button
                      onClick={() => navigateDir(b.path)}
                      disabled={i === breadcrumb.length - 1}
                      className={`${i === breadcrumb.length - 1 ? "text-[var(--text)] cursor-default" : "hover:text-[var(--text)]"} normal-case tracking-normal text-[12.5px]`}
                    >{i === 0 ? "Artifacts" : b.name}</button>
                  </span>
                ))}
                <span className="ml-2 text-[var(--muted)] normal-case tracking-normal">· {entries.length}</span>
              </div>

              {entries.length === 0 ? (
                <div className="text-[13px] text-[var(--muted)] italic px-1">Empty folder.</div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {entries.map((e) => {
                    const isPinned = e.type === "file" && e.path === "project.md";
                    const href = e.type === "folder"
                      ? projectDirRoute(slug, e.path)
                      : projectFileRoute(slug, e.path);
                    const commentCount = e.type === "file"
                      ? (commentCounts[e.path] ?? 0)
                      : Object.entries(commentCounts).reduce((acc, [p, n]) => p.startsWith(e.path + "/") ? acc + n : acc, 0);
                    return (
                      <Link
                        key={e.path}
                        href={href}
                        className="w-full text-left rounded-xl border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel-2)] px-3.5 py-2.5 transition flex items-center gap-3 cursor-pointer"
                      >
                        <span className="text-[18px] shrink-0">
                          {e.type === "folder" ? "📁" : iconForFile(e.path)}
                        </span>
                        <span className={`text-[13.5px] truncate flex-1 ${isPinned ? "font-medium" : ""}`}>
                          {e.name}
                          {e.type === "folder" && (
                            <span className="text-[var(--muted)] ml-1.5 text-[11.5px]">{e.count} item{e.count === 1 ? "" : "s"}</span>
                          )}
                        </span>
                        {commentCount > 0 && (
                          <span
                            className="shrink-0 text-[11px] bg-[var(--accent-soft)] text-[var(--accent)] font-medium rounded-md px-1.5 py-0.5"
                            title={`${commentCount} comment${commentCount === 1 ? "" : "s"}`}
                          >💬 {commentCount}</span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Tasks */}
          {!dirPath && (
            <div>
              <div className="text-[12px] uppercase tracking-wider text-[var(--muted)] font-medium mb-2 px-1">
                Tasks <span className="text-[var(--muted)] normal-case tracking-normal">· {project.tasks.length}</span>
              </div>
              {project.tasks.length === 0 ? (
                <div className="text-[13px] text-[var(--muted)] italic px-1">No tasks yet.</div>
              ) : (
                <div className="space-y-1.5">
                  {[...wipTasks, ...doneTasks].map((t: TaskDTO) => (
                    <Link
                      key={t.slug}
                      href={taskRoute(slug, t.slug)}
                      className="block w-full text-left rounded-xl border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel-2)] px-4 py-3 transition"
                    >
                      <div className="flex items-center gap-2">
                        <StatusChip status={t.status} />
                        <span className={`text-[13.5px] truncate flex-1 ${t.status === "done" ? "text-[var(--muted)] line-through" : ""}`}>{t.slug}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Sessions */}
          {!dirPath && (
            <div>
              <div className="text-[12px] uppercase tracking-wider text-[var(--muted)] font-medium mb-2 px-1">
                Sessions
              </div>
              {projectSessions.length === 0 ? (
                <div className="text-[13px] text-[var(--muted)] italic px-1">
                  No project-level sessions yet. Brief an agent below to start one.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {projectSessions.map((s) => {
                    const isRenaming = renamingSession === s.id;
                    if (isRenaming) {
                      return (
                        <div
                          key={s.id}
                          className={`block w-full text-left rounded-xl border bg-[var(--panel)] px-4 py-3 ${s.unread ? "border-[var(--accent)] border-l-4" : "border-[var(--border)]"}`}
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${s.state === "awaiting_input" ? "pulse" : ""}`}
                              style={{ background: STATE_COLOR[s.state] }}
                            />
                            <input
                              autoFocus
                              value={sessionRenameValue}
                              onClick={(ev) => ev.stopPropagation()}
                              onChange={(ev) => setSessionRenameValue(ev.target.value)}
                              onKeyDown={(ev) => {
                                if (ev.key === "Enter") commitSessionRename();
                                else if (ev.key === "Escape") setRenamingSession(null);
                                ev.stopPropagation();
                              }}
                              onBlur={commitSessionRename}
                              className="flex-1 bg-transparent border-b border-[var(--accent)] outline-none text-[13.5px] py-0.5"
                              placeholder="Session name"
                            />
                            <span className="text-[11.5px] whitespace-nowrap" style={{ color: STATE_COLOR[s.state] }}>
                              {STATE_LABEL[s.state]}
                            </span>
                          </div>
                          <div className="mt-1 text-[11.5px] text-[var(--muted)]">{formatRelative(s.lastActivity)}</div>
                        </div>
                      );
                    }
                    return (
                      <Link
                        key={s.id}
                        href={projectSessionRoute(slug, s.id)}
                        onContextMenu={(ev) => openSessionContextMenu(ev, s)}
                        className={`block w-full text-left rounded-xl border bg-[var(--panel)] hover:bg-[var(--panel-2)] px-4 py-3 transition ${s.unread ? "border-[var(--accent)] border-l-4" : "border-[var(--border)]"}`}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${s.state === "awaiting_input" ? "pulse" : ""}`}
                            style={{ background: STATE_COLOR[s.state] }}
                          />
                          <span className={`text-[13.5px] truncate flex-1 ${s.unread ? "font-semibold" : ""}`}>{s.title || "(no message)"}</span>
                          {s.unread && (
                            <span className="shrink-0 text-[10px] bg-[var(--accent)] text-[var(--accent-text)] font-medium rounded-md px-1.5 py-0.5">
                              NEW
                            </span>
                          )}
                          <span className="text-[11.5px] whitespace-nowrap" style={{ color: STATE_COLOR[s.state] }}>{STATE_LABEL[s.state]}</span>
                        </div>
                        <div className="mt-1 text-[11.5px] text-[var(--muted)]">{formatRelative(s.lastActivity)}</div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-[var(--border)] px-6 py-4 bg-[var(--bg)]">
        <div className="max-w-[760px] mx-auto">
          <div className="rounded-2xl border border-[var(--border-strong)] bg-[var(--panel)] flex items-end gap-2 px-3 py-2 focus-within:border-[var(--accent)] transition">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Brief an agent on this project as a whole…"
              rows={2}
              style={{ maxHeight: 200 }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 200) + "px";
              }}
              onKeyDown={(e) => handleComposerEnter(e, start)}
              className="flex-1 resize-none bg-transparent outline-none text-[14px] py-1.5 leading-relaxed"
            />
            <button
              onClick={start}
              disabled={!draft.trim() || starting}
              className="rounded-lg bg-[var(--accent)] text-[var(--accent-text)] w-9 h-9 flex items-center justify-center font-semibold disabled:opacity-40 hover:brightness-110 transition shrink-0"
              title="Start (↵)"
            >↑</button>
          </div>
        </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`;
  return d.toLocaleDateString();
}
