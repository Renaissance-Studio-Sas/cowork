"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import { handleComposerEnter } from "@/lib/composer";
import type { SessionSummaryDTO, SessionRuntime, EffortLevel } from "@/lib/types";
import { TodoList, extractTodosFromMessages } from "./TodoList";
import { FileDropZone, AttachmentPreview, type FileAttachment } from "./FileDropZone";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface UploadedFile {
  name: string;
  path: string;
  mimeType: string;
  size: number;
}

// Number of messages to load initially and per batch
const PAGE_SIZE = 50;

interface Props {
  projectSlug: string;
  taskSlug: string;
  /** Currently viewing this file — included in new session context */
  filePath?: string;
  /** Width in pixels (for resizable panels) */
  width?: number;
  onClose: () => void;
  onOpenFull: (sessionId: string) => void;
}

type SDKMessageLite =
  | { type: "user"; message: { role: "user"; content: unknown } }
  | {
      type: "assistant";
      message: {
        role: "assistant";
        content: Array<
          | { type: "text"; text: string }
          | { type: "tool_use"; id: string; name: string; input: unknown }
        >;
      };
    }
  | { type: "result"; subtype: string }
  | { type: "system"; subtype: string }
  | Record<string, unknown>;

const STATE_LABEL: Record<string, string> = {
  awaiting_input: "needs reply",
  running: "working",
  idle: "done",
  stopped: "done", // stopped sessions seamlessly resume, show as done
  error: "error",
};
const STATE_COLOR: Record<string, string> = {
  awaiting_input: "var(--warn)",
  running: "var(--accent)",
  idle: "var(--ok)",
  stopped: "var(--ok)", // same as idle/done
  error: "#dc2626",
};

export function ChatPanel({ projectSlug, taskSlug, filePath, width = 380, onClose, onOpenFull }: Props) {
  const { sessions, refresh } = useWorkspace();

  // Filter sessions for this task
  const taskSessions = useMemo(
    () => sessions.filter((s) => s.projectSlug === projectSlug && s.taskSlug === taskSlug),
    [sessions, projectSlug, taskSlug],
  );

  // Default to latest live session, or most recent session
  const defaultSession = useMemo(() => {
    const live = taskSessions.find((s) => s.isLive && s.state !== "stopped" && s.state !== "error");
    if (live) return live;
    return taskSessions[0] ?? null;
  }, [taskSessions]);

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [showSelector, setShowSelector] = useState(false);
  // Explicit flag for when user wants to create a new session
  const [creatingNew, setCreatingNew] = useState(false);

  // The active session (selected or default)
  const activeSession = useMemo(() => {
    // If user is explicitly creating a new session, don't show any active session
    if (creatingNew) return null;
    if (selectedSessionId) {
      return taskSessions.find((s) => s.id === selectedSessionId) ?? defaultSession;
    }
    return defaultSession;
  }, [selectedSessionId, taskSessions, defaultSession, creatingNew]);

  // Reset selection when task changes
  useEffect(() => {
    setSelectedSessionId(null);
    setShowSelector(false);
    setCreatingNew(false);
  }, [projectSlug, taskSlug]);

  // For creating new sessions
  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(false);
  const [runtime, setRuntime] = useState<SessionRuntime>("claude");
  // "" = use SDK default (currently 'high'); otherwise pass through as effort.
  const [effort, setEffort] = useState<EffortLevel | "">("");
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const startNewSession = async () => {
    if (!draft.trim() || starting) return;
    setStarting(true);
    try {
      const contextPrefix = filePath ? `[Viewing: ${filePath}]\n\n` : "";
      const r = await fetch(`/api/projects/${projectSlug}/tasks/${taskSlug}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: contextPrefix + draft.trim(),
          runtime,
          ...(effort ? { effort } : {}),
        }),
      });
      const j = await r.json();
      if (j.id) {
        setDraft("");
        setCreatingNew(false);
        setSelectedSessionId(j.id);
        setShowSelector(false);
        refresh();
      } else {
        alert(j.error ?? "failed to start session");
      }
    } finally {
      setStarting(false);
    }
  };

  // No sessions and no active one — show new session composer
  if (!activeSession && taskSessions.length === 0) {
    return (
      <aside className="shrink-0 border-l border-[var(--border)] bg-[var(--bg-2)] flex flex-col" style={{ width }}>
        <ChatPanelHeader
          projectSlug={projectSlug}
          taskSlug={taskSlug}
          session={null}
          sessionCount={0}
          onClose={onClose}
          onOpenFull={() => {}}
          onToggleSelector={() => setShowSelector((v) => !v)}
          showSelector={showSelector}
        />
        <div className="flex-1 flex flex-col items-center justify-center p-4">
          <div className="text-[var(--muted)] text-[13px] text-center mb-4">
            No sessions yet for this task.
          </div>
        </div>
        <NewSessionComposer
          draft={draft}
          onDraft={setDraft}
          onStart={startNewSession}
          starting={starting}
          composerRef={composerRef}
          placeholder={filePath ? `Ask about ${filePath}…` : "Start a conversation…"}
          runtime={runtime}
          onRuntime={setRuntime}
          effort={effort}
          onEffort={setEffort}
        />
      </aside>
    );
  }

  return (
    <aside className="shrink-0 border-l border-[var(--border)] bg-[var(--bg-2)] flex flex-col" style={{ width }}>
      <ChatPanelHeader
        projectSlug={projectSlug}
        taskSlug={taskSlug}
        session={activeSession}
        sessionCount={taskSessions.filter((s) => !s.completed).length}
        onClose={onClose}
        onOpenFull={() => activeSession && onOpenFull(activeSession.id)}
        onToggleSelector={() => setShowSelector((v) => !v)}
        showSelector={showSelector}
      />

      {showSelector ? (
        <SessionSelector
          sessions={taskSessions}
          activeId={activeSession?.id ?? null}
          onSelect={(id) => {
            setSelectedSessionId(id);
            setCreatingNew(false);
            setShowSelector(false);
          }}
          onNewSession={() => {
            setSelectedSessionId(null);
            setCreatingNew(true);
            setShowSelector(false);
            setTimeout(() => composerRef.current?.focus(), 0);
          }}
          onRefresh={refresh}
        />
      ) : activeSession ? (
        <LiveChat
          session={activeSession}
          filePath={filePath}
          onRefresh={refresh}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-[var(--muted)] text-[13px]">
          Select a session or start a new one
        </div>
      )}

      {/* Show new session composer when no active session or explicitly creating new */}
      {(!activeSession || showSelector || creatingNew) && (
        <NewSessionComposer
          draft={draft}
          onDraft={setDraft}
          onStart={startNewSession}
          starting={starting}
          composerRef={composerRef}
          placeholder={filePath ? `Ask about ${filePath}…` : "Start a new conversation…"}
          runtime={runtime}
          onRuntime={setRuntime}
          effort={effort}
          onEffort={setEffort}
        />
      )}
    </aside>
  );
}

function ChatPanelHeader({
  projectSlug,
  taskSlug,
  session,
  sessionCount,
  onClose,
  onOpenFull,
  onToggleSelector,
  showSelector,
}: {
  projectSlug: string;
  taskSlug: string;
  session: SessionSummaryDTO | null;
  sessionCount: number;
  onClose: () => void;
  onOpenFull: () => void;
  onToggleSelector: () => void;
  showSelector: boolean;
}) {
  const state = session?.state ?? "idle";
  const label = STATE_LABEL[state] ?? state;
  const color = STATE_COLOR[state] ?? "var(--muted)";
  const isWorking = state === "running";
  const isAwaiting = state === "awaiting_input";

  return (
    <div className="px-3 py-3 border-b border-[var(--border)] flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <button
          onClick={onToggleSelector}
          className="flex items-center gap-1.5 text-[12px] uppercase tracking-wider text-[var(--muted)] font-semibold hover:text-[var(--text)] transition"
          title={showSelector ? "Hide sessions" : "Switch session"}
        >
          <span>Chat</span>
          {sessionCount > 0 && (
            <span className="text-[10px] bg-[var(--panel)] px-1.5 py-0.5 rounded normal-case tracking-normal">
              {sessionCount}
            </span>
          )}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            className={`transition-transform ${showSelector ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {session && (
          <div className="text-[11px] flex items-center gap-1.5 mt-0.5 truncate" style={{ color }}>
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${isWorking || isAwaiting ? "pulse" : ""}`}
              style={{ background: color }}
            />
            <span className={`truncate ${isWorking || isAwaiting ? "pulse" : ""}`}>
              {session.title || "(no title)"}
              {isWorking && <span className="dots ml-0.5" aria-hidden />}
            </span>
            <span className="text-[var(--muted)] shrink-0">· {label}</span>
            {(session.model || session.runtime) && (
              <>
                <span
                  className="text-[var(--muted)] shrink-0 font-mono"
                  title={session.model ? `Model: ${session.model}` : `Runtime: ${session.runtime}`}
                >
                  · {session.model ?? session.runtime}
                </span>
                <span
                  className="text-[var(--muted)] shrink-0 font-mono opacity-70"
                  title={
                    session.effort
                      ? `Thinking effort: ${session.effort}`
                      : "Thinking effort: high (SDK default)"
                  }
                >
                  ({session.effort ?? "high"})
                </span>
              </>
            )}
          </div>
        )}
      </div>
      {session && (
        <button
          onClick={onOpenFull}
          title="Open full view"
          className="text-[var(--muted)] hover:text-[var(--text)] text-[11px] px-1.5 py-0.5 rounded hover:bg-[var(--panel-2)]"
        >
          ↗
        </button>
      )}
      <button
        onClick={onClose}
        title="Close"
        className="text-[var(--muted)] hover:text-[var(--text)] text-[14px] leading-none px-1.5 py-0.5 rounded hover:bg-[var(--panel-2)]"
      >
        ×
      </button>
    </div>
  );
}

function SessionSelector({
  sessions,
  activeId,
  onSelect,
  onNewSession,
  onRefresh,
}: {
  sessions: SessionSummaryDTO[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewSession: () => void;
  onRefresh: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  const startRename = (s: SessionSummaryDTO) => {
    setEditingId(s.id);
    setEditName(s.title);
    setMenuOpenId(null);
  };

  const submitRename = async (s: SessionSummaryDTO) => {
    if (!editName.trim()) {
      setEditingId(null);
      return;
    }
    try {
      await fetch(`/api/sessions/${s.id}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectSlug: s.projectSlug,
          taskSlug: s.taskSlug,
          name: editName.trim(),
        }),
      });
      onRefresh();
    } catch { /* ignore */ }
    setEditingId(null);
  };

  const handleDelete = async (s: SessionSummaryDTO) => {
    setMenuOpenId(null);
    if (!confirm(`Delete session "${s.title}"? This cannot be undone.`)) return;
    try {
      await fetch(`/api/sessions/${s.id}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectSlug: s.projectSlug,
          taskSlug: s.taskSlug,
        }),
      });
      onRefresh();
    } catch { /* ignore */ }
  };

  return (
    <div className="flex-1 overflow-y-auto p-2 space-y-1">
      <button
        onClick={onNewSession}
        className="w-full text-left rounded-lg px-3 py-2 text-[13px] bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent-soft)] border border-dashed border-[var(--accent)] font-medium"
      >
        + New session
      </button>
      {sessions.map((s) => {
        const color = STATE_COLOR[s.state] ?? "var(--muted)";
        const isActive = s.id === activeId;
        const isEditing = editingId === s.id;
        const isLive = s.isLive && s.state !== "stopped" && s.state !== "error";
        const menuOpen = menuOpenId === s.id;

        return (
          <div
            key={s.id}
            className={`relative rounded-lg transition ${
              isActive ? "bg-[var(--panel-2)] ring-1 ring-[var(--accent)]" : "hover:bg-[var(--panel)]"
            }`}
          >
            <button
              onClick={() => onSelect(s.id)}
              className="w-full text-left px-3 py-1.5"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${s.state === "awaiting_input" || s.state === "running" ? "pulse" : ""}`}
                  style={{ background: color }}
                />
                {isEditing ? (
                  <input
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => submitRename(s)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitRename(s);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="text-[13px] flex-1 bg-[var(--panel)] border border-[var(--accent)] rounded px-1.5 py-0.5 outline-none"
                  />
                ) : (
                  <>
                    <span className="text-[13px] truncate flex-1">{s.title || "(no title)"}</span>
                    <span className="text-[11px] text-[var(--muted)] shrink-0">
                      {formatRelative(s.lastActivity)}
                    </span>
                    <span className="text-[11px] shrink-0" style={{ color }}>
                      · {STATE_LABEL[s.state] ?? s.state}
                    </span>
                  </>
                )}
              </div>
            </button>

            {/* Menu toggle for stopped sessions */}
            {!isLive && !isEditing && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpenId(menuOpen ? null : s.id);
                }}
                className="absolute top-2 right-2 text-[var(--muted)] hover:text-[var(--text)] text-[12px] px-1 py-0.5 rounded hover:bg-[var(--panel-2)]"
                title="Session options"
              >
                ···
              </button>
            )}

            {/* Dropdown menu */}
            {menuOpen && (
              <div className="absolute top-8 right-2 z-10 bg-[var(--panel)] border border-[var(--border)] rounded-lg shadow-lg py-1 min-w-[100px]">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    startRename(s);
                  }}
                  className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-[var(--panel-2)]"
                >
                  Rename
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(s);
                  }}
                  className="w-full text-left px-3 py-1.5 text-[12px] text-[#dc2626] hover:bg-[var(--panel-2)]"
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LiveChat({
  session,
  filePath,
  onRefresh,
}: {
  session: SessionSummaryDTO;
  filePath?: string;
  onRefresh: () => void;
}) {
  const [messages, setMessages] = useState<SDKMessageLite[]>([]);
  const [state, setState] = useState<string>(session.state);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // In-progress streamed text for the current assistant turn (see Chat.tsx).
  const [streamingText, setStreamingText] = useState<string>("");
  // Track whether we have an active SSE connection (session is truly live)
  const [streamConnected, setStreamConnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // File attachment state
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [uploading, setUploading] = useState(false);

  // Lazy loading state
  const [historyMeta, setHistoryMeta] = useState<{ total: number; hasMore: boolean; offset: number } | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const isAtBottomRef = useRef(true);
  const prevScrollHeightRef = useRef(0);
  const isInitialLoadRef = useRef(true);

  // Check if user is scrolled to bottom
  const checkIfAtBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    const threshold = 50;
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Update isAtBottomRef on scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      isAtBottomRef.current = checkIfAtBottom();
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [checkIfAtBottom]);

  // After prepending older messages, restore scroll position
  useEffect(() => {
    if (isLoadingMore || isInitialLoadRef.current) return;
    const el = scrollRef.current;
    if (!el || prevScrollHeightRef.current === 0) return;
    const heightDiff = el.scrollHeight - prevScrollHeightRef.current;
    if (heightDiff > 0) {
      el.scrollTop += heightDiff;
    }
    prevScrollHeightRef.current = 0;
  }, [messages.length, isLoadingMore]);

  // Stable reference to onRefresh to avoid re-running the effect
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    setMessages([]);
    setState(session.state);
    setStreamConnected(false);
    setHistoryMeta(null);
    isInitialLoadRef.current = true;

    // Always try to connect to SSE stream first — even if session.isLive is false,
    // the session might actually be live (race condition with API polling)
    const es = new EventSource(
      `/api/sessions/${session.id}/stream?limit=${PAGE_SIZE}&project=${encodeURIComponent(session.projectSlug)}&task=${encodeURIComponent(session.taskSlug)}`,
    );
    let connected = false;
    let initialMessages: SDKMessageLite[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushInitial = () => {
      if (initialMessages.length > 0 && isInitialLoadRef.current) {
        setMessages(initialMessages);
        isInitialLoadRef.current = false;
        // Scroll to bottom after initial render
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          if (el) {
            el.scrollTop = el.scrollHeight;
            isAtBottomRef.current = true;
          }
        });
      }
    };

    const scheduleFlush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(flushInitial, 50);
    };

    es.addEventListener("history_meta", (ev) => {
      try {
        const meta = JSON.parse((ev as MessageEvent).data);
        setHistoryMeta(meta);
      } catch { /* ignore */ }
    });

    es.addEventListener("message", (ev) => {
      try {
        if (!connected) {
          connected = true;
          setStreamConnected(true);
        }
        const msg = JSON.parse((ev as MessageEvent).data);

        // Streaming delta — accumulate into the in-progress bubble, skip
        // the persisted message stream (the final assistant message follows).
        if (msg?.type === "stream_event") {
          const delta = msg?.event?.delta;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            setStreamingText((t) => t + delta.text);
            if (isAtBottomRef.current) {
              requestAnimationFrame(() => {
                const el = scrollRef.current;
                if (el) el.scrollTop = el.scrollHeight;
              });
            }
          }
          return;
        }
        if (msg?.type === "assistant" || msg?.type === "result" || msg?.type === "user") {
          setStreamingText("");
        }

        if (isInitialLoadRef.current) {
          initialMessages.push(msg);
          scheduleFlush();
        } else {
          setMessages((p) => [...p, msg]);
          if (isAtBottomRef.current) {
            requestAnimationFrame(() => {
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            });
          }
        }
      } catch { /* ignore */ }
    });
    es.addEventListener("state", (ev) => {
      try {
        if (!connected) {
          connected = true;
          setStreamConnected(true);
        }
        const { state: st } = JSON.parse((ev as MessageEvent).data);
        setState(st);
        onRefreshRef.current();
      } catch { /* ignore */ }
    });
    es.onerror = () => {
      // If we never connected and got an error, fall back to historical mode
      if (!connected) {
        es.close();
        setStreamConnected(false);
        // Load from disk with pagination
        fetch(`/api/sessions/${session.id}/history?project=${session.projectSlug}&task=${session.taskSlug}&limit=${PAGE_SIZE}&offset=0`)
          .then((r) => r.json())
          .then((j) => {
            if (j.events) {
              setMessages(j.events);
              setHistoryMeta({
                total: j.total,
                hasMore: j.hasMore,
                offset: j.total - j.events.length,
              });
            }
            isInitialLoadRef.current = false;
            // Scroll to bottom after loading
            requestAnimationFrame(() => {
              const el = scrollRef.current;
              if (el) {
                el.scrollTop = el.scrollHeight;
                isAtBottomRef.current = true;
              }
            });
          });
      }
      // If we were connected before, SSE will auto-reconnect
    };
    return () => {
      es.close();
      if (flushTimer) clearTimeout(flushTimer);
    };
    // Only reconnect SSE when session.id changes, not on state changes
    // State updates come via the SSE stream itself
  }, [session.id, session.projectSlug, session.taskSlug]);

  // Load more (older) messages
  const loadMore = useCallback(async () => {
    if (!historyMeta || !historyMeta.hasMore || isLoadingMore) return;

    setIsLoadingMore(true);
    if (scrollRef.current) {
      prevScrollHeightRef.current = scrollRef.current.scrollHeight;
    }

    try {
      const r = await fetch(
        `/api/sessions/${session.id}/history?project=${session.projectSlug}&task=${session.taskSlug}&limit=${PAGE_SIZE}&offset=${messages.length}`
      );
      const j = await r.json();

      if (j.events && j.events.length > 0) {
        setMessages((p) => [...j.events, ...p]);
        setHistoryMeta({
          total: j.total,
          hasMore: j.hasMore,
          offset: historyMeta.offset + PAGE_SIZE,
        });
      }
    } catch (err) {
      console.error("Failed to load more messages:", err);
    } finally {
      setIsLoadingMore(false);
    }
  }, [historyMeta, isLoadingMore, session.id, session.projectSlug, session.taskSlug, messages.length]);

  // Use streamConnected OR session.isLive to determine if we can interact
  const isLive = streamConnected || session.isLive;

  // Extract todos from the message stream
  const todos = useMemo(() => extractTodosFromMessages(messages), [messages]);

  // Todo panel visibility (defaults to shown when there are todos)
  const [showTodos, setShowTodos] = useState(true);

  // Handle file drop/paste
  const handleFiles = useCallback((files: FileAttachment[]) => {
    setAttachments((prev) => [...prev, ...files]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Upload files and return their server paths
  const uploadFiles = async (files: FileAttachment[]): Promise<UploadedFile[]> => {
    const uploaded: UploadedFile[] = [];
    for (const att of files) {
      const formData = new FormData();
      formData.append("file", att.file);
      const res = await fetch(
        `/api/files/upload?project=${session.projectSlug}&task=${session.taskSlug}`,
        { method: "POST", body: formData }
      );
      if (res.ok) {
        const data = await res.json();
        uploaded.push({
          name: data.name,
          path: data.path,
          mimeType: data.mimeType,
          size: data.size,
        });
      }
    }
    return uploaded;
  };

  const send = async () => {
    if ((!draft.trim() && attachments.length === 0) || sending || uploading) return;
    setSending(true);
    setUploading(attachments.length > 0);
    try {
      // Upload attachments first
      let uploadedFiles: UploadedFile[] = [];
      if (attachments.length > 0) {
        uploadedFiles = await uploadFiles(attachments);
      }

      const contextPrefix = filePath ? `[Re: ${filePath}]\n\n` : "";
      await fetch(`/api/sessions/${session.id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: contextPrefix + (draft.trim() || "(attached files)"),
          projectSlug: session.projectSlug,
          taskSlug: session.taskSlug,
          files: uploadedFiles.length > 0 ? uploadedFiles : undefined,
        }),
      });
      setDraft("");
      setAttachments([]);
    } finally {
      setSending(false);
      setUploading(false);
    }
  };

  const stop = async () => {
    await fetch(`/api/sessions/${session.id}/interrupt`, { method: "POST" });
  };

  const isWorking = state === "running";
  const isAwaiting = state === "awaiting_input";

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {/* Load more button at top for older messages */}
        {historyMeta?.hasMore && (
          <div className="text-center">
            <button
              onClick={loadMore}
              disabled={isLoadingMore}
              className="text-[11px] text-[var(--accent)] hover:text-[var(--text)] disabled:opacity-50 px-2 py-1 rounded border border-[var(--border)] hover:border-[var(--accent)] transition"
            >
              {isLoadingMore ? "Loading…" : `Load more (${historyMeta.total - messages.length})`}
            </button>
          </div>
        )}
        <PanelMessageStream messages={messages} />
        {streamingText && (
          <div className="opacity-90 relative">
            <PanelMarkdown text={streamingText} />
            <span className="dots inline-block ml-0.5" aria-hidden />
          </div>
        )}
        {messages.length === 0 && !streamingText && (
          <div className="text-[var(--muted)] text-[12.5px]">
            {isLive ? "Waiting for the agent to start…" : "Loading conversation…"}
          </div>
        )}
        {isWorking && !streamingText && (
          <div className="flex items-center gap-2 text-[12.5px] text-[var(--accent)]">
            <span className="inline-block w-2 h-2 rounded-full bg-[var(--accent)] pulse" />
            <span>Working<span className="dots" aria-hidden /></span>
          </div>
        )}
      </div>

      {/* Todo list above input when present */}
      {todos.length > 0 && (
        <div className="border-t border-[var(--border)] bg-[var(--bg-2)]">
          {showTodos ? (
            <div className="px-2.5 pt-2.5 pb-1">
              <div className="relative">
                <TodoList todos={todos} compact />
                <button
                  onClick={() => setShowTodos(false)}
                  className="absolute top-1 right-1 text-[var(--muted)] hover:text-[var(--text)] p-1 rounded hover:bg-[var(--panel-2)] transition"
                  title="Hide tasks"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          ) : (
            <div className="px-2.5 py-1.5 flex items-center justify-between">
              <button
                onClick={() => setShowTodos(true)}
                className="flex items-center gap-1.5 text-[11px] text-[var(--muted)] hover:text-[var(--text)] transition"
                title="Show tasks"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
                </svg>
                <span>
                  {todos.filter(t => t.status === "completed").length}/{todos.length} tasks
                </span>
              </button>
            </div>
          )}
        </div>
      )}

      <div className="border-t border-[var(--border)] p-2.5 bg-[var(--bg-2)]">
        <FileDropZone onFiles={handleFiles} className="rounded-xl">
          {attachments.length > 0 && (
            <div className="px-2 pt-1.5">
              <AttachmentPreview attachments={attachments} onRemove={removeAttachment} compact />
            </div>
          )}
          <div className="rounded-xl border border-[var(--border-strong)] bg-[var(--panel)] flex items-end gap-2 px-2 py-1.5 focus-within:border-[var(--accent)] transition">
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={isAwaiting ? "Reply…" : state === "stopped" || state === "error" ? "Continue…" : "Drop files or message…"}
              rows={1}
              style={{ maxHeight: 140 }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 140) + "px";
              }}
              onKeyDown={(e) => handleComposerEnter(e, send)}
              className="flex-1 resize-none bg-transparent outline-none text-[13.5px] py-1 leading-relaxed"
            />
            <button
              onClick={send}
              disabled={(!draft.trim() && attachments.length === 0) || sending || uploading}
              className="rounded-md bg-[var(--accent)] text-[var(--accent-text)] w-8 h-8 flex items-center justify-center font-semibold disabled:opacity-40 hover:brightness-110 shrink-0"
              title={state === "stopped" || state === "error" ? "Resume session (↵)" : "Send (↵)"}
            >
              {uploading ? "…" : "↑"}
            </button>
            {isWorking && (
              <button
                onClick={stop}
                className="rounded-md border border-[var(--border-strong)] text-[var(--muted)] hover:text-[#dc2626] hover:border-[#dc2626] w-8 h-8 flex items-center justify-center transition shrink-0"
                title="Stop"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            )}
          </div>
        </FileDropZone>
        <div className="text-[10.5px] text-[var(--muted)] px-1 pt-1">
          {state === "error" ? "Session ended with error — send a message to resume" : `${session.projectSlug} · ${session.taskSlug}`}
        </div>
      </div>
    </>
  );
}

function NewSessionComposer({
  draft,
  onDraft,
  onStart,
  starting,
  composerRef,
  placeholder,
  runtime,
  onRuntime,
  effort,
  onEffort,
}: {
  draft: string;
  onDraft: (v: string) => void;
  onStart: () => void;
  starting: boolean;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
  runtime: SessionRuntime;
  onRuntime: (r: SessionRuntime) => void;
  effort: EffortLevel | "";
  onEffort: (e: EffortLevel | "") => void;
}) {
  return (
    <div className="border-t border-[var(--border)] p-2.5 bg-[var(--bg-2)]">
      <div className="rounded-xl border border-[var(--border-strong)] bg-[var(--panel)] flex items-end gap-2 px-2 py-1.5 focus-within:border-[var(--accent)] transition">
        <textarea
          ref={composerRef}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          placeholder={placeholder}
          rows={2}
          style={{ maxHeight: 140 }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 140) + "px";
          }}
          onKeyDown={(e) => handleComposerEnter(e, onStart)}
          className="flex-1 resize-none bg-transparent outline-none text-[13.5px] py-1 leading-relaxed"
        />
        <button
          onClick={onStart}
          disabled={!draft.trim() || starting}
          className="rounded-md bg-[var(--accent)] text-[var(--accent-text)] w-8 h-8 flex items-center justify-center font-semibold disabled:opacity-40 hover:brightness-110 shrink-0"
          title="Start session (↵)"
        >
          ↑
        </button>
      </div>
      <div className="flex items-center justify-between px-1 pt-1">
        <div className="text-[10.5px] text-[var(--muted)]">New session</div>
        <div className="flex items-center gap-1">
          <select
            value={runtime}
            onChange={(e) => onRuntime(e.target.value as SessionRuntime)}
            className="text-[10.5px] bg-transparent text-[var(--muted)] border border-[var(--border)] rounded px-1 py-0.5 outline-none focus:border-[var(--accent)] focus:text-[var(--text)] cursor-pointer"
            title="Agent runtime"
          >
            <option value="claude">Claude</option>
            <option value="gemini">Gemini</option>
          </select>
          <select
            value={effort}
            onChange={(e) => onEffort(e.target.value as EffortLevel | "")}
            className="text-[10.5px] bg-transparent text-[var(--muted)] border border-[var(--border)] rounded px-1 py-0.5 outline-none focus:border-[var(--accent)] focus:text-[var(--text)] cursor-pointer"
            title="Thinking effort (Claude only — guides how much the model thinks)"
            disabled={runtime !== "claude"}
          >
            <option value="">default (high)</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
            <option value="max">max</option>
          </select>
        </div>
      </div>
    </div>
  );
}

// Message rendering (simplified from AgentPanel)
type PanelPart = { type: string; [k: string]: unknown };

function PanelMessageStream({ messages }: { messages: SDKMessageLite[] }) {
  type Chip = { kind: "tool"; part: PanelPart };
  type Item =
    | { kind: "user"; key: string; text: string }
    | { kind: "asst-text"; key: string; text: string }
    | { kind: "chip-row"; key: string; chips: Chip[] }
    | { kind: "result"; key: string }
    | { kind: "error"; key: string; text: string };

  const items: Item[] = [];
  let batch: Chip[] = [];
  let batchKey = "";
  const flush = () => {
    if (batch.length) {
      items.push({ kind: "chip-row", key: batchKey, chips: batch });
      batch = [];
      batchKey = "";
    }
  };

  messages.forEach((m, i) => {
    const mm = m as { type?: string; message?: { content?: unknown } };
    if (mm.type === "user") {
      const text = extractText(mm.message?.content).trim();
      // Hide system-injected resume prompts (see Chat.tsx for context).
      // In the side panel we just drop them silently — no room for a
      // "session resumed" note.
      const isResumePrompt = text === "[Server restarted — please continue where you left off.]";
      if (text && !isResumePrompt) {
        flush();
        items.push({ kind: "user", key: `u-${i}`, text });
      }
    } else if (mm.type === "assistant") {
      const parts = (mm.message?.content as PanelPart[] | undefined) ?? [];
      parts.forEach((p, j) => {
        if (p.type === "tool_use") {
          // Shell calls get their own row (see Chat.tsx for context).
          const name = (p.name as string) || "";
          const isShell = name === "Bash" || name.endsWith("run_shell_command");
          if (isShell) {
            flush();
            items.push({ kind: "chip-row", key: `c-${i}-${j}`, chips: [{ kind: "tool", part: p }] });
          } else {
            if (!batch.length) batchKey = `c-${i}-${j}`;
            batch.push({ kind: "tool", part: p });
          }
        } else if (p.type === "text" && typeof p.text === "string" && (p.text as string).trim()) {
          flush();
          items.push({ kind: "asst-text", key: `at-${i}-${j}`, text: p.text as string });
        }
      });
    } else if (mm.type === "result") {
      flush();
      items.push({ kind: "result", key: `r-${i}` });
    } else if (mm.type === "system") {
      const sys = m as { type: "system"; subtype?: string; message?: string };
      if (sys.subtype === "error" && sys.message) {
        flush();
        items.push({ kind: "error", key: `err-${i}`, text: sys.message });
      }
    }
  });
  flush();

  return (
    <>
      {items.map((it) => {
        if (it.kind === "user") {
          return (
            <div key={it.key} className="flex justify-end">
              <div className="max-w-[88%] rounded-xl rounded-br-sm bg-[var(--user-bubble)] text-[var(--text)] border border-[var(--border)] px-2.5 py-1.5 text-[13px] whitespace-pre-wrap">
                {it.text}
              </div>
            </div>
          );
        }
        if (it.kind === "asst-text") {
          return (
            <div key={it.key} className="text-[13px] leading-relaxed">
              <PanelMarkdown text={it.text} />
            </div>
          );
        }
        if (it.kind === "chip-row") {
          return (
            <div key={it.key} className="flex flex-wrap gap-1">
              {it.chips.map((c, j) => <PanelToolChip key={j} p={c.part} />)}
            </div>
          );
        }
        if (it.kind === "result") {
          return null;
        }
        if (it.kind === "error") {
          return (
            <div key={it.key} className="rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 text-[13px] text-red-400">
              <span className="font-medium">Error:</span> {it.text}
            </div>
          );
        }
        return null;
      })}
    </>
  );
}


function shortenToolName(name: string): string {
  const m = name.match(/^mcp__([^_]+(?:-[^_]+)*)__(.+)$/);
  if (m) return `MCP ${m[2]}`;
  return name;
}

function PanelToolChip({ p }: { p: PanelPart }) {
  const name = shortenToolName(p.name as string);
  // See Chat.tsx ToolChip for the rationale. Truncates harder here since
  // the side panel is narrower.
  const input = p.input as Record<string, unknown> | undefined;
  const summary = panelChipSummary(p.name as string, input);
  return (
    <details className="group inline-block align-top max-w-full">
      <summary
        className="cursor-pointer select-none list-none inline-flex items-center gap-1 text-[11px] text-[var(--accent)] bg-[var(--accent-soft)] hover:bg-[rgba(37,99,235,0.18)] rounded-md px-1.5 py-0.5 border border-[var(--border)] max-w-full"
        title={p.name as string}
      >
        <span className="text-[9px] opacity-70">▸</span>
        <span className="font-mono shrink-0">{name}</span>
        {summary && (
          <span className="text-[var(--text-soft)] truncate max-w-[220px]" title={summary}>
            · {summary}
          </span>
        )}
      </summary>
      <pre className="mt-1 overflow-x-auto text-[10.5px] text-[var(--text-soft)] bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1 max-w-full whitespace-pre-wrap break-words">
        {JSON.stringify(p.input, null, 2)}
      </pre>
    </details>
  );
}

function panelChipSummary(toolName: string, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const pick = (key: string): string => {
    const v = input[key];
    return typeof v === "string" ? v : "";
  };
  const desc = pick("description");
  if (desc) return shortenPanel(desc);
  if (toolName.endsWith("run_shell_command") || toolName === "Bash") {
    const cmd = pick("command");
    if (cmd) return shortenPanel(cmd.replace(/\s+/g, " "));
  }
  for (const k of ["file_path", "filePath", "path", "dir_path", "pattern", "query"]) {
    const v = pick(k);
    if (v) return shortenPanel(v);
  }
  return "";
}

function shortenPanel(s: string): string {
  const trimmed = s.trim();
  return trimmed.length > 80 ? trimmed.slice(0, 77) + "…" : trimmed;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: unknown) => {
        const pp = p as { type?: string; text?: string };
        return pp.type === "text" ? pp.text ?? "" : "";
      })
      .join("");
  }
  return "";
}

const VIDEO_EXT = new Set(["mp4", "webm", "mov", "avi", "mkv", "m4v"]);

function extFromUrl(url: string): string {
  try {
    if (url.startsWith("data:")) return "";
    const parsed = new URL(url, "http://x");
    // Check if there's a 'path' query param (used by /api/files/raw)
    const pathParam = parsed.searchParams.get("path");
    const pathToCheck = pathParam || parsed.pathname;
    const idx = pathToCheck.lastIndexOf(".");
    return idx < 0 ? "" : pathToCheck.slice(idx + 1).toLowerCase();
  } catch {
    const idx = url.lastIndexOf(".");
    return idx < 0 ? "" : url.slice(idx + 1).split(/[?#]/)[0].toLowerCase();
  }
}

// Parse alt text for dimensions: "alt text|600" or "alt text|600x400"
function parseAltWithSize(alt?: string): { alt: string; width?: number; height?: number } {
  if (!alt) return { alt: "" };
  const match = alt.match(/^(.+?)\|(\d+)(?:x(\d+))?$/);
  if (match) {
    return {
      alt: match[1].trim(),
      width: parseInt(match[2], 10),
      height: match[3] ? parseInt(match[3], 10) : undefined,
    };
  }
  return { alt };
}

function PanelMarkdownMedia({ src, alt }: { src?: string; alt?: string }) {
  if (!src) return null;
  const ext = extFromUrl(src);
  const { alt: cleanAlt, width, height } = parseAltWithSize(alt);
  const style: React.CSSProperties = {};
  if (width) style.width = width;
  if (height) style.height = height;
  if (!width && !height) style.maxHeight = "300px";

  if (VIDEO_EXT.has(ext)) {
    return (
      <video
        src={src}
        controls
        className="max-w-full rounded-lg my-2"
        style={style}
      >
        {cleanAlt && <track kind="captions" label={cleanAlt} />}
      </video>
    );
  }
  return (
    <img
      src={src}
      alt={cleanAlt}
      className="max-w-full rounded-lg my-2"
      style={style}
    />
  );
}

const panelMarkdownComponents = {
  img: ({ src, alt }: { src?: string | Blob; alt?: string }) => (
    <PanelMarkdownMedia src={typeof src === "string" ? src : undefined} alt={alt} />
  ),
};

function PanelMarkdown({ text }: { text: string }) {
  return (
    <div className="prose max-w-none text-[13px] leading-relaxed prose-p:my-1.5 prose-pre:bg-[var(--panel-2)] prose-pre:border prose-pre:border-[var(--border)] prose-code:text-[var(--accent)] prose-code:before:content-none prose-code:after:content-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={panelMarkdownComponents}
      >{text}</ReactMarkdown>
    </div>
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
