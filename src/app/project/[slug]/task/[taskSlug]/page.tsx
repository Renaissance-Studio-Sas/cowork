"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import type { SessionSummaryDTO } from "@/lib/types";
import { useWorkspace } from "@/lib/workspace-context";
import { ContextMenu, type MenuItem } from "@/components/ContextMenu";
import { StatusChip } from "@/components/StatusChip";
import { handleComposerEnter } from "@/lib/composer";
import { taskSessionRoute, taskFileRoute, taskDirRoute, projectRoute, saveTaskPath } from "@/lib/routes";
import { FileDropZone, type FileAttachment } from "@/components/FileDropZone";

interface Entry {
  type: "file" | "folder";
  name: string;
  path: string;
  count?: number;
}

function iconForFile(p: string): string {
  if (p === "task.md") return "📋";
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
  stopped: "done",
  error: "error",
};
const STATE_COLOR: Record<SessionSummaryDTO["state"], string> = {
  awaiting_input: "var(--warn)",
  running: "var(--accent)",
  idle: "var(--ok)",
  stopped: "var(--ok)", // same as idle/done
  error: "#dc2626",
};

export default function TaskPage() {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const projectSlug = decodeURIComponent(params.slug as string);
  const taskSlug = decodeURIComponent(params.taskSlug as string);
  const dirPath = searchParams.get("dir") ?? "";

  const { projects, sessions, refresh } = useWorkspace();

  // Save the current path to localStorage for task state persistence
  useEffect(() => {
    const fullPath = dirPath ? `${pathname}?dir=${encodeURIComponent(dirPath)}` : pathname;
    saveTaskPath(projectSlug, taskSlug, fullPath);
  }, [pathname, dirPath, projectSlug, taskSlug]);

  const project = useMemo(
    () => projects.find((p) => p.slug === projectSlug) ?? null,
    [projects, projectSlug],
  );

  const task = useMemo(
    () => project?.tasks.find((t) => t.slug === taskSlug) ?? null,
    [project, taskSlug],
  );

  const taskSessions = useMemo(
    () => sessions.filter((s) => s.projectSlug === projectSlug && s.taskSlug === taskSlug),
    [sessions, projectSlug, taskSlug],
  );

  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(false);
  const [runtime, setRuntime] = useState<"claude" | "gemini">("claude");
  const [files, setFiles] = useState<string[]>([]);
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; type: "file" | "folder" } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renamingSession, setRenamingSession] = useState<string | null>(null);
  const [sessionRenameValue, setSessionRenameValue] = useState("");
  const [uploading, setUploading] = useState(false);

  const refreshFiles = useCallback(async () => {
    if (!projectSlug || !taskSlug) return;
    const r = await fetch(`/api/projects/${projectSlug}/tasks/${taskSlug}`, { cache: "no-store" });
    const j = await r.json();
    setFiles(j.files ?? []);
  }, [projectSlug, taskSlug]);

  // Handle file drop for artifact upload
  const handleFileDrop = useCallback(async (attachments: FileAttachment[]) => {
    if (attachments.length === 0 || !projectSlug || !taskSlug) return;
    setUploading(true);
    try {
      for (const att of attachments) {
        const formData = new FormData();
        formData.append("file", att.file);
        // Upload to current directory (dirPath) or root
        const subdir = dirPath || "";
        const url = `/api/files/upload?project=${encodeURIComponent(projectSlug)}&task=${encodeURIComponent(taskSlug)}${subdir ? `&subdir=${encodeURIComponent(subdir)}` : "&subdir="}`;
        await fetch(url, { method: "POST", body: formData });
      }
      refreshFiles();
    } finally {
      setUploading(false);
    }
  }, [projectSlug, taskSlug, dirPath, refreshFiles]);

  const refreshCommentCounts = useCallback(async () => {
    if (!projectSlug || !taskSlug) return;
    const r = await fetch(
      `/api/comments/counts?project=${encodeURIComponent(projectSlug)}&task=${encodeURIComponent(taskSlug)}`,
      { cache: "no-store" },
    );
    const j = await r.json();
    setCommentCounts(j.counts ?? {});
  }, [projectSlug, taskSlug]);

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
      .filter((e) => !(isRoot && e.name === "task.md"))
      .sort((a, b) => a.name.localeCompare(b.name));
    const taskMd = isRoot ? out.find((e) => e.name === "task.md") : null;
    return [
      ...(taskMd ? [taskMd] : []),
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
    if (!draft.trim() || starting || !projectSlug || !taskSlug) return;
    setStarting(true);
    try {
      const r = await fetch(`/api/projects/${projectSlug}/tasks/${taskSlug}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: draft.trim(), runtime }),
      });
      const j = await r.json();
      if (j.id) {
        setDraft("");
        router.push(taskSessionRoute(projectSlug, taskSlug, j.id));
      } else alert(j.error ?? "failed");
    } finally { setStarting(false); }
  };

  const markDone = async () => {
    if (!task) return;
    await fetch(`/api/projects/${projectSlug}/tasks/${taskSlug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: task.status === "wip" ? "done" : "wip" }),
    });
    refresh();
  };

  const navigateDir = (path: string) => {
    if (path) {
      router.push(taskDirRoute(projectSlug, taskSlug, path));
    } else {
      router.push(`/project/${encodeURIComponent(projectSlug)}/task/${encodeURIComponent(taskSlug)}`);
    }
  };

  const startRename = (e: Entry) => {
    setRenaming({ path: e.path, type: e.type });
    setRenameValue(e.name);
  };

  const commitRename = async () => {
    if (!renaming) return;
    const newName = renameValue.trim();
    if (!newName || newName === renaming.path.split("/").pop()) {
      setRenaming(null);
      return;
    }
    const dir = renaming.path.includes("/") ? renaming.path.slice(0, renaming.path.lastIndexOf("/")) : "";
    const newPath = dir ? `${dir}/${newName}` : newName;
    const res = await fetch(`/api/files`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: projectSlug, task: taskSlug, from: renaming.path, to: newPath }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "rename failed");
    } else {
      refreshFiles();
    }
    setRenaming(null);
  };

  const deleteEntry = async (e: Entry) => {
    if (!confirm(e.type === "folder"
      ? `Delete folder "${e.name}" and everything in it?`
      : `Delete "${e.name}"?`)) return;
    const r = await fetch(`/api/files?project=${encodeURIComponent(projectSlug)}&task=${encodeURIComponent(taskSlug)}&path=${encodeURIComponent(e.path)}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(j.error ?? "delete failed");
    } else {
      refreshFiles();
    }
  };

  const openContextMenu = (e: React.MouseEvent, entry: Entry) => {
    e.preventDefault();
    if (entry.type === "file" && entry.path === "task.md") return;
    const items: MenuItem[] = [
      { label: "Rename", onClick: () => startRename(entry) },
      { label: "Delete", danger: true, onClick: () => deleteEntry(entry) },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
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
      body: JSON.stringify({ projectSlug, taskSlug, name: newName }),
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
      body: JSON.stringify({ projectSlug, taskSlug }),
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

  const markAllSessionsAsRead = async () => {
    const unreadSessions = taskSessions.filter((s) => s.unread);
    if (unreadSessions.length === 0) return;
    await Promise.all(
      unreadSessions.map((s) =>
        fetch(`/api/sessions/${s.id}/seen`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectSlug, taskSlug }),
        })
      )
    );
    refresh();
  };

  const openSessionsHeaderContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const unreadCount = taskSessions.filter((s) => s.unread).length;
    const items: MenuItem[] = [
      {
        label: unreadCount > 0 ? `Mark all as read (${unreadCount})` : "Mark all as read",
        onClick: markAllSessionsAsRead,
        disabled: unreadCount === 0,
      },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  if (!task) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--muted)]">
        {projects.length === 0 ? "Loading..." : "Task not found"}
      </div>
    );
  }

  return (
    <>
      <header className="h-14 border-b border-[var(--border)] flex items-center px-6 gap-3 shrink-0">
        <StatusChip status={task.status} size="md" />
        <div className="flex-1 min-w-0">
          <div className="text-[14px] truncate">
            <Link href={projectRoute(projectSlug)} className="text-[var(--muted)] hover:text-[var(--text)]">{projectSlug}</Link>
            <span className="text-[var(--muted)] mx-1.5">·</span>
            <span className={task.status === "done" ? "text-[var(--muted)] line-through" : ""}>{task.slug}</span>
          </div>
        </div>
        <button
          onClick={markDone}
          className="text-[12px] text-[var(--text-soft)] border border-[var(--border-strong)] rounded-lg px-3 py-1.5 hover:bg-[var(--panel-2)]"
        >
          {task.status === "wip" ? "✓ Mark done" : "↺ Reopen"}
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[760px] mx-auto px-6 py-6 space-y-6">
          <FileDropZone onFiles={handleFileDrop} disabled={uploading}>
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
              <span className="ml-2 text-[var(--muted)] normal-case tracking-normal">· {entries.length}{uploading && " (uploading…)"}</span>
            </div>

            {entries.length === 0 ? (
              <div className="text-[13px] text-[var(--muted)] italic px-1">
                Drop files here or start empty.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {entries.map((e) => {
                  const isTaskMd = e.type === "file" && e.path === "task.md";
                  const href = e.type === "folder"
                    ? taskDirRoute(projectSlug, taskSlug, e.path)
                    : taskFileRoute(projectSlug, taskSlug, e.path);
                  const commentCount = e.type === "file"
                    ? (commentCounts[e.path] ?? 0)
                    : Object.entries(commentCounts).reduce((acc, [p, n]) => p.startsWith(e.path + "/") ? acc + n : acc, 0);

                  if (renaming?.path === e.path) {
                    return (
                      <div
                        key={e.path}
                        className="w-full text-left rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3.5 py-2.5 flex items-center gap-3"
                      >
                        <span className="text-[18px] shrink-0">
                          {e.type === "folder" ? "📁" : iconForFile(e.path)}
                        </span>
                        <input
                          autoFocus
                          value={renameValue}
                          onClick={(ev) => ev.stopPropagation()}
                          onChange={(ev) => setRenameValue(ev.target.value)}
                          onKeyDown={(ev) => {
                            if (ev.key === "Enter") commitRename();
                            else if (ev.key === "Escape") setRenaming(null);
                            ev.stopPropagation();
                          }}
                          onBlur={commitRename}
                          className="flex-1 bg-transparent border-b border-[var(--accent)] outline-none text-[13.5px] py-0.5"
                        />
                      </div>
                    );
                  }

                  return (
                    <Link
                      key={e.path}
                      href={href}
                      onContextMenu={(ev) => openContextMenu(ev, e)}
                      className="w-full text-left rounded-xl border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel-2)] px-3.5 py-2.5 transition flex items-center gap-3 cursor-pointer"
                    >
                      <span className="text-[18px] shrink-0">
                        {e.type === "folder" ? "📁" : iconForFile(e.path)}
                      </span>
                      <span className={`text-[13.5px] truncate flex-1 ${isTaskMd ? "font-medium" : ""}`}>
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
          </FileDropZone>

          {!dirPath && (
            <div>
              <div
                className="text-[12px] uppercase tracking-wider text-[var(--muted)] font-medium mb-2 px-1 cursor-default"
                onContextMenu={openSessionsHeaderContextMenu}
              >
                Sessions
              </div>
              {taskSessions.length === 0 ? (
                <div className="text-[13px] text-[var(--muted)] italic px-1">
                  No agents have worked on this task yet. Send one with the composer below.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {taskSessions.map((s) => {
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
                          <div className="mt-1 text-[11.5px] text-[var(--muted)]">
                            {formatRelative(s.lastActivity)}
                          </div>
                        </div>
                      );
                    }
                    return (
                      <Link
                        key={s.id}
                        href={taskSessionRoute(projectSlug, taskSlug, s.id)}
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
                          <span className="text-[11.5px] whitespace-nowrap" style={{ color: STATE_COLOR[s.state] }}>
                            {STATE_LABEL[s.state]}
                          </span>
                        </div>
                        <div className="mt-1 text-[11.5px] text-[var(--muted)]">
                          {formatRelative(s.lastActivity)}
                        </div>
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
              placeholder="Tell an agent what to do on this task…"
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
          <div className="flex items-center justify-end gap-2 pt-1.5">
            <span className="text-[11px] text-[var(--muted)]">Agent:</span>
            <select
              value={runtime}
              onChange={(e) => setRuntime(e.target.value as "claude" | "gemini")}
              className="text-[11px] bg-transparent text-[var(--muted)] border border-[var(--border)] rounded px-1.5 py-0.5 outline-none focus:border-[var(--accent)] focus:text-[var(--text)] cursor-pointer"
            >
              <option value="claude">Claude</option>
              <option value="gemini">Gemini</option>
            </select>
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
