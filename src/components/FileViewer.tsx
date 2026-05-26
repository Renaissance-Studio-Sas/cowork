"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
// rehype-raw intentionally omitted — see Chat.tsx for rationale.
import {
  captureSelectionAnchor,
  clearHighlights,
  locateAnchor,
  wrapRangeInMarks,
  type TextAnchor,
} from "@/lib/comment-anchor";
import { buildEnhancedHtml } from "@/lib/iframe-enhancer";
import { resolveRelative } from "@/lib/relative-path";
import { AgentPanel } from "./AgentPanel";
import { ChatPanel } from "./ChatPanel";
import { EmailThreadViewer, type ThreadRecord } from "./EmailThreadViewer";
import { Resizer } from "./Resizer";
import { handleComposerEnter } from "@/lib/composer";
import { taskFileRoute, taskSessionRoute, projectFileRoute, projectSessionRoute, saveTaskPath } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace-context";
import type { SessionSummaryDTO } from "@/lib/types";

const SESSION_STATE_COLOR: Record<string, string> = {
  awaiting_input: "var(--warn)",
  running: "var(--accent)",
  idle: "var(--warn)",
  stopped: "var(--warn)",
  error: "#dc2626",
};

type CommentTarget =
  | { kind: "session"; session: SessionSummaryDTO }
  | { kind: "new" };

const CHAT_PANEL_WIDTH_KEY = "wb-chat-panel-width";
const DEFAULT_CHAT_WIDTH = 380;
const MIN_CHAT_WIDTH = 280;
const MAX_CHAT_WIDTH = 600;

interface Props {
  projectSlug: string;
  taskSlug: string;
  filePath: string;
  onBack: () => void;
  /**
   * When true, the file viewer is hosted inside another layout (e.g. the
   * workspace artifact column). It skips its own page-level header and the
   * built-in chat side panel — the host renders those.
   */
  embedded?: boolean;
}

interface CommentRow {
  id: number;
  body: string;
  author: string;
  createdAt: string | number;
  updatedAt: string | number | null;
  resolvedAt: string | number | null;
  anchorType: "md" | "html";
  anchorData: Partial<TextAnchor> & { quote?: string };
}

interface ResolvedComment extends CommentRow {
  anchor: TextAnchor | null;
  resolved: { start: number; end: number } | null;
  obsolete: boolean;
}

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i < 0 ? "" : p.slice(i + 1).toLowerCase();
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const TEXT_EXT = new Set(["md", "markdown", "txt", "json", "csv", "yaml", "yml", "log"]);

export function FileViewer({ projectSlug, taskSlug, filePath, onBack, embedded = false }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Initialize sidebar states from URL search params
  const initialCommentsPanelOpen = searchParams.get("comments") === "1";
  const initialChatPanelOpen = searchParams.get("chat") === "1";

  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [panelOpen, setPanelOpen] = useState(initialCommentsPanelOpen);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingAnchor, setPendingAnchor] = useState<TextAnchor | null>(null);
  const [popover, setPopover] = useState<{ x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  // For HTML files, the iframe tells us which comments it could anchor.
  const [htmlObsoleteIds, setHtmlObsoleteIds] = useState<Set<number>>(new Set());
  // Chat panel state
  const [chatPanelOpen, setChatPanelOpen] = useState(initialChatPanelOpen);
  const [chatPanelWidth, setChatPanelWidth] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_CHAT_WIDTH;
    const stored = localStorage.getItem(CHAT_PANEL_WIDTH_KEY);
    return stored ? parseInt(stored, 10) : DEFAULT_CHAT_WIDTH;
  });

  // Update URL and save task path when sidebar states change.
  // Skip in embedded mode — the workspace owns the URL there.
  useEffect(() => {
    if (embedded) return;
    const params = new URLSearchParams();
    if (panelOpen) params.set("comments", "1");
    if (chatPanelOpen) params.set("chat", "1");
    const search = params.toString();
    const fullPath = search ? `${pathname}?${search}` : pathname;

    const newUrl = search ? `${pathname}?${search}` : pathname;
    window.history.replaceState(null, "", newUrl);

    if (taskSlug) {
      saveTaskPath(projectSlug, taskSlug, fullPath);
    }
  }, [panelOpen, chatPanelOpen, pathname, projectSlug, taskSlug, embedded]);
  const contentRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const ext = extOf(filePath);
  const isEmailThread = filePath.toLowerCase().endsWith(".emlthread.json");
  const isImage = IMAGE_EXT.has(ext);
  const isPdf = ext === "pdf";
  const isHtml = ext === "html" || ext === "htm";
  const isMd = ext === "md" || ext === "markdown";
  const isText = TEXT_EXT.has(ext) && !isEmailThread;
  const supportsComments = isMd || isHtml;
  const rawUrl = `/api/files/raw?project=${encodeURIComponent(projectSlug)}&task=${encodeURIComponent(taskSlug)}&path=${encodeURIComponent(filePath)}`;

  const { sessions } = useWorkspace();

  // --- Load file content --------------------------------------------------
  const refreshFile = useCallback(() => {
    if (isImage || isPdf) return;
    fetch(`/api/files?project=${encodeURIComponent(projectSlug)}&task=${encodeURIComponent(taskSlug)}&path=${encodeURIComponent(filePath)}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "failed");
        setText(j.content ?? "");
      })
      .catch((e) => setError(String(e)));
  }, [projectSlug, taskSlug, filePath, isImage, isPdf]);

  useEffect(() => {
    setText(null);
    setError(null);
    refreshFile();
  }, [refreshFile]);

  // --- Comments fetch -----------------------------------------------------
  const refreshComments = useCallback(async () => {
    if (!supportsComments) return;
    const r = await fetch(`/api/comments?project=${encodeURIComponent(projectSlug)}&task=${encodeURIComponent(taskSlug)}&path=${encodeURIComponent(filePath)}`);
    const j = await r.json();
    setComments(j.comments ?? []);
  }, [projectSlug, taskSlug, filePath, supportsComments]);

  // --- Auto-refresh when an agent modifies this file ----------------------
  // Subscribe to one multiplexed stream covering every live session in this
  // project/task. (Originally we opened one EventSource per session, which
  // exhausted the browser's per-origin connection limit on busy tasks.)
  useEffect(() => {
    const es = new EventSource(
      `/api/file-events/stream?project=${encodeURIComponent(projectSlug)}&task=${encodeURIComponent(taskSlug)}`,
    );
    es.addEventListener("file_changed", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { path?: string };
        // Event path is absolute from the SDK; filePath is relative to cwd.
        if (data.path && (data.path === filePath || data.path.endsWith(`/${filePath}`))) {
          refreshFile();
          refreshComments();
        }
      } catch { /* ignore parse errors */ }
    });
    return () => es.close();
  }, [projectSlug, taskSlug, filePath, refreshFile, refreshComments]);

  useEffect(() => {
    refreshComments();
    setDraft("");
    setPendingAnchor(null);
    setPopover(null);
    setContextMenu(null);
    setActiveId(null);
    setHtmlObsoleteIds(new Set());
  }, [projectSlug, taskSlug, filePath, refreshComments]);

  // --- Markdown: resolve anchors against the visible DOM text ------------
  const [renderTick, setRenderTick] = useState(0);
  useEffect(() => { setRenderTick((t) => t + 1); }, [text]);

  const resolvedComments = useMemo<ResolvedComment[]>(() => {
    void renderTick;
    if (isHtml) {
      return comments.map((c) => {
        const a = normalizeAnchor(c.anchorData);
        // Doc-wide comments (no anchor) are never obsolete — they apply to
        // the whole file regardless of edits.
        if (!a) return { ...c, anchor: null, resolved: null, obsolete: false };
        const obs = htmlObsoleteIds.has(c.id);
        return { ...c, anchor: a, resolved: obs ? null : { start: 0, end: 0 }, obsolete: obs };
      });
    }
    const root = contentRef.current;
    const visible = root?.textContent ?? "";
    return comments.map((c) => {
      const a = normalizeAnchor(c.anchorData);
      if (!a) return { ...c, anchor: null, resolved: null, obsolete: false };
      const resolved = locateAnchor(visible, a);
      return { ...c, anchor: a, resolved, obsolete: !resolved };
    });
  }, [comments, renderTick, isHtml, htmlObsoleteIds]);

  // --- Markdown: highlight resolved comments in the DOM -------------------
  useEffect(() => {
    if (!isMd) return;
    const root = contentRef.current;
    if (!root) return;
    clearHighlights(root);
    const sorted = [...resolvedComments]
      .filter((c) => c.resolved !== null && !c.obsolete)
      .sort((a, b) => b.resolved!.start - a.resolved!.start);
    for (const c of sorted) {
      wrapRangeInMarks(root, c.resolved!.start, c.resolved!.end, c.id);
    }
  }, [resolvedComments, isMd]);

  // --- Click on a markdown highlight → open panel and focus comment -------
  useEffect(() => {
    if (!isMd) return;
    const root = contentRef.current;
    if (!root) return;
    const onClick = (e: Event) => {
      const target = e.target as HTMLElement;
      const mark = target.closest("mark[data-comment-id]") as HTMLElement | null;
      if (!mark) return;
      const id = Number(mark.dataset.commentId);
      setActiveId(id);
      setPanelOpen(true);
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [text, isMd]);

  // --- Scroll to and highlight active comment ------------------------------
  useEffect(() => {
    if (isMd) {
      const root = contentRef.current;
      if (!root) return;
      // Clear previous active
      root.querySelectorAll("mark[data-comment-id].active").forEach((el) => el.classList.remove("active"));
      if (activeId !== null) {
        const mark = root.querySelector(`mark[data-comment-id="${activeId}"]`) as HTMLElement | null;
        if (mark) {
          mark.classList.add("active");
          mark.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    } else if (isHtml) {
      const iframe = iframeRef.current;
      if (!iframe) return;
      iframe.contentWindow?.postMessage({ type: "wb:set-active-comment", commentId: activeId }, "*");
    }
  }, [activeId, isMd, isHtml]);

  // --- HTML iframe message bridge -----------------------------------------
  const sendCommentsToIframe = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe || !isHtml) return;
    const payload = comments.map((c) => ({ id: c.id, anchor: normalizeAnchor(c.anchorData) }));
    iframe.contentWindow?.postMessage({ type: "wb:set-comments", comments: payload }, "*");
  }, [comments, isHtml]);

  useEffect(() => {
    if (!isHtml) return;
    const onMessage = (e: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe || e.source !== iframe.contentWindow) return;
      const data = e.data as { type?: string; [k: string]: unknown };
      if (!data || typeof data !== "object") return;
      switch (data.type) {
        case "wb:ready":
          sendCommentsToIframe();
          break;
        case "wb:comments-applied": {
          const obs = (data.obsolete as number[] | undefined) ?? [];
          setHtmlObsoleteIds(new Set(obs));
          break;
        }
        case "wb:selection": {
          const anchor = data.anchor as TextAnchor;
          const rect = data.rect as { left: number; top: number; width: number; height: number };
          setPendingAnchor(anchor);
          setPopover({ x: rect.left + rect.width / 2, y: rect.top });
          break;
        }
        case "wb:selection-cleared":
          setPopover(null);
          break;
        case "wb:contextmenu":
          setContextMenu({ x: data.x as number, y: data.y as number });
          setPopover(null);
          break;
        case "wb:typed":
          setPanelOpen(true);
          setDraft(String(data.key ?? ""));
          setPopover(null);
          requestAnimationFrame(() => {
            const ta = composerRef.current;
            if (ta) {
              ta.focus();
              // Move cursor to end so the already-captured key doesn't get re-inserted at start
              ta.selectionStart = ta.selectionEnd = ta.value.length;
            }
          });
          break;
        case "wb:mark-click": {
          const id = Number(data.commentId);
          setActiveId(id);
          setPanelOpen(true);
          break;
        }
        case "wb:open-relative": {
          const href = String(data.href ?? "");
          const target = resolveRelative(filePath, href);
          if (target) {
            const route = taskSlug
              ? taskFileRoute(projectSlug, taskSlug, target)
              : projectFileRoute(projectSlug, target);
            router.push(route);
          }
          break;
        }
        case "wb:open-external": {
          const href = String(data.href ?? "");
          window.open(href, "_blank", "noopener");
          break;
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [isHtml, sendCommentsToIframe, filePath, projectSlug, taskSlug]);

  // Push fresh comments to iframe whenever they change after load.
  useEffect(() => { sendCommentsToIframe(); }, [sendCommentsToIframe]);

  // --- Markdown selection handlers ----------------------------------------
  const captureFromSelection = useCallback(() => {
    const root = contentRef.current;
    if (!root) return null;
    return captureSelectionAnchor(root);
  }, []);

  const onMouseUp = useCallback(() => {
    if (!isMd) return;
    setTimeout(() => {
      const c = captureFromSelection();
      if (!c) { setPopover(null); return; }
      setPopover({ x: c.rect.left + c.rect.width / 2, y: c.rect.top });
      setPendingAnchor(c.anchor);
    }, 0);
  }, [captureFromSelection, isMd]);

  const onContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isMd) return;
    const c = captureFromSelection();
    if (!c) return;
    e.preventDefault();
    setPendingAnchor(c.anchor);
    setContextMenu({ x: e.clientX, y: e.clientY });
    setPopover(null);
  }, [captureFromSelection, isMd]);

  // Type-while-selected in the markdown body
  useEffect(() => {
    if (!isMd) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length !== 1) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const c = captureFromSelection();
      if (!c) return;
      e.preventDefault();
      setPendingAnchor(c.anchor);
      setPanelOpen(true);
      setDraft(e.key);
      setPopover(null);
      requestAnimationFrame(() => {
        const ta = composerRef.current;
        if (ta) {
          ta.focus();
          // Move cursor to end so the already-captured key doesn't get re-inserted at start
          ta.selectionStart = ta.selectionEnd = ta.value.length;
        }
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [captureFromSelection, isMd]);

  useEffect(() => {
    const onClick = () => { setContextMenu(null); };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setPopover(null); setContextMenu(null); }
    };
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onEsc);
    return () => { window.removeEventListener("click", onClick); window.removeEventListener("keydown", onEsc); };
  }, []);

  const startCommentFromPopover = () => {
    setPopover(null);
    setPanelOpen(true);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const startCommentFromContextMenu = () => {
    setContextMenu(null);
    setPanelOpen(true);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const postComment = async () => {
    if (!draft.trim()) return;
    await fetch(`/api/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: projectSlug,
        task: taskSlug,
        path: filePath,
        anchorType: isHtml ? "html" : "md",
        anchor: pendingAnchor ?? {},
        body: draft.trim(),
      }),
    });
    setDraft("");
    setPendingAnchor(null);
    refreshComments();
  };

  const deleteComment = async (id: number) => {
    await fetch(`/api/comments/${id}?project=${encodeURIComponent(projectSlug)}&task=${encodeURIComponent(taskSlug)}`, { method: "DELETE" });
    refreshComments();
  };

  const editComment = async (id: number, body: string) => {
    await fetch(`/api/comments/${id}?project=${encodeURIComponent(projectSlug)}&task=${encodeURIComponent(taskSlug)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    refreshComments();
  };

  // Live agent session for this file — opens inline as a right column so the
  // user can keep reading/marking the doc while the agent works.
  const [agentSessionId, setAgentSessionId] = useState<string | null>(null);
  const [sendingToAgent, setSendingToAgent] = useState(false);

  // User-picked target for "Send to agent". null = follow the default
  // (most recent live session, else most recent of any state).
  // "new" = explicitly start a fresh session even if live ones exist.
  const [commentTargetSelection, setCommentTargetSelection] = useState<string | "new" | null>(null);

  const taskSessions = useMemo(
    () => sessions.filter((s) => s.projectSlug === projectSlug && s.taskSlug === taskSlug),
    [sessions, projectSlug, taskSlug],
  );

  // Sessions arrive sorted by lastActivity desc from /api/sessions, so the
  // first live one is the freshest live session, and [0] is the freshest overall.
  const defaultCommentTarget = useMemo<SessionSummaryDTO | null>(() => {
    const live = taskSessions.find((s) => s.isLive && s.state !== "stopped" && s.state !== "error");
    return live ?? taskSessions[0] ?? null;
  }, [taskSessions]);

  const effectiveCommentTarget = useMemo<CommentTarget>(() => {
    if (commentTargetSelection === "new") return { kind: "new" };
    if (commentTargetSelection) {
      const s = taskSessions.find((x) => x.id === commentTargetSelection);
      if (s) return { kind: "session", session: s };
    }
    if (defaultCommentTarget) return { kind: "session", session: defaultCommentTarget };
    return { kind: "new" };
  }, [commentTargetSelection, taskSessions, defaultCommentTarget]);

  const sendCommentsToAgent = async () => {
    const live = resolvedComments.filter((c) => !c.obsolete);
    if (live.length === 0 || sendingToAgent || !taskSlug) return;
    setSendingToAgent(true);
    try {
      const message = buildAgentMessage(filePath, live);
      if (effectiveCommentTarget.kind === "session") {
        const targetId = effectiveCommentTarget.session.id;
        await fetch(`/api/sessions/${targetId}/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        });
        if (!agentSessionId) setAgentSessionId(targetId);
      } else {
        const res = await fetch(
          `/api/projects/${projectSlug}/tasks/${taskSlug}/sessions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message }),
          },
        );
        const created = await res.json();
        if (created.id) {
          setAgentSessionId(created.id);
          // Reset to "auto" so the next send follows the (now newer) default.
          setCommentTargetSelection(null);
        } else {
          alert(created.error ?? "failed to start session");
        }
      }
    } finally {
      setSendingToAgent(false);
    }
  };

  // While the agent is working, the comment list may change underneath us
  // (the agent's `resolve_comment` deletes rows). Poll every 2s while the
  // panel is open so the highlights / counts stay in sync.
  useEffect(() => {
    if (!agentSessionId) return;
    const t = setInterval(() => { refreshComments(); }, 2000);
    return () => clearInterval(t);
  }, [agentSessionId, refreshComments]);

  // Markdown link component: rewrite relative paths to hash-route navigation.
  const MarkdownLink = useCallback(
    ({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
      const target = href ? resolveRelative(filePath, href) : null;
      if (target === null) {
        // External / anchor — open external in new tab; let anchors behave.
        const isExternal = href ? /^(?:[a-z]+:)|^\/\//i.test(href) : false;
        return (
          <a
            href={href}
            target={isExternal ? "_blank" : undefined}
            rel={isExternal ? "noreferrer" : undefined}
            {...rest}
          >{children}</a>
        );
      }
      const route = taskSlug
        ? taskFileRoute(projectSlug, taskSlug, target)
        : projectFileRoute(projectSlug, target);
      return (
        <a
          href={route}
          {...rest}
        >{children}</a>
      );
    },
    [filePath, projectSlug, taskSlug],
  );

  const liveCount = resolvedComments.filter((c) => !c.obsolete).length;
  const obsoleteCount = resolvedComments.filter((c) => c.obsolete).length;

  const thread = useMemo<ThreadRecord | null>(() => {
    if (!isEmailThread || text == null) return null;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.messages)) {
        return parsed as ThreadRecord;
      }
    } catch { /* fall through to raw view */ }
    return null;
  }, [isEmailThread, text]);

  return (
    <>
      {!embedded && (
        <header className="h-14 border-b border-[var(--border)] flex items-center px-6 gap-3 shrink-0">
          <button
            onClick={onBack}
            className="text-[var(--muted)] hover:text-[var(--text)] text-[13px] -ml-1.5"
          >← Task</button>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] truncate font-mono">{filePath}</div>
            <div className="text-[11.5px] text-[var(--muted)]">
              {projectSlug} · {taskSlug}
            </div>
          </div>
          {supportsComments && (
            <button
              onClick={() => setPanelOpen((v) => !v)}
              className={`text-[12px] border border-[var(--border-strong)] rounded-lg px-3 py-1.5 hover:bg-[var(--panel-2)] ${panelOpen ? "bg-[var(--panel-2)]" : ""}`}
              title="Comments — select text in the doc first, or write a comment on the whole document"
            >
              💬 {liveCount > 0 || obsoleteCount > 0
                ? `${liveCount}${obsoleteCount > 0 ? ` · ${obsoleteCount} obsolete` : ""}`
                : "Add"}
            </button>
          )}
          {taskSlug && (
            <button
              onClick={() => setChatPanelOpen((v) => !v)}
              className={`text-[12px] border border-[var(--border-strong)] rounded-lg px-3 py-1.5 hover:bg-[var(--panel-2)] ${chatPanelOpen ? "bg-[var(--panel-2)]" : ""}`}
              title="Chat with an agent about this file"
            >
              🤖 Chat
            </button>
          )}
          <a
            href={rawUrl}
            download
            className="text-[12px] text-[var(--text-soft)] border border-[var(--border-strong)] rounded-lg px-3 py-1.5 hover:bg-[var(--panel-2)]"
          >Download</a>
        </header>
      )}
      {embedded && supportsComments && (
        <div className="flex items-center justify-end gap-2 px-3 py-1.5 border-b border-[var(--border)] shrink-0">
          <button
            onClick={() => setPanelOpen((v) => !v)}
            className={`text-[11.5px] border border-[var(--border-strong)] rounded-md px-2 py-0.5 hover:bg-[var(--panel-2)] ${panelOpen ? "bg-[var(--panel-2)]" : ""}`}
            title="Comments — select text in the doc first, or write a comment on the whole document"
          >
            💬 {liveCount > 0 || obsoleteCount > 0
              ? `${liveCount}${obsoleteCount > 0 ? ` · ${obsoleteCount} obsolete` : ""}`
              : "Add"}
          </button>
          <a
            href={rawUrl}
            download
            className="text-[11.5px] text-[var(--text-soft)] border border-[var(--border-strong)] rounded-md px-2 py-0.5 hover:bg-[var(--panel-2)]"
          >Download</a>
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        {/* Iframe-style viewers fill the available area without page scroll */}
        {isEmailThread && thread ? (
          <EmailThreadViewer
            thread={thread}
            filePath={filePath}
            projectSlug={projectSlug}
            taskSlug={taskSlug}
          />
        ) : isHtml && text !== null ? (
          <div className="flex-1 min-w-0 flex flex-col p-4">
            <iframe
              ref={iframeRef}
              srcDoc={buildEnhancedHtml(text)}
              sandbox="allow-same-origin allow-scripts"
              className="flex-1 w-full rounded-xl border border-[var(--border)] bg-white"
              title={filePath}
            />
          </div>
        ) : isPdf ? (
          <div className="flex-1 min-w-0 flex flex-col p-4">
            <iframe
              src={rawUrl}
              className="flex-1 w-full rounded-xl border border-[var(--border)] bg-white"
              title={filePath}
            />
          </div>
        ) : (
          <div
            className="flex-1 min-w-0 overflow-y-auto"
            onMouseUp={onMouseUp}
            onContextMenu={onContextMenu}
          >
            <div className="w-full px-8 py-6">
              {error && <div className="text-[13px] text-[#dc2626]">{error}</div>}

              {isImage && (
                <img src={rawUrl} alt={filePath} className="max-w-full mx-auto rounded-xl border border-[var(--border)]" />
              )}

              {isMd && text !== null && (
                <article ref={contentRef} className="prose max-w-3xl mx-auto text-[15px] leading-relaxed prose-pre:bg-[var(--panel-2)] prose-pre:border prose-pre:border-[var(--border)] prose-code:text-[var(--accent)] prose-code:before:content-none prose-code:after:content-none">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    skipHtml
                    components={{ a: MarkdownLink }}
                  >{text}</ReactMarkdown>
                </article>
              )}

              {isText && !isMd && !isHtml && text !== null && (
                <pre className="text-[12.5px] bg-[var(--panel-2)] border border-[var(--border)] rounded-xl p-4 overflow-x-auto whitespace-pre-wrap break-words">{text}</pre>
              )}

              {isEmailThread && text !== null && !thread && (
                <div className="space-y-2">
                  <div className="text-[12.5px] text-[#dc2626]">
                    Could not parse this file as an email thread (expected JSON with a <code>messages</code> array). Showing raw contents.
                  </div>
                  <pre className="text-[12.5px] bg-[var(--panel-2)] border border-[var(--border)] rounded-xl p-4 overflow-x-auto whitespace-pre-wrap break-words">{text}</pre>
                </div>
              )}

              {!isImage && !isPdf && !isHtml && !isMd && !isText && !isEmailThread && (
                <div className="text-[13px] text-[var(--muted)]">
                  No preview for <span className="font-mono">.{ext}</span> files.{" "}
                  <a href={rawUrl} download className="text-[var(--accent)] hover:underline">Download</a>.
                </div>
              )}
            </div>
          </div>
        )}

        {supportsComments && panelOpen && (
          <CommentPanel
            comments={resolvedComments}
            activeId={activeId}
            onActiveChange={setActiveId}
            composerRef={composerRef}
            draft={draft}
            pendingAnchor={pendingAnchor}
            onDraft={setDraft}
            onClearPending={() => setPendingAnchor(null)}
            onPost={postComment}
            onDelete={deleteComment}
            onEdit={editComment}
            onSendToAgent={sendCommentsToAgent}
            sendingToAgent={sendingToAgent}
            taskSessions={taskSessions}
            commentTarget={effectiveCommentTarget}
            onCommentTargetChange={setCommentTargetSelection}
          />
        )}

        {!embedded && agentSessionId && (
          <AgentPanel
            sessionId={agentSessionId}
            projectSlug={projectSlug}
            taskSlug={taskSlug}
            onClose={() => setAgentSessionId(null)}
            onOpenFull={() => {
              const route = taskSlug
                ? taskSessionRoute(projectSlug, taskSlug, agentSessionId)
                : projectSessionRoute(projectSlug, agentSessionId);
              router.push(route);
            }}
          />
        )}

        {!embedded && chatPanelOpen && taskSlug && (
          <>
            <Resizer
              direction="horizontal"
              minSize={MIN_CHAT_WIDTH}
              maxSize={MAX_CHAT_WIDTH}
              onResize={(size) => {
                setChatPanelWidth(size);
                localStorage.setItem(CHAT_PANEL_WIDTH_KEY, String(size));
              }}
            />
            <ChatPanel
              projectSlug={projectSlug}
              taskSlug={taskSlug}
              filePath={filePath}
              width={chatPanelWidth}
              onClose={() => setChatPanelOpen(false)}
              onOpenFull={(sessionId) => {
                const route = taskSessionRoute(projectSlug, taskSlug, sessionId);
                router.push(route);
              }}
            />
          </>
        )}
      </div>

      {popover && (
        <SelectionPopover x={popover.x} y={popover.y} onComment={startCommentFromPopover} />
      )}
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onComment={startCommentFromContextMenu} />
      )}
    </>
  );
}

function buildAgentMessage(filePath: string, comments: ResolvedComment[]): string {
  const lines: string[] = [];
  lines.push(`Please address the following comments on \`${filePath}\`:`);
  lines.push("");
  for (const c of comments) {
    const quote = c.anchor?.exact?.trim() ?? "";
    lines.push(`- [comment #${c.id}] on "${quote}" — ${c.body.trim().replace(/\n/g, " ")}`);
  }
  lines.push("");
  lines.push(
    "After addressing each one, call the `workbench-comments.resolve_comment` tool with its `comment_id` so it disappears from the user's view. " +
    "You may also use `workbench-comments.add_comment` to flag anything you want them to review. " +
    "When you're done, give a one-line summary of what changed.",
  );
  return lines.join("\n");
}

function normalizeAnchor(d: Partial<TextAnchor> & { quote?: string } | undefined): TextAnchor | null {
  if (!d) return null;
  if (typeof d.exact === "string" && d.exact.length > 0) {
    return { prefix: d.prefix ?? "", exact: d.exact, suffix: d.suffix ?? "" };
  }
  if (typeof d.quote === "string" && d.quote.length > 0) {
    return { prefix: "", exact: d.quote, suffix: "" };
  }
  return null;
}

function SelectionPopover({ x, y, onComment }: { x: number; y: number; onComment: () => void }) {
  return (
    <div
      className="fixed z-40"
      style={{ left: x, top: y - 8, transform: "translate(-50%, -100%)" }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        onClick={onComment}
        className="bg-[var(--text)] text-[var(--bg)] rounded-full px-3 py-1.5 text-[12.5px] font-medium shadow-lg hover:opacity-90 flex items-center gap-1.5"
      >💬 Comment</button>
    </div>
  );
}

function ContextMenu({ x, y, onComment }: { x: number; y: number; onComment: () => void }) {
  return (
    <div
      className="fixed z-50 bg-[var(--bg)] border border-[var(--border-strong)] rounded-lg shadow-xl py-1 min-w-[180px]"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button onClick={onComment} className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-[var(--panel-2)]">
        💬 Comment on selection
      </button>
    </div>
  );
}

function CommentPanel({
  comments, activeId, onActiveChange, composerRef, draft, pendingAnchor,
  onDraft, onClearPending, onPost, onDelete, onEdit, onSendToAgent, sendingToAgent,
  taskSessions, commentTarget, onCommentTargetChange,
}: {
  comments: ResolvedComment[];
  activeId: number | null;
  onActiveChange: (id: number | null) => void;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  draft: string;
  pendingAnchor: TextAnchor | null;
  onDraft: (v: string) => void;
  onClearPending: () => void;
  onPost: () => void;
  onDelete: (id: number) => void;
  onEdit: (id: number, body: string) => void;
  onSendToAgent: () => void;
  sendingToAgent: boolean;
  taskSessions: SessionSummaryDTO[];
  commentTarget: CommentTarget;
  onCommentTargetChange: (id: string | "new" | null) => void;
}) {
  const live = comments.filter((c) => !c.obsolete);
  const obsolete = comments.filter((c) => c.obsolete);

  return (
    <aside className="w-[340px] shrink-0 border-l border-[var(--border)] bg-[var(--bg-2)] flex flex-col">
      <div className="px-4 py-3 border-b border-[var(--border)] flex items-center gap-2">
        <div className="text-[12px] uppercase tracking-wider text-[var(--muted)] font-semibold flex-1">Comments</div>
        {live.length > 0 && (
          <SendToAgentButton
            count={live.length}
            sending={sendingToAgent}
            target={commentTarget}
            sessions={taskSessions}
            onSend={onSendToAgent}
            onTargetChange={onCommentTargetChange}
          />
        )}
      </div>

      <div className="p-3 border-b border-[var(--border)]">
        {pendingAnchor ? (
          <div className="text-[11.5px] mb-2 bg-[var(--accent-soft)] border-l-2 border-[var(--accent)] px-2 py-1.5 rounded-r">
            <div className="text-[var(--text-soft)] line-clamp-3 italic">&ldquo;{pendingAnchor.exact}&rdquo;</div>
            <button onClick={onClearPending} className="text-[10.5px] text-[var(--muted)] hover:text-[var(--text)] mt-0.5">clear · comment on whole doc instead</button>
          </div>
        ) : (
          <div className="text-[10.5px] mb-2 text-[var(--muted)]">
            Comment will attach to the whole document. Select text first to anchor it.
          </div>
        )}
        <div className="rounded-xl border border-[var(--border-strong)] bg-[var(--panel)] focus-within:border-[var(--accent)] transition">
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            placeholder={pendingAnchor ? "Comment on selection…" : "Comment on the whole document…"}
            rows={3}
            onKeyDown={(e) => handleComposerEnter(e, onPost)}
            className="w-full resize-none bg-transparent outline-none text-[13.5px] px-3 py-2 leading-relaxed"
          />
          <div className="flex justify-end px-2 pb-2">
            <button
              onClick={onPost}
              disabled={!draft.trim()}
              className="bg-[var(--accent)] text-[var(--accent-text)] rounded-md px-3 py-1 text-[12px] font-medium disabled:opacity-40 hover:brightness-110"
            >Post ↵</button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {comments.length === 0 && (
          <div className="text-[12.5px] text-[var(--muted)] italic">No comments yet. Select text to anchor one, or write a comment on the whole document above.</div>
        )}

        {live.filter((c) => !c.anchor).length > 0 && (
          <>
            <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] font-semibold px-1">On the document</div>
            {live.filter((c) => !c.anchor).map((c) => (
              <CommentCard key={c.id} c={c} active={activeId === c.id} onClick={() => onActiveChange(c.id)} onDelete={onDelete} onEdit={onEdit} />
            ))}
          </>
        )}
        {live.filter((c) => c.anchor).length > 0 && (
          <>
            {live.filter((c) => !c.anchor).length > 0 && (
              <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] font-semibold px-1 pt-2">On selections</div>
            )}
            {live.filter((c) => c.anchor).map((c) => (
              <CommentCard key={c.id} c={c} active={activeId === c.id} onClick={() => onActiveChange(c.id)} onDelete={onDelete} onEdit={onEdit} />
            ))}
          </>
        )}

        {obsolete.length > 0 && (
          <>
            <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] font-semibold mt-3 px-1 pt-3 border-t border-[var(--border)]">
              Obsolete · {obsolete.length}
            </div>
            <div className="text-[11.5px] text-[var(--muted)] px-1 mb-1">
              The text these comments were attached to is no longer in the document.
            </div>
            {obsolete.map((c) => (
              <CommentCard key={c.id} c={c} active={activeId === c.id} onClick={() => onActiveChange(c.id)} onDelete={onDelete} onEdit={onEdit} dim />
            ))}
          </>
        )}
      </div>
    </aside>
  );
}

function SendToAgentButton({
  count, sending, target, sessions, onSend, onTargetChange,
}: {
  count: number;
  sending: boolean;
  target: CommentTarget;
  sessions: SessionSummaryDTO[];
  onSend: () => void;
  onTargetChange: (id: string | "new" | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);

  const label = sending
    ? "Sending…"
    : target.kind === "new"
      ? `→ New session (${count})`
      : `→ ${truncateMiddle(target.session.title || "(no title)", 22)} (${count})`;

  const tooltip = target.kind === "new"
    ? "Start a new session and send the open comments to it"
    : `Send the open comments to "${target.session.title || "(no title)"}"`;

  return (
    <div ref={wrapRef} className="relative flex">
      <button
        onClick={onSend}
        disabled={sending}
        className="text-[11.5px] bg-[var(--accent)] text-[var(--accent-text)] font-medium rounded-l-md px-2.5 py-1 hover:brightness-110 disabled:opacity-50 max-w-[220px] truncate"
        title={tooltip}
      >
        {label}
      </button>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={sending}
        className="text-[11.5px] bg-[var(--accent)] text-[var(--accent-text)] rounded-r-md px-1.5 py-1 border-l border-[color-mix(in_srgb,var(--accent-text)_25%,transparent)] hover:brightness-110 disabled:opacity-50"
        title="Pick a different session"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ▾
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 mt-1 z-20 bg-[var(--panel)] border border-[var(--border)] rounded-lg shadow-lg py-1 min-w-[260px] max-h-[340px] overflow-y-auto"
        >
          {sessions.length === 0 && (
            <div className="px-3 py-2 text-[11.5px] text-[var(--muted)] italic">
              No sessions yet for this task.
            </div>
          )}
          {sessions.map((s) => {
            const color = SESSION_STATE_COLOR[s.state] ?? "var(--muted)";
            const isActive = target.kind === "session" && target.session.id === s.id;
            const isPulsing = !s.completed && s.state !== "error";
            return (
              <button
                key={s.id}
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => { onTargetChange(s.id); setOpen(false); }}
                className={`w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-[var(--panel-2)] ${isActive ? "bg-[var(--panel-2)]" : ""}`}
              >
                <span
                  className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${isPulsing ? "pulse" : ""}`}
                  style={{ background: color }}
                />
                <span className="text-[12.5px] truncate flex-1">{s.title || "(no title)"}</span>
                <span className="text-[10.5px] text-[var(--muted)] shrink-0">
                  {formatRelativeShort(s.lastActivity)}
                </span>
              </button>
            );
          })}
          <div className="border-t border-[var(--border)] mt-1 pt-1">
            <button
              role="menuitemradio"
              aria-checked={target.kind === "new"}
              onClick={() => { onTargetChange("new"); setOpen(false); }}
              className={`w-full text-left px-3 py-1.5 text-[12.5px] text-[var(--accent)] hover:bg-[var(--panel-2)] ${target.kind === "new" ? "bg-[var(--panel-2)]" : ""}`}
            >
              + New session
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = Math.max(1, Math.floor((max - 1) / 2));
  return `${s.slice(0, keep)}…${s.slice(s.length - keep)}`;
}

function formatRelativeShort(iso: string): string {
  const d = new Date(iso);
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSec < 60) return "now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d`;
  return d.toLocaleDateString();
}

function CommentCard({
  c, active, onClick, onDelete, onEdit, dim,
}: {
  c: ResolvedComment;
  active: boolean;
  onClick: () => void;
  onDelete: (id: number) => void;
  onEdit: (id: number, body: string) => void;
  dim?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(c.body);
  const quote = c.anchor?.exact;

  const handleSave = () => {
    if (editDraft.trim() && editDraft.trim() !== c.body) {
      onEdit(c.id, editDraft.trim());
    }
    setEditing(false);
  };

  const handleCancel = () => {
    setEditDraft(c.body);
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  };

  return (
    <div
      onClick={onClick}
      className={`rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2.5 text-[13px] cursor-pointer transition ${active ? "ring-2 ring-[var(--accent)]" : ""} ${dim ? "opacity-60" : ""}`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="font-medium">{c.author}</span>
        <span className="text-[11px] text-[var(--muted)]">
          {new Date(c.createdAt).toLocaleString()}
          {c.updatedAt && " (edited)"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {!editing && (
            <button
              onClick={(e) => { e.stopPropagation(); setEditing(true); }}
              className="text-[var(--muted)] hover:text-[var(--text)] text-[11px]"
              title="Edit"
            >Edit</button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}
            className="text-[var(--muted)] hover:text-[#dc2626] text-[11px]"
            title="Delete"
          >×</button>
        </div>
      </div>
      {quote && (
        <div className={`text-[11.5px] italic border-l-2 ${dim ? "border-[var(--border-strong)] text-[var(--muted)]" : "border-[var(--accent)] text-[var(--text-soft)]"} pl-2 mb-1.5 line-clamp-3`}>
          &ldquo;{quote}&rdquo;
        </div>
      )}
      {editing ? (
        <div onClick={(e) => e.stopPropagation()}>
          <textarea
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full resize-none bg-[var(--bg)] border border-[var(--border-strong)] rounded-lg outline-none text-[13px] px-2 py-1.5 leading-relaxed focus:border-[var(--accent)]"
            rows={3}
            autoFocus
          />
          <div className="flex justify-end gap-2 mt-1.5">
            <button
              onClick={handleCancel}
              className="text-[11px] text-[var(--muted)] hover:text-[var(--text)]"
            >Cancel</button>
            <button
              onClick={handleSave}
              disabled={!editDraft.trim()}
              className="text-[11px] bg-[var(--accent)] text-[var(--accent-text)] rounded px-2 py-0.5 disabled:opacity-40 hover:brightness-110"
            >Save</button>
          </div>
        </div>
      ) : (
        <div className="whitespace-pre-wrap">{c.body}</div>
      )}
    </div>
  );
}
