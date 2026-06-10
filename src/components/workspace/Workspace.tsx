"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useRouter, useSearchParams, usePathname } from "@/lib/navigation";
import type { WorkspaceDTO, SessionSummaryDTO, SessionRuntime, EffortLevel } from "@/lib/types";
import { findWorkspace, useWorkspace } from "@/lib/workspace-context";
import { ContextMenu, type MenuItem } from "@/components/ContextMenu";
import { WorkingIndicator } from "@/components/WorkingIndicator";
import { Markdown } from "@/components/chat/Markdown";
import { useStickyDraft } from "@/components/chat/useStickyDraft";
import { FileDropZone, AttachmentPreview, filesToAttachments, type FileAttachment } from "@/components/FileDropZone";
import { handleComposerEnter, handleComposerPaste } from "@/lib/composer";
import { FileViewer } from "@/components/FileViewer";
import { Chat } from "@/components/Chat";
import {
  buildWorkspaceQuery,
  encodeWorkspacePath,
  saveWorkspacePath,
  workspaceRoute,
  type WorkspaceParams,
} from "@/lib/routes";

// ---------------------------------------------------------------------------
// Shared types and helpers
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;
const MIN_COLUMN_FRACTION = 0.2;
const MAX_COLUMN_FRACTION = 0.8;
const DEFAULT_EXPANDED_SPLIT = 0.7;
// Minimum px width for a collapsed list column while the other side is expanded,
// so the list stays readable and doesn't get squeezed to nothing.
const LIST_MIN_WIDTH = 240;

interface Entry {
  type: "file" | "folder";
  name: string;
  path: string;
  count?: number;
  /** Modification time (epoch ms) for recency sorting. */
  mtime?: number;
}

function iconForFile(p: string): string {
  const lower = p.toLowerCase();
  if (lower.endsWith(".emlthread.json")) return "📧";
  const ext = lower.split(".").pop() ?? "";
  if (["md", "markdown", "txt"].includes(ext)) return "📄";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "🖼";
  if (ext === "pdf") return "📕";
  if (ext === "html" || ext === "htm") return "🌐";
  if (["csv", "json", "yaml", "yml"].includes(ext)) return "📊";
  return "📎";
}

const STATE_LABEL: Record<SessionSummaryDTO["state"], string> = {
  awaiting_input: "pending",
  running: "working",
  idle: "pending",
  stopped: "pending",
  error: "error",
};
const STATE_COLOR: Record<SessionSummaryDTO["state"], string> = {
  awaiting_input: "var(--warn)",
  running: "var(--accent)",
  idle: "var(--warn)",
  stopped: "var(--warn)",
  error: "#dc2626",
};

function effectiveState(s: SessionSummaryDTO): SessionSummaryDTO["state"] {
  return s.state === "running" && s.hasPendingPrompt ? "awaiting_input" : s.state;
}
function sessionLabel(s: SessionSummaryDTO): string {
  if (s.completed) return "completed";
  if (s.backlog) return "backlog";
  return STATE_LABEL[effectiveState(s)];
}
function sessionColor(s: SessionSummaryDTO): string {
  if (s.completed) return "var(--ok)";
  if (s.backlog) return "var(--muted)";
  return STATE_COLOR[effectiveState(s)];
}
function sessionIsPending(s: SessionSummaryDTO): boolean {
  // Backlog sessions are intentionally parked — they don't count as "needs
  // attention" pending work.
  if (s.completed || s.backlog) return false;
  const st = effectiveState(s);
  return st !== "running" && st !== "error";
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

function clampFraction(n: number): number {
  if (Number.isNaN(n)) return DEFAULT_EXPANDED_SPLIT;
  return Math.min(MAX_COLUMN_FRACTION, Math.max(MIN_COLUMN_FRACTION, n));
}

function pathKey(path: string[]): string { return path.join("/"); }

// ---------------------------------------------------------------------------
// Workspace shell
// ---------------------------------------------------------------------------

interface WorkspaceProps {
  /** Slug-chain identifying this workspace, from root → leaf. */
  workspacePath: string[];
}

export function Workspace({ workspacePath }: WorkspaceProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { workspaces, sessions, refresh } = useWorkspace();

  const dirPath = searchParams.get("dir") ?? "";
  const artifactPath = searchParams.get("artifact") ?? "";
  const chatSessionId = searchParams.get("chat") ?? "";
  const splitParam = searchParams.get("split");

  const workspace = useMemo<WorkspaceDTO | null>(
    () => findWorkspace(workspaces, workspacePath),
    [workspaces, workspacePath],
  );

  // Sessions that belong directly to this workspace (not its descendants).
  const wsKey = pathKey(workspacePath);
  const viewSessions = useMemo(
    () => sessions.filter((s) => pathKey(s.workspacePath) === wsKey),
    [sessions, wsKey],
  );

  // ---- URL helpers --------------------------------------------------------

  const updateParams = useCallback(
    (next: WorkspaceParams, opts?: { replace?: boolean }) => {
      const url = `${pathname}${buildWorkspaceQuery(next)}`;
      if (opts?.replace) router.replace(url, { scroll: false });
      else router.push(url);
    },
    [pathname, router],
  );

  const currentParams: WorkspaceParams = useMemo(
    () => ({
      dir: dirPath || undefined,
      artifact: artifactPath || undefined,
      chat: chatSessionId || undefined,
      split: splitParam ? Number(splitParam) : undefined,
    }),
    [dirPath, artifactPath, chatSessionId, splitParam],
  );

  // Remember the current view so the sidebar can restore it on next visit.
  // Persist for every workspace (root or deeply nested) so "click in sidebar"
  // always lands the user where they left off.
  useEffect(() => {
    if (workspacePath.length === 0) return;
    saveWorkspacePath(workspacePath, `${pathname}${buildWorkspaceQuery(currentParams)}`);
  }, [workspacePath, pathname, currentParams]);

  // ---- Files --------------------------------------------------------------

  const [files, setFiles] = useState<Entry[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const [renamingPath, setRenamingPath] = useState<{ path: string; type: "file" | "folder" } | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const encodedWorkspace = useMemo(() => encodeWorkspacePath(workspacePath), [workspacePath]);

  const refreshFiles = useCallback(async () => {
    if (workspacePath.length === 0) return;
    const r = await fetch(`/api/workspaces/files/${encodedWorkspace}`, { cache: "no-store" });
    const j = await r.json();
    const meta: { path: string; mtime: number }[] | null = j.filesMeta ?? null;
    if (meta) {
      setFiles(meta.map((m) => ({
        type: "file",
        name: m.path.split("/").pop() ?? m.path,
        path: m.path,
        mtime: m.mtime,
      })));
    } else {
      const paths: string[] = j.files ?? [];
      setFiles(paths.map((p) => ({ type: "file", name: p.split("/").pop() ?? p, path: p })));
    }
  }, [encodedWorkspace, workspacePath.length]);

  const refreshCommentCounts = useCallback(async () => {
    if (workspacePath.length === 0) return;
    const r = await fetch(
      `/api/comments/counts?workspace=${encodedWorkspace}`,
      { cache: "no-store" },
    );
    const j = await r.json();
    setCommentCounts(j.counts ?? {});
  }, [encodedWorkspace, workspacePath.length]);

  useEffect(() => {
    // Initial load of the artifact list + comment counts; both set state from
    // the fetch — the intended data-fetch-on-mount pattern.
    refreshFiles();
    refreshCommentCounts();
  }, [refreshFiles, refreshCommentCounts]);

  // Ref-indirection to openArtifact so the SSE effect below can call it
  // without depending on its identity (which would tear down the EventSource
  // every time selection state changes). Assigned right where openArtifact
  // is defined further down.
  const openArtifactRef = useRef<((p: string) => void) | null>(null);

  // Keep the artifacts list live: refresh whenever a file changes in this
  // workspace, and react to open_artifact requests from any agent here
  // (workbench-session.open_artifact tool → SSE → here → openArtifact).
  useEffect(() => {
    if (workspacePath.length === 0) return;
    const es = new EventSource(
      `/api/file-events/stream?workspace=${encodedWorkspace}`,
    );
    es.addEventListener("file_changed", () => {
      refreshFiles();
      refreshCommentCounts();
    });
    es.addEventListener("open_artifact", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { path?: string };
        if (data.path) openArtifactRef.current?.(data.path);
      } catch { /* ignore parse errors */ }
    });
    return () => es.close();
  }, [encodedWorkspace, workspacePath.length, refreshFiles, refreshCommentCounts]);

  // Flatten file paths into entries for the current directory, sorted by
  // recency (most recently modified first). A folder's recency is the newest
  // mtime among its contents.
  const entries = useMemo<Entry[]>(() => {
    const prefix = dirPath ? dirPath.replace(/\/+$/, "") + "/" : "";
    const seenFolders = new Map<string, { count: number; mtime: number }>();
    const out: Entry[] = [];
    for (const f of files) {
      if (!f.path.startsWith(prefix)) continue;
      const rest = f.path.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash < 0) {
        out.push({ type: "file", name: rest, path: f.path, mtime: f.mtime ?? 0 });
      } else {
        const folderName = rest.slice(0, slash);
        const prev = seenFolders.get(folderName) ?? { count: 0, mtime: 0 };
        seenFolders.set(folderName, {
          count: prev.count + 1,
          mtime: Math.max(prev.mtime, f.mtime ?? 0),
        });
      }
    }
    const folderEntries: Entry[] = [...seenFolders.entries()].map(([name, info]) => ({
      type: "folder",
      name,
      path: (prefix + name).replace(/\/+$/, ""),
      count: info.count,
      mtime: info.mtime,
    }));
    const isRoot = !dirPath;
    // workspace.json is the on-disk brief — hide it from the artifacts list so
    // the user only sees files they actually authored.
    const hiddenAtRoot = "workspace.json";
    const byRecency = (a: Entry, b: Entry) =>
      (b.mtime ?? 0) - (a.mtime ?? 0) || a.name.localeCompare(b.name);
    const folders = folderEntries.sort(byRecency);
    const filesAtLevel = out
      .filter((e) => !(isRoot && e.name === hiddenAtRoot))
      .sort(byRecency);
    return [...folders, ...filesAtLevel];
  }, [files, dirPath]);

  const breadcrumb = useMemo(() => {
    if (!dirPath) return [{ name: "Artifacts", path: "" }];
    const parts = dirPath.split("/").filter(Boolean);
    return [
      { name: "Artifacts", path: "" },
      ...parts.map((p, i) => ({ name: p, path: parts.slice(0, i + 1).join("/") })),
    ];
  }, [dirPath]);

  // ---- Expansion + split --------------------------------------------------

  const artifactExpanded = artifactPath.length > 0;
  const chatExpanded = chatSessionId.length > 0;
  const bothExpanded = artifactExpanded && chatExpanded;

  // Effective split (artifact column fraction). A user-dragged value (in the
  // URL) always wins; otherwise pick a sensible default per mode.
  let split: number;
  if (splitParam) {
    split = clampFraction(Number(splitParam));
  } else if (bothExpanded) {
    split = DEFAULT_EXPANDED_SPLIT;
  } else if (artifactExpanded) {
    split = 0.7;
  } else if (chatExpanded) {
    split = 0.3;
  } else {
    split = 0.5;
  }

  const setSplit = useCallback(
    (n: number) => {
      updateParams({ ...currentParams, split: clampFraction(n) }, { replace: true });
    },
    [updateParams, currentParams],
  );

  // Remember the list-mode split so closing the last expanded panel returns
  // the columns to where they were before anything was opened. `null` means
  // "no custom split — use the default."
  const listSplitRef = useRef<number | null>(null);

  // Open/close handlers manage the split: expanding from list mode stashes the
  // current (list) split and clears the param so the expanded view uses its
  // default; closing back to list mode restores the stashed split.
  const openArtifact = useCallback((p: string) => {
    const next: WorkspaceParams = { ...currentParams, artifact: p };
    if (!artifactExpanded && !chatExpanded) {
      listSplitRef.current = splitParam ? Number(splitParam) : null;
      next.split = undefined;
    }
    updateParams(next);
  }, [currentParams, splitParam, artifactExpanded, chatExpanded, updateParams]);
  // Keep the ref pointing at the latest openArtifact so the SSE effect can call
  // it without depending on its identity. Updated after commit (not during
  // render) to satisfy the rules-of-refs check.
  useEffect(() => { openArtifactRef.current = openArtifact; }, [openArtifact]);

  const closeArtifact = useCallback(() => {
    const next: WorkspaceParams = { ...currentParams, artifact: undefined };
    if (!chatExpanded) next.split = listSplitRef.current ?? undefined;
    updateParams(next);
  }, [currentParams, chatExpanded, updateParams]);

  const openSession = useCallback((id: string) => {
    const next: WorkspaceParams = { ...currentParams, chat: id };
    if (!artifactExpanded && !chatExpanded) {
      listSplitRef.current = splitParam ? Number(splitParam) : null;
      next.split = undefined;
    }
    updateParams(next);
  }, [currentParams, splitParam, artifactExpanded, chatExpanded, updateParams]);

  const closeSession = useCallback(() => {
    const next: WorkspaceParams = { ...currentParams, chat: undefined };
    if (!artifactExpanded) next.split = listSplitRef.current ?? undefined;
    updateParams(next);
  }, [currentParams, artifactExpanded, updateParams]);

  // ---- File drop ----------------------------------------------------------

  const handleFileDrop = useCallback(
    async (attachments: FileAttachment[]) => {
      if (workspacePath.length === 0 || attachments.length === 0) return;
      setUploading(true);
      setUploadError(null);
      const failed: string[] = [];
      try {
        for (const att of attachments) {
          const formData = new FormData();
          formData.append("file", att.file);
          const subdir = dirPath || "";
          const url = `/api/files/upload?workspace=${encodedWorkspace}${subdir ? `&subdir=${encodeURIComponent(subdir)}` : "&subdir="}`;
          try {
            const res = await fetch(url, { method: "POST", body: formData });
            if (!res.ok) {
              const j = await res.json().catch(() => ({}));
              failed.push(`${att.file.name}: ${j.error ?? `HTTP ${res.status}`}`);
            }
          } catch (err) {
            failed.push(`${att.file.name}: ${String(err)}`);
          }
        }
        refreshFiles();
      } finally {
        setUploading(false);
        if (failed.length > 0) {
          setUploadError(`Failed to upload ${failed.length} file${failed.length === 1 ? "" : "s"} — ${failed.join("; ")}`);
        }
      }
    },
    [encodedWorkspace, workspacePath.length, dirPath, refreshFiles],
  );

  // ---- Context menus / file management -----------------------------------

  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const startRename = (e: Entry) => {
    setRenamingPath({ path: e.path, type: e.type });
    setRenameValue(e.name);
  };

  const commitRename = async () => {
    if (!renamingPath) {
      setRenamingPath(null);
      return;
    }
    const newName = renameValue.trim();
    if (!newName || newName === renamingPath.path.split("/").pop()) {
      setRenamingPath(null);
      return;
    }
    const dir = renamingPath.path.includes("/")
      ? renamingPath.path.slice(0, renamingPath.path.lastIndexOf("/"))
      : "";
    const newPath = dir ? `${dir}/${newName}` : newName;
    const res = await fetch(`/api/files`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: workspacePath, from: renamingPath.path, to: newPath }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "rename failed");
    } else {
      refreshFiles();
    }
    setRenamingPath(null);
  };

  const deleteEntry = async (e: Entry) => {
    if (!confirm(e.type === "folder"
      ? `Delete folder "${e.name}" and everything in it?`
      : `Delete "${e.name}"?`)) return;
    const r = await fetch(
      `/api/files?workspace=${encodedWorkspace}&path=${encodeURIComponent(e.path)}`,
      { method: "DELETE" },
    );
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(j.error ?? "delete failed");
    } else {
      refreshFiles();
    }
  };

  const openEntryContextMenu = (e: React.MouseEvent, entry: Entry) => {
    e.preventDefault();
    // workspace.json is the on-disk brief — block rename/delete from the UI.
    if (entry.type === "file" && entry.path === "workspace.json") return;
    const items: MenuItem[] = [
      { label: "Rename", onClick: () => startRename(entry) },
      { label: "Delete", danger: true, onClick: () => deleteEntry(entry) },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // ---- Session management -------------------------------------------------

  const [renamingSession, setRenamingSession] = useState<string | null>(null);
  const [sessionRenameValue, setSessionRenameValue] = useState("");

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
      body: JSON.stringify({ workspace: workspacePath, name: newName }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "rename failed");
    }
    refresh();
  };

  const deleteSession = async (s: SessionSummaryDTO) => {
    if (!confirm(`Delete session "${s.title || s.id}"?`)) return;
    const res = await fetch(`/api/sessions/${s.id}/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: workspacePath }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "delete failed");
      return;
    }
    if (chatSessionId === s.id) {
      const next: WorkspaceParams = { ...currentParams, chat: undefined };
      if (!artifactExpanded) next.split = listSplitRef.current ?? undefined;
      updateParams(next);
    }
    refresh();
  };

  const backlogSession = async (s: SessionSummaryDTO, backlog: boolean) => {
    const res = await fetch(`/api/sessions/${s.id}/backlog`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: workspacePath, backlog }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "failed to update backlog state");
      return;
    }
    refresh();
  };

  const openSessionContextMenu = (e: React.MouseEvent, s: SessionSummaryDTO) => {
    e.preventDefault();
    const isRunning = s.state === "running" || s.state === "awaiting_input";
    const items: MenuItem[] = [
      { label: "Rename", onClick: () => startRenameSession(s) },
      {
        label: s.backlog ? "Move to active" : "Move to backlog",
        onClick: () => backlogSession(s, !s.backlog),
      },
      { label: "Delete", danger: true, onClick: () => deleteSession(s), disabled: isRunning },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // ---- Brief --------------------------------------------------------------

  const [showDetails, setShowDetails] = useState(false);

  const brief = useMemo(() => {
    if (!workspace) return null;
    if (!workspace.overview && !workspace.details) return null;
    return { overview: workspace.overview, details: workspace.details };
  }, [workspace]);

  // ---- New-session composer ----------------------------------------------

  // Persist the new-session draft in localStorage (like the in-session
  // composer) so typed text survives navigation/reload. Keyed per workspace
  // chain; "new-" prefix can't collide with real session ids.
  const [draft, setDraft] = useStickyDraft(`new-${pathKey(workspacePath)}`);
  const [starting, setStarting] = useState(false);
  const [runtime, setRuntime] = useState<SessionRuntime>("claude");
  const [effort, setEffort] = useState<EffortLevel | "">("");
  const [newAttachments, setNewAttachments] = useState<FileAttachment[]>([]);
  const [startError, setStartError] = useState<string | null>(null);

  const addNewAttachments = useCallback((files: FileAttachment[]) => {
    setNewAttachments((prev) => [...prev, ...files]);
  }, []);
  const removeNewAttachment = useCallback((id: string) => {
    setNewAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const startSession = async () => {
    if ((!draft.trim() && newAttachments.length === 0) || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      // Upload any attachments first, then reference them on the first message.
      const uploadedFiles: { name: string; path: string; mimeType: string; size: number }[] = [];
      if (newAttachments.length > 0) {
        const failed: string[] = [];
        for (const att of newAttachments) {
          const formData = new FormData();
          formData.append("file", att.file);
          const upUrl = `/api/files/upload?workspace=${encodedWorkspace}`;
          try {
            const res = await fetch(upUrl, { method: "POST", body: formData });
            if (res.ok) {
              const data = await res.json();
              uploadedFiles.push({ name: data.name, path: data.path, mimeType: data.mimeType, size: data.size });
            } else {
              const e = await res.json().catch(() => ({}));
              failed.push(`${att.file.name}: ${e.error ?? `HTTP ${res.status}`}`);
            }
          } catch (err) {
            failed.push(`${att.file.name}: ${String(err)}`);
          }
        }
        if (failed.length > 0) {
          setStartError(`Couldn't upload ${failed.length} file${failed.length === 1 ? "" : "s"} — ${failed.join("; ")}`);
          setStarting(false);
          return;
        }
      }

      const url = `/api/workspaces/sessions/${encodedWorkspace}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: draft.trim() || "(attached files)",
          runtime,
          ...(effort ? { effort } : {}),
          ...(artifactExpanded ? { openArtifact: artifactPath } : {}),
          ...(uploadedFiles.length > 0 ? { files: uploadedFiles } : {}),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.id) {
        setDraft("");
        setNewAttachments([]);
        const next: WorkspaceParams = { ...currentParams, chat: j.id };
        if (!artifactExpanded && !chatExpanded) {
          listSplitRef.current = splitParam ? Number(splitParam) : null;
          next.split = undefined;
        }
        updateParams(next);
        refresh();
      } else {
        setStartError(j.error ?? `Failed to start session (HTTP ${r.status})`);
      }
    } catch (err) {
      setStartError(String(err));
    } finally {
      setStarting(false);
    }
  };

  // ---- Mark session as seen when expanded --------------------------------

  const markedSeenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chatSessionId) {
      markedSeenRef.current = null;
      return;
    }
    if (markedSeenRef.current === chatSessionId) return;
    const s = sessions.find((x) => x.id === chatSessionId);
    if (!s || !s.unread) return;
    markedSeenRef.current = chatSessionId;
    fetch(`/api/sessions/${chatSessionId}/seen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: workspacePath }),
    }).then(() => refresh());
  }, [chatSessionId, sessions, workspacePath, refresh]);

  // ---- Archive toggle -----------------------------------------------------

  const toggleArchived = async () => {
    if (!workspace) return;
    await fetch(`/api/workspaces/status/${encodedWorkspace}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: workspace.status === "active" ? "archived" : "active" }),
    });
    refresh();
  };

  // ---- Loading state ------------------------------------------------------

  if (workspacePath.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--muted)]">
        Pick a workspace on the left.
      </div>
    );
  }
  if (!workspace) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--muted)]">
        {workspaces.length === 0 ? "Loading..." : "Workspace not found"}
      </div>
    );
  }

  // ---- Renderable session list (sorted recent first, capped) -------------

  const sortedSessions = [...viewSessions].sort((a, b) =>
    a.lastActivity < b.lastActivity ? 1 : -1,
  );

  // Selected expanded session
  const expandedSession = chatSessionId
    ? sessions.find((s) => s.id === chatSessionId) ?? null
    : null;

  const childCount = workspace.children.length;

  return (
    <>
      {/* Header */}
      <header className="h-14 border-b border-[var(--border)] flex items-center px-6 gap-3 shrink-0">
        <div className="flex-1 min-w-0">
          <div className="text-[14px] truncate flex items-center gap-1.5">
            {workspacePath.slice(0, -1).map((slug, i) => {
              const parentPath = workspacePath.slice(0, i + 1);
              return (
                <span key={i} className="flex items-center gap-1.5">
                  <Link href={workspaceRoute(parentPath)} className="text-[var(--muted)] hover:text-[var(--text)]">
                    {slug}
                  </Link>
                  <span className="text-[var(--muted)]">›</span>
                </span>
              );
            })}
            <span className={workspace.status === "archived" ? "text-[var(--muted)] line-through" : ""}>
              {workspace.slug}
            </span>
          </div>
          <div className="text-[11.5px] text-[var(--muted)]">
            workspace{childCount > 0 ? ` · ${childCount} child${childCount === 1 ? "" : "ren"}` : ""}
          </div>
        </div>
        <button
          onClick={toggleArchived}
          className="text-[12px] text-[var(--text-soft)] border border-[var(--border-strong)] rounded-lg px-3 py-1.5 hover:bg-[var(--panel-2)]"
        >
          {workspace.status === "active" ? "🗄 Archive" : "↺ Unarchive"}
        </button>
      </header>

      {/* Brief — spans both columns */}
      {brief && (
        <div className="border-b border-[var(--border)] bg-[var(--panel)] px-6 py-3 shrink-0">
          <div className="max-w-[1200px] mx-auto">
            <div className="flex items-start gap-3">
              <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] font-medium pt-1 shrink-0">
                Workspace
              </div>
              <div className="flex-1 min-w-0">
                {brief.overview && (
                  <div className="text-[13px] leading-relaxed text-[var(--text)]">
                    {brief.overview}
                  </div>
                )}
                {brief.details && (
                  <>
                    <button
                      onClick={() => setShowDetails((s) => !s)}
                      className="text-[11px] text-[var(--muted)] hover:text-[var(--text)] inline-flex items-center gap-1 mt-1"
                    >
                      <span>{showDetails ? "▾" : "▸"}</span>
                      <span>{showDetails ? "Hide details" : "Show details"}</span>
                    </button>
                    {showDetails && (
                      <div className="text-[var(--text-soft)] text-[12.5px] pt-1 max-h-[280px] overflow-y-auto">
                        <Markdown text={brief.details} />
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Two columns */}
      <SplitColumns
        split={split}
        onSplit={setSplit}
        showResizer
        leftMinWidth={!artifactExpanded && chatExpanded ? LIST_MIN_WIDTH : undefined}
        rightMinWidth={!chatExpanded && artifactExpanded ? LIST_MIN_WIDTH : undefined}
        left={
          <ArtifactsColumn
            workspacePath={workspacePath}
            expanded={artifactExpanded}
            artifactPath={artifactPath}
            dirPath={dirPath}
            entries={entries}
            breadcrumb={breadcrumb}
            commentCounts={commentCounts}
            uploading={uploading}
            uploadError={uploadError}
            onUploadError={setUploadError}
            renamingPath={renamingPath}
            renameValue={renameValue}
            onRenameValue={setRenameValue}
            onRenameCommit={commitRename}
            onRenameCancel={() => setRenamingPath(null)}
            onContextMenu={openEntryContextMenu}
            onNavigateDir={(p) => {
              const next: WorkspaceParams = { ...currentParams, dir: p || undefined, artifact: undefined };
              if (!chatExpanded) next.split = listSplitRef.current ?? undefined;
              updateParams(next);
            }}
            onOpenFile={openArtifact}
            onCloseArtifact={closeArtifact}
            onFileDrop={handleFileDrop}
          />
        }
        right={
          <SessionsColumn
            workspacePath={workspacePath}
            workspace={workspace}
            expanded={chatExpanded}
            expandedSession={expandedSession}
            openArtifactPath={artifactExpanded ? artifactPath : undefined}
            sessions={sortedSessions}
            renamingSession={renamingSession}
            sessionRenameValue={sessionRenameValue}
            onSessionRenameValue={setSessionRenameValue}
            onSessionRenameCommit={commitSessionRename}
            onSessionRenameCancel={() => setRenamingSession(null)}
            onSessionContextMenu={openSessionContextMenu}
            onOpenSession={openSession}
            onCloseSession={closeSession}
            onChange={refresh}
            draft={draft}
            onDraft={setDraft}
            onStart={startSession}
            starting={starting}
            attachments={newAttachments}
            onAttach={addNewAttachments}
            onRemoveAttachment={removeNewAttachment}
            startError={startError}
            onStartError={setStartError}
            runtime={runtime}
            onRuntime={setRuntime}
            effort={effort}
            onEffort={setEffort}
          />
        }
      />

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// SplitColumns — two columns with optional resizer
// ---------------------------------------------------------------------------

function SplitColumns({
  split,
  onSplit,
  showResizer,
  leftMinWidth,
  rightMinWidth,
  left,
  right,
}: {
  split: number;
  onSplit: (n: number) => void;
  showResizer: boolean;
  /** Minimum px width for the left column (e.g. when it's a collapsed list). */
  leftMinWidth?: number;
  /** Minimum px width for the right column. */
  rightMinWidth?: number;
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // While dragging we drive the split from local state for a smooth, 1:1 feel
  // and only commit to the URL on release (avoids history spam + re-render lag).
  const [dragSplit, setDragSplit] = useState<number | null>(null);
  const dragSplitRef = useRef<number | null>(null);

  useEffect(() => {
    if (!showResizer) return;
    const onMove = (e: MouseEvent) => {
      if (dragSplitRef.current === null) return;
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const fraction = Math.min(MAX_COLUMN_FRACTION, Math.max(MIN_COLUMN_FRACTION, (e.clientX - r.left) / r.width));
      dragSplitRef.current = fraction;
      setDragSplit(fraction);
    };
    const onUp = () => {
      if (dragSplitRef.current !== null) {
        onSplit(dragSplitRef.current);
        dragSplitRef.current = null;
        setDragSplit(null);
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [showResizer, onSplit]);

  const isDragging = dragSplit !== null;
  const effectiveSplit = dragSplit ?? split;
  const leftPercent = `${(effectiveSplit * 100).toFixed(2)}%`;
  // Animate width on mode changes (expand/collapse), but never while dragging.
  const widthTransition = isDragging ? "" : "transition-[width] duration-200 ease-out";

  return (
    <div ref={containerRef} className="flex-1 min-h-0 flex">
      <div
        className={`flex flex-col min-w-0 min-h-0 ${widthTransition}`}
        style={{ width: leftPercent, minWidth: leftMinWidth }}
      >
        {left}
      </div>
      {/* Resizer: a 1px hairline with a wide (12px) transparent grab zone so
          it's easy to grab. Negative margins keep its layout footprint at the
          hairline width while the hit area straddles both columns. */}
      <div
        onMouseDown={() => {
          if (!showResizer) return;
          dragSplitRef.current = effectiveSplit;
          setDragSplit(effectiveSplit);
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        className={`group relative z-10 shrink-0 w-3 -mx-1.5 flex justify-center ${showResizer ? "cursor-col-resize" : ""}`}
        aria-hidden
        title={showResizer ? "Drag to resize" : undefined}
      >
        <div className={`w-px h-full bg-[var(--border)] ${isDragging ? "bg-[var(--accent)] w-0.5" : "transition-all"} ${showResizer && !isDragging ? "group-hover:w-0.5 group-hover:bg-[var(--accent)]" : ""}`} />
      </div>
      <div
        className={`flex flex-col min-w-0 min-h-0 flex-1 ${widthTransition}`}
        style={{ minWidth: rightMinWidth }}
      >
        {right}
      </div>
      {/* While dragging, a transparent full-screen overlay sits above any
          iframes (e.g. the artifact preview) so the cursor's mousemove/mouseup
          keep firing in the parent document instead of being swallowed by the
          iframe — otherwise the resize freezes over the artifact. */}
      {isDragging && (
        <div className="fixed inset-0 z-50" style={{ cursor: "col-resize" }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ArtifactsColumn
// ---------------------------------------------------------------------------

interface ArtifactsColumnProps {
  workspacePath: string[];
  expanded: boolean;
  artifactPath: string;
  dirPath: string;
  entries: Entry[];
  breadcrumb: { name: string; path: string }[];
  commentCounts: Record<string, number>;
  uploading: boolean;
  uploadError: string | null;
  onUploadError: (message: string) => void;
  renamingPath: { path: string; type: "file" | "folder" } | null;
  renameValue: string;
  onRenameValue: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onContextMenu: (e: React.MouseEvent, entry: Entry) => void;
  onNavigateDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onCloseArtifact: () => void;
  onFileDrop: (files: FileAttachment[]) => void;
}

function ArtifactsColumn(props: ArtifactsColumnProps) {
  const {
    workspacePath, expanded, artifactPath, dirPath, entries, breadcrumb,
    commentCounts, uploading, uploadError, onUploadError, renamingPath, renameValue,
    onRenameValue, onRenameCommit, onRenameCancel, onContextMenu,
    onNavigateDir, onOpenFile, onCloseArtifact, onFileDrop,
  } = props;
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? entries : entries.slice(0, PAGE_SIZE);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  if (expanded) {
    return (
      <>
        <div className="h-10 px-3 border-b border-[var(--border)] flex items-center gap-2 shrink-0 bg-[var(--bg-2)]">
          <button
            onClick={onCloseArtifact}
            title="Close artifact"
            className="text-[var(--muted)] hover:text-[var(--text)] text-[14px] leading-none w-6 h-6 rounded hover:bg-[var(--panel-2)] flex items-center justify-center"
          >×</button>
          <div className="flex-1 min-w-0 text-[12.5px] font-mono truncate" title={artifactPath}>
            {artifactPath}
          </div>
        </div>
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <FileViewer
            workspacePath={workspacePath}
            filePath={artifactPath}
          />
        </div>
      </>
    );
  }

  const Body = (
    <div className="flex-1 overflow-y-auto px-3 py-3">
      {/* Breadcrumb only when inside a subfolder — at the root it would just
          duplicate the column header above. */}
      {dirPath && (
        <div className="flex items-center gap-1.5 mb-2 px-1 text-[12px] uppercase tracking-wider text-[var(--muted)] font-medium">
          {breadcrumb.map((b, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-[var(--border-strong)]">/</span>}
              <button
                onClick={() => onNavigateDir(b.path)}
                disabled={i === breadcrumb.length - 1}
                className={`${i === breadcrumb.length - 1 ? "text-[var(--text)] cursor-default" : "hover:text-[var(--text)]"} normal-case tracking-normal text-[12.5px]`}
              >{i === 0 ? "Artifacts" : b.name}</button>
            </span>
          ))}
          <span className="ml-2 text-[var(--muted)] normal-case tracking-normal">· {entries.length}{uploading && " (uploading…)"}</span>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="text-[13px] text-[var(--muted)] italic px-1">
          Drop files here or start empty.
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            {visible.map((e) => {
              const commentCount = e.type === "file"
                ? (commentCounts[e.path] ?? 0)
                : Object.entries(commentCounts).reduce((acc, [p, n]) => p.startsWith(e.path + "/") ? acc + n : acc, 0);

              if (renamingPath?.path === e.path) {
                return (
                  <div
                    key={e.path}
                    className="w-full text-left rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 flex items-center gap-2.5"
                  >
                    <span className="text-[16px] shrink-0">
                      {e.type === "folder" ? "📁" : iconForFile(e.path)}
                    </span>
                    <input
                      autoFocus
                      value={renameValue}
                      onClick={(ev) => ev.stopPropagation()}
                      onChange={(ev) => onRenameValue(ev.target.value)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") onRenameCommit();
                        else if (ev.key === "Escape") onRenameCancel();
                        ev.stopPropagation();
                      }}
                      onBlur={onRenameCommit}
                      className="flex-1 bg-transparent border-b border-[var(--accent)] outline-none text-[13px] py-0.5"
                    />
                  </div>
                );
              }

              const isExpandedFile = e.type === "file" && e.path === artifactPath;
              return (
                <button
                  key={e.path}
                  onClick={() => e.type === "folder" ? onNavigateDir(e.path) : onOpenFile(e.path)}
                  onContextMenu={(ev) => onContextMenu(ev, e)}
                  className={`w-full text-left rounded-xl border bg-[var(--panel)] hover:bg-[var(--panel-2)] px-3 py-2 transition flex items-center gap-2.5 cursor-pointer ${isExpandedFile ? "border-[var(--accent)] ring-1 ring-[var(--accent)]" : "border-[var(--border)]"}`}
                >
                  <span className="text-[16px] shrink-0">
                    {e.type === "folder" ? "📁" : iconForFile(e.path)}
                  </span>
                  <span className="text-[13px] truncate flex-1">
                    {e.name}
                    {e.type === "folder" && (
                      <span className="text-[var(--muted)] ml-1.5 text-[11px]">{e.count} item{e.count === 1 ? "" : "s"}</span>
                    )}
                  </span>
                  {commentCount > 0 && (
                    <span
                      className="shrink-0 text-[10.5px] bg-[var(--accent-soft)] text-[var(--accent)] font-medium rounded-md px-1.5 py-0.5"
                      title={`${commentCount} comment${commentCount === 1 ? "" : "s"}`}
                    >💬 {commentCount}</span>
                  )}
                </button>
              );
            })}
          </div>
          {!showAll && entries.length > PAGE_SIZE && (
            <button
              onClick={() => setShowAll(true)}
              className="mt-3 text-[12px] text-[var(--accent)] hover:text-[var(--text)] px-3 py-1.5 rounded-md border border-[var(--border)] hover:border-[var(--accent)] transition w-full"
            >
              View {entries.length - PAGE_SIZE} more
            </button>
          )}
        </>
      )}
    </div>
  );

  return (
    <>
      <div className="h-10 px-3 border-b border-[var(--border)] flex items-center gap-2 shrink-0 bg-[var(--bg-2)]">
        <span className="text-[12px] uppercase tracking-wider text-[var(--muted)] font-semibold">
          Artifacts
        </span>
        <span className="text-[11px] text-[var(--muted)]">· {entries.length}{uploading && " (uploading…)"}</span>
        <input
          ref={uploadInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={async (e) => {
            const picked = e.target.files;
            if (picked && picked.length > 0) {
              onFileDrop(await filesToAttachments(picked, undefined, onUploadError));
            }
            e.target.value = "";
          }}
        />
        <button
          onClick={() => uploadInputRef.current?.click()}
          disabled={uploading}
          title="Upload files"
          aria-label="Upload files"
          className="ml-auto text-[var(--muted)] hover:text-[var(--accent)] w-6 h-6 rounded hover:bg-[var(--panel-2)] flex items-center justify-center disabled:opacity-40 transition"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </button>
      </div>
      {uploadError && (
        <div className="px-3 py-2 border-b border-[var(--border)] bg-[var(--warn-soft)] text-[var(--warn)] text-[12px] flex items-start gap-2 shrink-0">
          <span className="flex-1">{uploadError}</span>
          <button onClick={() => onUploadError("")} title="Dismiss" className="shrink-0 hover:opacity-70">×</button>
        </div>
      )}
      <FileDropZone onFiles={onFileDrop} onError={onUploadError} disabled={uploading} className="flex-1 min-h-0 flex flex-col">
        {Body}
      </FileDropZone>
    </>
  );
}

// ---------------------------------------------------------------------------
// SessionsColumn
// ---------------------------------------------------------------------------

interface SessionsColumnProps {
  workspacePath: string[];
  workspace: WorkspaceDTO;
  expanded: boolean;
  expandedSession: SessionSummaryDTO | null;
  /** Artifact path open in the other column, if any — forwarded to Chat. */
  openArtifactPath?: string;
  sessions: SessionSummaryDTO[];
  renamingSession: string | null;
  sessionRenameValue: string;
  onSessionRenameValue: (v: string) => void;
  onSessionRenameCommit: () => void;
  onSessionRenameCancel: () => void;
  onSessionContextMenu: (e: React.MouseEvent, s: SessionSummaryDTO) => void;
  onOpenSession: (id: string) => void;
  onCloseSession: () => void;
  onChange: () => void;
  draft: string;
  onDraft: (v: string) => void;
  onStart: () => void;
  starting: boolean;
  attachments: FileAttachment[];
  onAttach: (files: FileAttachment[]) => void;
  onRemoveAttachment: (id: string) => void;
  startError: string | null;
  onStartError: (message: string) => void;
  runtime: SessionRuntime;
  onRuntime: (r: SessionRuntime) => void;
  effort: EffortLevel | "";
  onEffort: (e: EffortLevel | "") => void;
}

function SessionsColumn(props: SessionsColumnProps) {
  const {
    workspacePath, workspace, expanded, expandedSession, openArtifactPath, sessions,
    renamingSession, sessionRenameValue,
    onSessionRenameValue, onSessionRenameCommit, onSessionRenameCancel,
    onSessionContextMenu, onOpenSession, onCloseSession, onChange,
    draft, onDraft, onStart, starting,
    attachments, onAttach, onRemoveAttachment, startError, onStartError,
    runtime, onRuntime, effort, onEffort,
  } = props;

  const [showAllSessions, setShowAllSessions] = useState(false);
  const [showAllChildren, setShowAllChildren] = useState(false);
  const newAttachInputRef = useRef<HTMLInputElement>(null);

  if (expanded && expandedSession) {
    return (
      <Chat
        session={expandedSession}
        onChange={onChange}
        onBack={onCloseSession}
        embedded
        openArtifactPath={openArtifactPath}
      />
    );
  }

  if (expanded && !expandedSession) {
    return (
      <>
        <div className="h-10 px-3 border-b border-[var(--border)] flex items-center gap-2 shrink-0 bg-[var(--bg-2)]">
          <button
            onClick={onCloseSession}
            title="Close"
            className="text-[var(--muted)] hover:text-[var(--text)] text-[14px] leading-none w-6 h-6 rounded hover:bg-[var(--panel-2)] flex items-center justify-center"
          >×</button>
          <span className="text-[12px] uppercase tracking-wider text-[var(--muted)] font-semibold">
            Chat
          </span>
        </div>
        <div className="flex-1 flex items-center justify-center text-[var(--muted)] text-[13px]">
          Loading session…
        </div>
      </>
    );
  }

  const allChildren = [...workspace.children].sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return a.slug.localeCompare(b.slug);
  });
  const visibleChildren = showAllChildren ? allChildren : allChildren.slice(0, PAGE_SIZE);

  const visibleSessions = showAllSessions ? sessions : sessions.slice(0, PAGE_SIZE);

  return (
    <>
      <div className="h-10 px-3 border-b border-[var(--border)] flex items-center gap-2 shrink-0 bg-[var(--bg-2)]">
        <span className="text-[12px] uppercase tracking-wider text-[var(--muted)] font-semibold">
          {workspace.children.length > 0 ? "Workspaces & Sessions" : "Sessions"}
        </span>
        <span className="text-[11px] text-[var(--muted)]">· {sessions.length}</span>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {/* Child workspaces, if any */}
        {workspace.children.length > 0 && (
          <div>
            <div className="text-[11px] uppercase tracking-wider text-[var(--muted)] font-medium mb-1.5 px-1">
              Child workspaces <span className="normal-case tracking-normal">· {workspace.children.length}</span>
            </div>
            <div className="space-y-1">
              {visibleChildren.map((child) => (
                <Link
                  key={child.slug}
                  href={workspaceRoute([...workspacePath, child.slug])}
                  className="block w-full text-left rounded-lg border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel-2)] px-3 py-2 transition"
                >
                  <span className={`text-[13px] truncate block ${child.status === "archived" ? "text-[var(--muted)] line-through" : ""}`}>
                    {child.slug}
                  </span>
                </Link>
              ))}
            </div>
            {!showAllChildren && allChildren.length > PAGE_SIZE && (
              <button
                onClick={() => setShowAllChildren(true)}
                className="mt-2 text-[12px] text-[var(--accent)] hover:text-[var(--text)] px-3 py-1.5 rounded-md border border-[var(--border)] hover:border-[var(--accent)] transition w-full"
              >
                View {allChildren.length - PAGE_SIZE} more
              </button>
            )}
          </div>
        )}

        {/* Sessions */}
        <div>
          <div className="text-[11px] uppercase tracking-wider text-[var(--muted)] font-medium mb-1.5 px-1">
            Sessions
          </div>
          {sessions.length === 0 ? (
            <div className="text-[12.5px] text-[var(--muted)] italic px-1">
              No agents have worked on this workspace yet. Send one with the composer below.
            </div>
          ) : (
            <>
              <div className="space-y-1">
                {visibleSessions.map((s) => {
                  const isRenaming = renamingSession === s.id;
                  const label = sessionLabel(s);
                  const color = sessionColor(s);
                  if (isRenaming) {
                    return (
                      <div
                        key={s.id}
                        className={`block w-full text-left rounded-lg border bg-[var(--panel)] px-3 py-2 ${s.unread ? "border-[var(--accent)] border-l-4" : s.completed ? "border-[var(--ok)]" : "border-[var(--border)]"}`}
                      >
                        <div className="flex items-center gap-2">
                          <SessionStateIcon session={s} />
                          <input
                            autoFocus
                            value={sessionRenameValue}
                            onClick={(ev) => ev.stopPropagation()}
                            onChange={(ev) => onSessionRenameValue(ev.target.value)}
                            onKeyDown={(ev) => {
                              if (ev.key === "Enter") onSessionRenameCommit();
                              else if (ev.key === "Escape") onSessionRenameCancel();
                              ev.stopPropagation();
                            }}
                            onBlur={onSessionRenameCommit}
                            className="flex-1 bg-transparent border-b border-[var(--accent)] outline-none text-[13px] py-0.5"
                            placeholder="Session name"
                          />
                          <span className="text-[11px] text-[var(--muted)] shrink-0">
                            {formatRelative(s.lastActivity)}
                          </span>
                          <span className="text-[11px] whitespace-nowrap shrink-0" style={{ color }}>
                            · {label}
                          </span>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <button
                      key={s.id}
                      onClick={() => onOpenSession(s.id)}
                      onContextMenu={(ev) => onSessionContextMenu(ev, s)}
                      className={`block w-full text-left rounded-lg border bg-[var(--panel)] hover:bg-[var(--panel-2)] px-3 py-2 transition ${s.unread ? "border-[var(--accent)] border-l-4" : s.completed ? "border-[var(--ok)]" : "border-[var(--border)]"}`}
                    >
                      <div className="flex items-center gap-2">
                        <SessionStateIcon session={s} />
                        <span className={`text-[13px] truncate flex-1 ${s.completed ? "text-[var(--muted)]" : s.unread ? "font-semibold" : ""}`}>{s.title || "(no message)"}</span>
                        {s.unread && !s.completed && (
                          <span className="shrink-0 text-[9.5px] bg-[var(--accent)] text-[var(--accent-text)] font-medium rounded-md px-1.5 py-0.5">
                            NEW
                          </span>
                        )}
                        {s.completed && (
                          <span className="shrink-0 text-[9.5px] bg-[var(--ok-soft)] text-[var(--ok)] font-medium rounded-md px-1.5 py-0.5">
                            ✓
                          </span>
                        )}
                        {s.backlog && !s.completed && (
                          <span className="shrink-0 text-[9.5px] bg-[var(--panel-2)] text-[var(--muted)] font-medium rounded-md px-1.5 py-0.5" title="Backlog — waiting on something external">
                            ⏸ backlog
                          </span>
                        )}
                        <span className="text-[10.5px] text-[var(--muted)] shrink-0">
                          {formatRelative(s.lastActivity)}
                        </span>
                        {!s.completed && (
                          <span className="text-[10.5px] whitespace-nowrap shrink-0" style={{ color }}>
                            · {label}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
              {!showAllSessions && sessions.length > PAGE_SIZE && (
                <button
                  onClick={() => setShowAllSessions(true)}
                  className="mt-2 text-[12px] text-[var(--accent)] hover:text-[var(--text)] px-3 py-1.5 rounded-md border border-[var(--border)] hover:border-[var(--accent)] transition w-full"
                >
                  View {sessions.length - PAGE_SIZE} more
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* New-session composer (hidden when chat expanded) */}
      <div className="border-t border-[var(--border)] px-3 py-3 bg-[var(--bg)]">
        {startError && (
          <div className="mb-2 rounded-lg bg-[var(--warn-soft)] text-[var(--warn)] text-[12px] px-3 py-2 flex items-start gap-2">
            <span className="flex-1">{startError}</span>
            <button onClick={() => onStartError("")} title="Dismiss" className="shrink-0 hover:opacity-70">×</button>
          </div>
        )}
        <FileDropZone onFiles={onAttach} onError={onStartError} className="rounded-2xl">
          {attachments.length > 0 && (
            <div className="px-1 pb-2">
              <AttachmentPreview attachments={attachments} onRemove={onRemoveAttachment} compact />
            </div>
          )}
          <div className="rounded-2xl border border-[var(--border-strong)] bg-[var(--panel)] flex items-end gap-2 px-3 py-2 focus-within:border-[var(--accent)] transition">
            <input
              ref={newAttachInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={async (e) => {
                const picked = e.target.files;
                if (picked && picked.length > 0) {
                  onAttach(await filesToAttachments(picked, undefined, onStartError));
                }
                e.target.value = "";
              }}
            />
            <textarea
              value={draft}
              onChange={(e) => onDraft(e.target.value)}
              placeholder="Tell an agent what to do in this workspace…"
              rows={2}
              style={{ maxHeight: 200 }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 200) + "px";
              }}
              onKeyDown={(e) => handleComposerEnter(e, onStart)}
              onPaste={handleComposerPaste}
              className="flex-1 resize-none bg-transparent outline-none text-[13.5px] py-1 leading-relaxed"
            />
            <button
              onClick={() => newAttachInputRef.current?.click()}
              className="rounded-lg border border-[var(--border-strong)] text-[var(--text-soft)] hover:text-[var(--accent)] hover:border-[var(--accent)] w-9 h-9 flex items-center justify-center transition shrink-0 self-end"
              title="Attach files"
              aria-label="Attach files"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <button
              onClick={onStart}
              disabled={(!draft.trim() && attachments.length === 0) || starting}
              className="rounded-lg bg-[var(--accent)] text-[var(--accent-text)] w-9 h-9 flex items-center justify-center font-semibold disabled:opacity-40 hover:brightness-110 transition shrink-0 self-end"
              title="Start (↵)"
            >↑</button>
          </div>
        </FileDropZone>
        <div className="flex items-center justify-end gap-2 pt-1.5">
          <span className="text-[10.5px] text-[var(--muted)]">Agent:</span>
          <select
            value={runtime}
            onChange={(e) => onRuntime(e.target.value as SessionRuntime)}
            className="text-[10.5px] bg-transparent text-[var(--muted)] border border-[var(--border)] rounded px-1.5 py-0.5 outline-none focus:border-[var(--accent)] focus:text-[var(--text)] cursor-pointer"
          >
            <option value="claude">Claude</option>
            <option value="gemini">Gemini</option>
            <option value="cloud">Claude (Cloud)</option>
          </select>
          <span className="text-[10.5px] text-[var(--muted)]">Effort:</span>
          <select
            value={effort}
            onChange={(e) => onEffort(e.target.value as EffortLevel | "")}
            className="text-[10.5px] bg-transparent text-[var(--muted)] border border-[var(--border)] rounded px-1.5 py-0.5 outline-none focus:border-[var(--accent)] focus:text-[var(--text)] cursor-pointer disabled:opacity-50"
            title="Thinking effort (Claude only)"
            disabled={runtime !== "claude"}
          >
            <option value="">default</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
            <option value="max">max</option>
          </select>
        </div>
      </div>
    </>
  );
}

function SessionStateIcon({ session }: { session: SessionSummaryDTO }) {
  if (session.completed) {
    return (
      <span className="text-[var(--ok)] shrink-0 inline-flex" title="Completed">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    );
  }
  if (session.backlog) {
    return (
      <span className="text-[var(--muted)] shrink-0 inline-flex" title="Backlog — waiting on something external">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        </svg>
      </span>
    );
  }
  const st = effectiveState(session);
  if (st === "running") {
    return <WorkingIndicator size={11} />;
  }
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${sessionIsPending(session) ? "pulse" : ""}`}
      style={{ background: STATE_COLOR[st] }}
    />
  );
}
