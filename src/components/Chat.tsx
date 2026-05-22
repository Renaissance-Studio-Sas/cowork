"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { handleComposerEnter } from "@/lib/composer";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
// Note: we intentionally do NOT use rehype-raw — assistant messages can
// contain XML-like tags (e.g. <quote>, <file>) that React then warns about
// as unknown custom elements. skipHtml strips them cleanly.
import type { SessionSummaryDTO } from "@/lib/types";
import { taskSessionRoute, projectSessionRoute, taskRoute, projectRoute } from "@/lib/routes";
import { TodoList, extractTodosFromMessages } from "./TodoList";
import { FileDropZone, AttachmentPreview, type FileAttachment } from "./FileDropZone";
import { WorkingIndicator } from "./WorkingIndicator";

interface UploadedFile {
  name: string;
  path: string;
  mimeType: string;
  size: number;
}

interface PendingQuestionItem {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string; preview?: string }>;
}

// Number of messages to load initially and per batch
const PAGE_SIZE = 50;

type SDKMessageLite =
  | { type: "user"; message: { role: "user"; content: unknown }; uuid?: string }
  | {
      type: "assistant";
      message: {
        role: "assistant";
        content: Array<
          | { type: "text"; text: string }
          | { type: "tool_use"; id: string; name: string; input: unknown }
        >;
      };
      uuid?: string;
    }
  | { type: "result"; subtype: string; uuid?: string }
  | { type: "system"; subtype: string }
  | Record<string, unknown>;

interface Props {
  session: SessionSummaryDTO;
  onChange: () => void;
  onBack: () => void;
}

// Draft text persisted in localStorage, keyed by session id. Survives both:
//   - state transitions inside Chat (live composer ↔ ContinueComposer swap on pause)
//   - component unmount/remount (navigating away and back)
// Both composers pass the same sessionId so they share the same storage slot.
function useStickyDraft(sessionId: string): [string, (v: string) => void] {
  const storageKey = `wb-draft-${sessionId}`;
  const [draft, setDraftState] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try { return localStorage.getItem(storageKey) ?? ""; } catch { return ""; }
  });

  // If sessionId changes (rare — same Chat instance reused for a different
  // session), reload the new session's saved draft.
  const prevKeyRef = useRef(storageKey);
  useEffect(() => {
    if (prevKeyRef.current === storageKey) return;
    prevKeyRef.current = storageKey;
    try { setDraftState(localStorage.getItem(storageKey) ?? ""); } catch { /* ignore */ }
  }, [storageKey]);

  const setDraft = useCallback((v: string) => {
    setDraftState(v);
    try {
      if (v) localStorage.setItem(storageKey, v);
      else localStorage.removeItem(storageKey);
    } catch { /* ignore */ }
  }, [storageKey]);

  return [draft, setDraft];
}

export function Chat({ session, onChange, onBack }: Props) {
  const router = useRouter();
  const [messages, setMessages] = useState<SDKMessageLite[]>([]);
  const [state, setState] = useState<string>("idle");
  const [draft, setDraft] = useStickyDraft(session.id);
  const [sending, setSending] = useState(false);
  // Track whether we have an active SSE connection (session is truly live)
  const [streamConnected, setStreamConnected] = useState(false);
  // In-progress streaming text for the current assistant turn. Accumulates
  // text_delta events from `stream_event` SDK messages; cleared when the
  // final `assistant` message arrives (which carries the same text and
  // becomes the canonical bubble). Rendered as an extra asst-text item at
  // the end of the message list so the user sees text forming live.
  const [streamingText, setStreamingText] = useState<string>("");
  // Session management state
  const [showMenu, setShowMenu] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [editName, setEditName] = useState(session.title);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // File attachment state
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [uploading, setUploading] = useState(false);

  // Tool calls awaiting user approval (today: only ExitPlanMode). Keyed by
  // toolUseId. Populated from SSE `permission_request` events, cleared on
  // `permission_resolved` (echoed when the user clicks Approve/Deny).
  const [pendingPermissions, setPendingPermissions] = useState<
    Map<string, { toolName: string; input: Record<string, unknown> }>
  >(new Map());

  // AskUserQuestion calls the agent has parked. Keyed by questionId.
  // Populated from `question_request`, cleared on `question_resolved`.
  const [pendingQuestions, setPendingQuestions] = useState<
    Map<string, { questions: PendingQuestionItem[] }>
  >(new Map());

  // `suggest_session_complete` requests the agent has parked, awaiting an
  // Approve / Dismiss from the user. Keyed by requestId.
  const [pendingCompletions, setPendingCompletions] = useState<
    Map<string, { reason: string | null }>
  >(new Map());

  // Sticky completion mark — drives the header badge and the Mark complete /
  // Reopen toggle. Bootstraps from the DTO (which the listing API populates
  // from meta.json) and stays in sync via `completed_changed` SSE events so
  // the badge flips immediately when the user toggles it or the agent's
  // suggestion is approved.
  const [completed, setCompletedState] = useState<boolean>(session.completed);

  // Lazy loading state
  const [historyMeta, setHistoryMeta] = useState<{ total: number; hasMore: boolean; offset: number } | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const isAtBottomRef = useRef(true);
  const prevScrollHeightRef = useRef(0);
  const isInitialLoadRef = useRef(true);

  // Check if user is scrolled to bottom (within threshold)
  const checkIfAtBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    const threshold = 100;
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

  // Stable reference to onChange to avoid re-running the effect
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    setMessages([]);
    setState(session.state);
    setStreamConnected(false);
    setHistoryMeta(null);
    setPendingPermissions(new Map());
    setPendingQuestions(new Map());
    setPendingCompletions(new Map());
    setCompletedState(session.completed);
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
        // Scroll to bottom after initial render (no jump — content appears at bottom)
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

        // stream_event: per-token delta from the runtime. Accumulate text
        // into the in-progress bubble; don't push to messages (the final
        // `assistant` message below carries the canonical text).
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
        // Final assistant message (or any non-stream event) — clear the
        // in-progress bubble so it doesn't double up with the persisted
        // message about to render.
        if (msg?.type === "assistant" || msg?.type === "result" || msg?.type === "user") {
          setStreamingText("");
        }

        if (isInitialLoadRef.current) {
          // Batch initial messages and flush after a brief delay
          initialMessages.push(msg);
          scheduleFlush();
        } else {
          // Append new message and auto-scroll if at bottom
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
        onChangeRef.current();
      } catch { /* ignore */ }
    });
    es.addEventListener("permission_request", (ev) => {
      try {
        const { toolUseId, toolName, input } = JSON.parse((ev as MessageEvent).data);
        setPendingPermissions((prev) => {
          const next = new Map(prev);
          next.set(toolUseId, { toolName, input });
          return next;
        });
      } catch { /* ignore */ }
    });
    es.addEventListener("permission_resolved", (ev) => {
      try {
        const { toolUseId } = JSON.parse((ev as MessageEvent).data);
        setPendingPermissions((prev) => {
          if (!prev.has(toolUseId)) return prev;
          const next = new Map(prev);
          next.delete(toolUseId);
          return next;
        });
      } catch { /* ignore */ }
    });
    es.addEventListener("question_request", (ev) => {
      try {
        const { questionId, questions } = JSON.parse((ev as MessageEvent).data);
        setPendingQuestions((prev) => {
          const next = new Map(prev);
          next.set(questionId, { questions });
          return next;
        });
      } catch { /* ignore */ }
    });
    es.addEventListener("question_resolved", (ev) => {
      try {
        const { questionId } = JSON.parse((ev as MessageEvent).data);
        setPendingQuestions((prev) => {
          if (!prev.has(questionId)) return prev;
          const next = new Map(prev);
          next.delete(questionId);
          return next;
        });
      } catch { /* ignore */ }
    });
    es.addEventListener("completion_request", (ev) => {
      try {
        const { requestId, reason } = JSON.parse((ev as MessageEvent).data);
        setPendingCompletions((prev) => {
          const next = new Map(prev);
          next.set(requestId, { reason: reason ?? null });
          return next;
        });
      } catch { /* ignore */ }
    });
    es.addEventListener("completion_resolved", (ev) => {
      try {
        const { requestId } = JSON.parse((ev as MessageEvent).data);
        setPendingCompletions((prev) => {
          if (!prev.has(requestId)) return prev;
          const next = new Map(prev);
          next.delete(requestId);
          return next;
        });
      } catch { /* ignore */ }
    });
    es.addEventListener("completed_changed", (ev) => {
      try {
        const { completed: c } = JSON.parse((ev as MessageEvent).data);
        setCompletedState(!!c);
        onChangeRef.current();
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

  // Load more (older) messages when scrolling to top
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
        // Prepend older messages
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

  useEffect(() => {
    if (composerRef.current) composerRef.current.focus();
  }, [session.id]);

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
    if (!isLive || (!draft.trim() && attachments.length === 0) || sending || uploading) return;
    setSending(true);
    setUploading(attachments.length > 0);
    try {
      // Upload attachments first
      let uploadedFiles: UploadedFile[] = [];
      if (attachments.length > 0) {
        uploadedFiles = await uploadFiles(attachments);
      }

      await fetch(`/api/sessions/${session.id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: draft.trim() || "(attached files)",
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

  const submitRename = async () => {
    if (!editName.trim()) {
      setIsRenaming(false);
      setEditName(session.title);
      return;
    }
    try {
      await fetch(`/api/sessions/${session.id}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectSlug: session.projectSlug,
          taskSlug: session.taskSlug,
          name: editName.trim(),
        }),
      });
      onChange();
    } catch { /* ignore */ }
    setIsRenaming(false);
  };

  const handleDelete = async () => {
    setShowMenu(false);
    if (!confirm(`Delete session "${session.title}"? This cannot be undone.`)) return;
    try {
      await fetch(`/api/sessions/${session.id}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectSlug: session.projectSlug,
          taskSlug: session.taskSlug,
        }),
      });
      onBack(); // Navigate back after deletion
    } catch { /* ignore */ }
  };

  const canManageSession = !isLive || state === "stopped" || state === "error";

  // Are we in plan mode? Two signals:
  //   1. ExitPlanMode is pending approval → definitely in plan mode, awaiting user
  //   2. The most recent plan-control tool_use is EnterPlanMode (no following
  //      ExitPlanMode yet) → agent is researching/planning
  const inPlanMode = useMemo(() => {
    for (const p of pendingPermissions.values()) {
      if (p.toolName === "ExitPlanMode") return true;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.type !== "assistant") continue;
      const content = (m as { message?: { content?: unknown } }).message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content as Array<{ type?: string; name?: string }>) {
        if (c.type !== "tool_use") continue;
        if (c.name === "ExitPlanMode") return false;
        if (c.name === "EnterPlanMode") return true;
      }
    }
    return false;
  }, [messages, pendingPermissions]);

  const isWorking = state === "running";
  const isAwaiting = state === "awaiting_input";
  const isPaused = state === "idle" || state === "stopped"; // paused, not necessarily complete
  const stateLabel =
    completed ? "completed" :
    isAwaiting ? "needs your reply" :
    isWorking ? "working" :
    state === "error" ? "error" :
    isPaused ? "pending" : "idle";
  const stateColor =
    completed ? "var(--ok)" :
    isAwaiting ? "var(--warn)" :
    isWorking ? "var(--accent)" :
    state === "error" ? "#e87a7a" :
    isPaused ? "var(--muted)" :
    "var(--muted)";

  return (
    <>
      <header className="h-14 border-b border-[var(--border)] flex items-center px-6 gap-3">
        <button
          onClick={onBack}
          className="text-[var(--muted)] hover:text-[var(--text)] text-[13px] -ml-1.5"
          title="Back to task"
        >← Task</button>
        <div className="flex-1 min-w-0">
          {isRenaming ? (
            <input
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={submitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename();
                if (e.key === "Escape") {
                  setIsRenaming(false);
                  setEditName(session.title);
                }
              }}
              className="text-[14px] w-full bg-[var(--panel)] border border-[var(--accent)] rounded px-2 py-0.5 outline-none"
            />
          ) : (
            <div className="text-[14px] truncate">{session.title || "(empty)"}</div>
          )}
          <div className="text-[11.5px] text-[var(--muted)] flex items-center gap-1.5">
            <span>{session.projectSlug}{session.taskSlug ? ` · ${session.taskSlug}` : ""}</span>
            <span>·</span>
            <span
              className={`inline-flex items-center gap-1 ${isAwaiting ? "pulse" : ""}`}
              style={{ color: stateColor }}
            >
              {isWorking ? (
                <WorkingIndicator size={10} title="Working" />
              ) : completed ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{ background: stateColor }}
                />
              )}
              {stateLabel}
              {isWorking && <span className="dots" aria-hidden />}
            </span>
            {inPlanMode && (
              <>
                <span>·</span>
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-medium uppercase tracking-wide border border-[var(--accent)] text-[var(--accent)]">
                  Plan mode
                </span>
              </>
            )}
            {(session.model || session.runtime) && (
              <>
                <span>·</span>
                <span
                  className="font-mono"
                  title={session.model ? `Model: ${session.model}` : `Runtime: ${session.runtime}`}
                >
                  {session.model ?? session.runtime}
                </span>
                <span
                  className="font-mono text-[var(--muted)]"
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
        </div>
        {/* Mark complete / Reopen button — always available so the human can
            flip the flag without waiting for the agent to suggest it. */}
        {!isRenaming && (
          <CompleteToggleButton
            session={session}
            completed={completed}
          />
        )}
        {/* Session menu for stopped sessions */}
        {canManageSession && !isRenaming && (
          <div className="relative">
            <button
              onClick={() => setShowMenu((v) => !v)}
              className="text-[var(--muted)] hover:text-[var(--text)] text-[14px] px-2 py-1 rounded hover:bg-[var(--panel-2)]"
              title="Session options"
            >
              ···
            </button>
            {showMenu && (
              <div className="absolute top-full right-0 mt-1 z-10 bg-[var(--panel)] border border-[var(--border)] rounded-lg shadow-lg py-1 min-w-[100px]">
                <button
                  onClick={() => {
                    setShowMenu(false);
                    setIsRenaming(true);
                    setEditName(session.title);
                  }}
                  className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-[var(--panel-2)]"
                >
                  Rename
                </button>
                <button
                  onClick={handleDelete}
                  className="w-full text-left px-3 py-1.5 text-[12px] text-[#dc2626] hover:bg-[var(--panel-2)]"
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        )}
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-[760px] mx-auto px-6 py-8 space-y-5">
          {/* Load more button at top for older messages */}
          {historyMeta?.hasMore && (
            <div className="text-center">
              <button
                onClick={loadMore}
                disabled={isLoadingMore}
                className="text-[12px] text-[var(--accent)] hover:text-[var(--text)] disabled:opacity-50 px-3 py-1.5 rounded-lg border border-[var(--border)] hover:border-[var(--accent)] transition"
              >
                {isLoadingMore ? "Loading…" : `Load older messages (${historyMeta.total - messages.length} more)`}
              </button>
            </div>
          )}
          <MessageStream messages={messages} />
          {/* In-progress streamed text from the current assistant turn. Lives
              outside the persisted message stream — gets cleared and replaced
              by the final assistant message when the turn completes. Rendered
              through the same Markdown component as final messages so headings,
              code fences, lists, etc. format live as the agent types. */}
          {streamingText && (
            <div className="opacity-90 relative">
              <Markdown text={streamingText} />
              <span className="dots inline-block ml-0.5" aria-hidden />
            </div>
          )}
          {messages.length === 0 && !streamingText && (
            <div className="text-[var(--muted)] text-[13px]">Waiting for the agent to start…</div>
          )}
          {isWorking && !streamingText && (
            <div className="flex items-center gap-2 text-[13px] text-[var(--accent)] pl-1">
              <WorkingIndicator size={14} />
              <span>Working<span className="dots" aria-hidden /></span>
            </div>
          )}
        </div>
      </div>

      {/* Todo list above input when present */}
      {todos.length > 0 && (
        <div className="border-t border-[var(--border)] bg-[var(--bg)]">
          <div className="max-w-[760px] mx-auto px-6">
            {showTodos ? (
              <div className="py-3">
                <div className="relative">
                  <TodoList todos={todos} />
                  <button
                    onClick={() => setShowTodos(false)}
                    className="absolute top-2 right-2 text-[var(--muted)] hover:text-[var(--text)] p-1.5 rounded hover:bg-[var(--panel-2)] transition"
                    title="Hide tasks"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            ) : (
              <div className="py-2 flex items-center">
                <button
                  onClick={() => setShowTodos(true)}
                  className="flex items-center gap-2 text-[12px] text-[var(--muted)] hover:text-[var(--text)] transition"
                  title="Show tasks"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 11l3 3L22 4" />
                    <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
                  </svg>
                  <span>
                    {todos.filter(t => t.status === "completed").length}/{todos.length} tasks completed
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {pendingPermissions.size > 0 && (
        <div className="border-t border-[var(--border)] px-6 py-3 bg-[var(--bg-2)]">
          <div className="max-w-[760px] mx-auto space-y-2">
            {Array.from(pendingPermissions.entries()).map(([toolUseId, p]) => (
              <PlanApprovalCard
                key={toolUseId}
                sessionId={session.id}
                toolUseId={toolUseId}
                toolName={p.toolName}
                input={p.input}
              />
            ))}
          </div>
        </div>
      )}

      {pendingQuestions.size > 0 && (
        <div className="border-t border-[var(--border)] px-6 py-3 bg-[var(--bg-2)]">
          <div className="max-w-[760px] mx-auto space-y-2">
            {Array.from(pendingQuestions.entries()).map(([questionId, p]) => (
              <QuestionCard
                key={questionId}
                sessionId={session.id}
                questionId={questionId}
                questions={p.questions}
              />
            ))}
          </div>
        </div>
      )}

      {pendingCompletions.size > 0 && (
        <div className="border-t border-[var(--border)] px-6 py-3 bg-[var(--bg-2)]">
          <div className="max-w-[760px] mx-auto space-y-2">
            {Array.from(pendingCompletions.entries()).map(([requestId, p]) => (
              <CompletionSuggestionCard
                key={requestId}
                session={session}
                requestId={requestId}
                reason={p.reason}
              />
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-[var(--border)] px-6 py-4 bg-[var(--bg)]">
        <div className="max-w-[760px] mx-auto">
          {/* Show ContinueComposer for stopped/error sessions that need resuming,
              even if they're in the registry (isLive). For truly live sessions
              (running, idle, awaiting_input), show the regular composer. */}
          {isLive && state !== "stopped" && state !== "error" ? (
            <FileDropZone onFiles={handleFiles} className="rounded-2xl">
              {attachments.length > 0 && (
                <div className="px-3 pt-2">
                  <AttachmentPreview attachments={attachments} onRemove={removeAttachment} />
                </div>
              )}
              <div className="rounded-2xl border border-[var(--border-strong)] bg-[var(--panel)] flex items-end gap-2 px-3 py-2 focus-within:border-[var(--accent)] transition">
                <textarea
                  ref={composerRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={state === "awaiting_input" ? "Reply to your agent…" : "Drop files or type a message…"}
                  rows={1}
                  style={{ maxHeight: 200 }}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = Math.min(el.scrollHeight, 200) + "px";
                  }}
                  onKeyDown={(e) => handleComposerEnter(e, send)}
                  className="flex-1 resize-none bg-transparent outline-none text-[14px] py-2 leading-relaxed"
                />
                <button
                  onClick={send}
                  disabled={(!draft.trim() && attachments.length === 0) || sending || uploading}
                  className="rounded-lg bg-[var(--accent)] text-[var(--accent-text)] w-9 h-9 flex items-center justify-center font-semibold disabled:opacity-40 hover:brightness-110 transition shrink-0"
                  title="Send (↵)"
                >{uploading ? "…" : "↑"}</button>
                {isWorking && (
                  <button
                    onClick={stop}
                    className="rounded-lg border border-[var(--border-strong)] text-[var(--text-soft)] hover:text-[#dc2626] hover:border-[#dc2626] w-9 h-9 flex items-center justify-center transition shrink-0"
                    title="Stop"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                  </button>
                )}
              </div>
            </FileDropZone>
          ) : (
            <ContinueComposer session={session} messages={messages} />
          )}
        </div>
      </div>
    </>
  );
}

// Surface a tool-use approval request from the agent's canUseTool callback.
// Today the only tool that gets here is ExitPlanMode — the agent has finished
// a plan and the SDK is asking the user to approve before exiting plan mode
// and letting the agent execute changes.
function PlanApprovalCard({
  sessionId,
  toolUseId,
  toolName,
  input,
}: {
  sessionId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const planText = typeof input.plan === "string" ? input.plan : JSON.stringify(input, null, 2);
  const isPlan = toolName === "ExitPlanMode";

  const decide = async (behavior: "allow" | "deny") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/permission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolUseId,
          behavior,
          updatedInput: behavior === "allow" ? input : undefined,
          message: behavior === "deny" ? "User rejected the plan." : undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setError(j.error ?? "failed");
        return;
      }
      // Inject a confirmation message into the chat
      if (behavior === "allow" && isPlan) {
        const confirmationMessage = "✓ Plan approved. Proceeding with implementation.";
        await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/inject-message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: confirmationMessage, role: "system" }),
        });
      }
      // SSE permission_resolved event will clear this card from parent state
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--accent)] bg-[var(--panel)] p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[12px] font-semibold text-[var(--accent)]">
          {isPlan ? "Plan ready for review" : `Approve ${toolName}?`}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => decide("deny")}
            disabled={busy}
            className="text-[12px] px-3 py-1.5 rounded-md border border-[var(--border-strong)] text-[var(--text-soft)] hover:text-[#dc2626] hover:border-[#dc2626] disabled:opacity-40 transition"
          >
            Deny
          </button>
          <button
            onClick={() => decide("allow")}
            disabled={busy}
            className="text-[12px] px-3 py-1.5 rounded-md bg-[var(--accent)] text-[var(--accent-text)] disabled:opacity-40 hover:brightness-110 transition"
          >
            {busy ? "…" : "Approve & continue"}
          </button>
        </div>
      </div>
      <div className="max-h-[240px] overflow-y-auto rounded-md bg-[var(--bg)] px-3 py-2 text-[13px] prose prose-sm max-w-none [&_*]:!my-1">
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{planText}</ReactMarkdown>
      </div>
      {error && <div className="text-[12px] text-[#dc2626] mt-2">{error}</div>}
    </div>
  );
}

// AskUserQuestion card. The agent has parked one or more questions and is
// blocked on a tool result; submitting here POSTs the user's selections to
// /api/sessions/[id]/question, which resolves the parked Promise on the
// server. The SSE `question_resolved` echo then clears this card.
function QuestionCard({
  sessionId,
  questionId,
  questions,
}: {
  sessionId: string;
  questionId: string;
  questions: PendingQuestionItem[];
}) {
  // selected[i] is the set of option indices the user has picked for
  // question i. otherText[i] is the free text typed into the "Other" input
  // for question i. Both feed into the answers payload at submit time.
  const [selected, setSelected] = useState<Array<Set<number>>>(
    () => questions.map(() => new Set<number>()),
  );
  const [otherText, setOtherText] = useState<string[]>(() => questions.map(() => ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (qi: number, oi: number, multi: boolean) => {
    setSelected((prev) => {
      const next = prev.map((s) => new Set(s));
      if (multi) {
        if (next[qi].has(oi)) next[qi].delete(oi);
        else next[qi].add(oi);
      } else {
        next[qi] = next[qi].has(oi) ? new Set() : new Set([oi]);
      }
      return next;
    });
  };

  const canSubmit = questions.every((_, qi) => {
    return selected[qi].size > 0 || otherText[qi].trim().length > 0;
  });

  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      const answers = questions.map((q, qi) => {
        const sel = Array.from(selected[qi]).map((oi) => q.options[oi].label);
        const other = otherText[qi].trim();
        const out: { selected?: string[]; other?: string } = {};
        if (sel.length > 0) out.selected = sel;
        if (other) out.other = other;
        return out;
      });
      const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, answers }),
      });
      const j = await r.json();
      if (!j.ok) {
        setError(j.error ?? "failed");
        return;
      }
      // SSE question_resolved event will clear this card from parent state
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--accent)] bg-[var(--panel)] p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-semibold text-[var(--accent)]">
          {questions.length === 1 ? "Agent is asking" : `Agent is asking ${questions.length} questions`}
        </div>
        <button
          onClick={submit}
          disabled={!canSubmit || busy}
          className="text-[12px] px-3 py-1.5 rounded-md bg-[var(--accent)] text-[var(--accent-text)] disabled:opacity-40 hover:brightness-110 transition"
        >
          {busy ? "…" : "Send answer"}
        </button>
      </div>

      {questions.map((q, qi) => (
        <div key={qi} className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[10.5px] uppercase tracking-wide font-semibold text-[var(--accent)] bg-[var(--accent-soft)] rounded px-1.5 py-0.5">
              {q.header}
            </span>
            {q.multiSelect && (
              <span className="text-[10.5px] text-[var(--muted)]">multi-select</span>
            )}
          </div>
          <div className="text-[14px] leading-snug">{q.question}</div>
          <div className="space-y-1.5">
            {q.options.map((opt, oi) => {
              const checked = selected[qi].has(oi);
              return (
                <label
                  key={oi}
                  className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition ${
                    checked
                      ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                      : "border-[var(--border)] hover:border-[var(--border-strong)]"
                  }`}
                >
                  <input
                    type={q.multiSelect ? "checkbox" : "radio"}
                    name={`q-${questionId}-${qi}`}
                    checked={checked}
                    onChange={() => toggle(qi, oi, q.multiSelect)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium">{opt.label}</div>
                    <div className="text-[12px] text-[var(--muted)] leading-snug">{opt.description}</div>
                    {opt.preview && (
                      <pre className="mt-1 text-[11px] bg-[var(--bg)] rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap">
                        {opt.preview}
                      </pre>
                    )}
                  </div>
                </label>
              );
            })}
            <div className="rounded-lg border border-[var(--border)] px-3 py-2">
              <div className="text-[11.5px] text-[var(--muted)] mb-1">Other</div>
              <input
                type="text"
                value={otherText[qi]}
                onChange={(e) => setOtherText((prev) => {
                  const next = [...prev];
                  next[qi] = e.target.value;
                  return next;
                })}
                placeholder="Type your own answer…"
                className="w-full bg-transparent outline-none text-[13px] placeholder:text-[var(--muted)]"
              />
            </div>
          </div>
        </div>
      ))}

      {error && <div className="text-[12px] text-[#dc2626]">{error}</div>}
    </div>
  );
}

// Composer for past sessions: resume the existing session via the SDK resume
// mechanism, which preserves full conversation context natively.
function ContinueComposer({ session }: { session: SessionSummaryDTO; messages: SDKMessageLite[] }) {
  const router = useRouter();
  const [draft, setDraft] = useStickyDraft(session.id);
  const [busy, setBusy] = useState(false);

  const resume = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      // Send to the existing session's input endpoint — this will resume it via SDK
      const r = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: draft.trim(),
          projectSlug: session.projectSlug,
          taskSlug: session.taskSlug,
        }),
      });
      const j = await r.json();
      if (!j.ok) { alert(j.error ?? "failed to resume"); return; }
      // Refresh the page to reconnect to SSE stream
      router.refresh();
      setDraft("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-[11.5px] text-[var(--muted)] px-1">
        This session is paused. Sending a message will resume it with full conversation context.
      </div>
      <div className="rounded-2xl border border-[var(--border-strong)] bg-[var(--panel)] flex items-end gap-2 px-3 py-2 focus-within:border-[var(--accent)] transition">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Continue the conversation…"
          rows={2}
          style={{ maxHeight: 200 }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 200) + "px";
          }}
          onKeyDown={(e) => handleComposerEnter(e, resume)}
          className="flex-1 resize-none bg-transparent outline-none text-[14px] py-2 leading-relaxed"
        />
        <button
          onClick={resume}
          disabled={!draft.trim() || busy}
          className="rounded-lg bg-[var(--accent)] text-[var(--accent-text)] w-9 h-9 flex items-center justify-center font-semibold disabled:opacity-40 hover:brightness-110 transition shrink-0"
          title="Resume session (↵)"
        >↑</button>
      </div>
    </div>
  );
}

// Header button — toggles the session's sticky completion flag. When the
// session is already complete it offers Reopen (which only clears the flag;
// sending a new message in the composer is what actually resumes work).
function CompleteToggleButton({
  session,
  completed,
}: {
  session: SessionSummaryDTO;
  completed: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const nextCompleted = !completed;
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectSlug: session.projectSlug,
          taskSlug: session.taskSlug,
          completed: nextCompleted,
        }),
      });
      // The SSE `completed_changed` event will flip the local state.
      // After marking complete, drop the user back at the task/project view —
      // the session is closed, so the session page is no longer the right
      // place to be. Reopen stays on the session page so the user can keep
      // working.
      if (nextCompleted) {
        const base = session.taskSlug
          ? taskRoute(session.projectSlug, session.taskSlug)
          : projectRoute(session.projectSlug);
        router.push(base);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      onClick={toggle}
      disabled={busy}
      className={`text-[12px] px-3 py-1.5 rounded-lg border transition disabled:opacity-50 ${
        completed
          ? "border-[var(--border-strong)] text-[var(--text-soft)] hover:bg-[var(--panel-2)]"
          : "border-[var(--ok)] text-[var(--ok)] hover:bg-[var(--ok-soft)]"
      }`}
      title={completed ? "Reopen this session" : "Mark this session complete"}
    >
      {completed ? "↺ Reopen" : "✓ Mark complete"}
    </button>
  );
}

// Approve/Dismiss card for an agent's `suggest_session_complete` request.
// Approve marks the session complete and unblocks the agent's tool call
// with "approved". Dismiss leaves the flag alone and tells the agent to keep
// working.
function CompletionSuggestionCard({
  session,
  requestId,
  reason,
}: {
  session: SessionSummaryDTO;
  requestId: string;
  reason: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (approved: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectSlug: session.projectSlug,
          taskSlug: session.taskSlug,
          completed: approved,
          requestId,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setError(j.error ?? "failed");
        return;
      }
      // SSE completion_resolved clears the card; completed_changed flips the badge.
      // On approval, navigate to the base view — the session is wrapped up.
      // Dismiss keeps the user on the session so they can keep iterating.
      if (approved) {
        const base = session.taskSlug
          ? taskRoute(session.projectSlug, session.taskSlug)
          : projectRoute(session.projectSlug);
        router.push(base);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--ok)] bg-[var(--panel)] p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-[var(--ok)] flex items-center gap-1.5">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Agent suggests this session is complete
          </div>
          {reason && (
            <div className="text-[12.5px] text-[var(--text-soft)] mt-1 truncate">{reason}</div>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => decide(false)}
            disabled={busy}
            className="text-[12px] px-3 py-1.5 rounded-md border border-[var(--border-strong)] text-[var(--text-soft)] hover:bg-[var(--panel-2)] disabled:opacity-40 transition"
          >
            Dismiss
          </button>
          <button
            onClick={() => decide(true)}
            disabled={busy}
            className="text-[12px] px-3 py-1.5 rounded-md bg-[var(--ok)] text-white disabled:opacity-40 hover:brightness-110 transition"
          >
            {busy ? "…" : "Approve & mark complete"}
          </button>
        </div>
      </div>
      {error && <div className="text-[12px] text-[#dc2626] mt-2">{error}</div>}
    </div>
  );
}

// Errors the agent SDK throws when an in-flight turn is interrupted/aborted.
// These are the expected consequence of a user stopping the agent — not real
// failures — so we render the neutral interruption note instead of an error
// box. Matched both for live `system: error` events and when replaying older
// session logs that persisted the diagnostic before the server-side fix.
function isInterruptNoise(text: string | undefined | null): boolean {
  if (!text) return false;
  return /request was aborted|ede_diagnostic|returned an error result/i.test(text);
}

// Flatten the message stream into render items, batching consecutive tool
// calls (across messages) into a single inline-flex row of compact chips.
// Visible text and user messages break the row.
function MessageStream({ messages }: { messages: SDKMessageLite[] }) {
  type Chip = { kind: "tool"; part: Part };
  type Item =
    | { kind: "user"; key: string; text: string }
    | { kind: "asst-text"; key: string; text: string }
    | { kind: "chip-row"; key: string; chips: Chip[] }
    | { kind: "result"; key: string }
    | { kind: "system-info"; key: string; text: string }
    | { kind: "system-note"; key: string; text: string }
    | { kind: "system-error"; key: string; text: string };

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
      // User messages can also be tool-result echoes (no visible text). Those
      // mustn't break the chip row — only flush when there's actual text.
      const text = extractText(mm.message?.content).trim();
      // Hide system-injected resume prompts (sessions.ts pushes this as a
      // user message so the model has something to continue from after a
      // server restart — but it's not actually FROM the user). Surfaced as
      // a small "session resumed" note via system-info instead.
      const isResumePrompt = text === "[Server restarted — please continue where you left off.]";
      // The SDK injects "[Request interrupted by user]" as a user message when a
      // turn is stopped. It's not something the user typed — surface it as a
      // neutral interruption note instead of a chat bubble.
      const isInterruptNote = text === "[Request interrupted by user]";
      if (isResumePrompt) {
        flush();
        items.push({ kind: "system-info", key: `sr-${i}`, text: "Session resumed after server restart." });
      } else if (isInterruptNote) {
        flush();
        items.push({ kind: "system-note", key: `int-${i}`, text: "Session interrupted by the user." });
      } else if (text) {
        flush();
        items.push({ kind: "user", key: `u-${i}`, text });
      }
    } else if (mm.type === "assistant") {
      // Synthetic assistant messages are SDK-generated error/status carriers
      // (e.g. rate limits, aborts), not real model output. The matching
      // `result` message surfaces the error as a proper error box below, so
      // skip the synthetic text here to avoid rendering it twice.
      const model = (mm.message as { model?: string } | undefined)?.model;
      if (model === "<synthetic>") return;
      const parts = (mm.message?.content as Part[] | undefined) ?? [];
      parts.forEach((p, j) => {
        if (p.type === "tool_use") {
          if (!batch.length) batchKey = `c-${i}-${j}`;
          batch.push({ kind: "tool", part: p });
        } else if (p.type === "text" && typeof p.text === "string" && (p.text as string).trim()) {
          flush();
          items.push({ kind: "asst-text", key: `at-${i}-${j}`, text: p.text as string });
        }
      });
    } else if (mm.type === "result") {
      flush();
      // A result with is_error (e.g. api_error_status 429 rate limit) means the
      // turn ended in failure. Surface it as an error box; the SDK's `result`
      // text is already human-readable ("You've hit your session limit …").
      const res = m as { is_error?: boolean; result?: string; subtype?: string };
      // An interrupted turn ends with an "error_during_execution" result (or an
      // abort diagnostic in `result`). That's the user stopping the agent, not a
      // failure — the interruption note already covers it, so skip the error box.
      if (res.subtype === "error_during_execution" || isInterruptNoise(res.result)) {
        items.push({ kind: "result", key: `r-${i}` });
      } else if (res.is_error) {
        const text = res.result?.trim() || "The agent stopped due to an error.";
        items.push({ kind: "system-error", key: `re-${i}`, text });
      } else {
        items.push({ kind: "result", key: `r-${i}` });
      }
    } else if (mm.type === "system") {
      const sysMsg = m as { subtype?: string; message?: string };
      if (sysMsg.subtype === "info" && sysMsg.message) {
        flush();
        items.push({ kind: "system-info", key: `si-${i}`, text: sysMsg.message });
      } else if (sysMsg.subtype === "error" && sysMsg.message) {
        flush();
        // An interrupt aborts the in-flight SDK request, which can surface as an
        // abort/"ede_diagnostic" error. Don't render it — the interruption note
        // already explains what happened. (Older session logs persisted this
        // before the server-side fix, so keep filtering it on replay.)
        if (isInterruptNoise(sysMsg.message)) return;
        items.push({ kind: "system-error", key: `se-${i}`, text: sysMsg.message });
      }
    }
  });
  flush();

  return (
    <>
      {items.map((it) => {
        if (it.kind === "user") {
          const parsed = parseAddressCommentsMessage(it.text);
          return (
            <div key={it.key} className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl rounded-br-md bg-[var(--user-bubble)] text-[var(--text)] px-4 py-2.5 text-[14px] leading-relaxed border border-[var(--border)]">
                {parsed ? <CommentBriefBubble parsed={parsed} /> : <span className="whitespace-pre-wrap">{it.text}</span>}
              </div>
            </div>
          );
        }
        if (it.kind === "asst-text") {
          return (
            <div key={it.key} className="text-[14px] leading-relaxed">
              <Markdown text={it.text} />
            </div>
          );
        }
        if (it.kind === "chip-row") {
          return (
            <div key={it.key} className="flex flex-wrap gap-1">
              {it.chips.map((c, j) => <ToolChip key={j} p={c.part} />)}
            </div>
          );
        }
        if (it.kind === "result") {
          return null;
        }
        if (it.kind === "system-info") {
          return (
            <div key={it.key} className="flex justify-center">
              <div className="rounded-lg bg-[var(--ok-soft)] border border-[var(--ok)] text-[var(--ok)] px-3 py-1.5 text-[12.5px] font-medium">
                {it.text}
              </div>
            </div>
          );
        }
        if (it.kind === "system-note") {
          return (
            <div key={it.key} className="flex justify-center">
              <div className="rounded-lg bg-[var(--bg-2)] border border-[var(--border)] text-[var(--muted)] px-3 py-1.5 text-[12.5px] font-medium">
                {it.text}
              </div>
            </div>
          );
        }
        if (it.kind === "system-error") {
          return (
            <div key={it.key} className="flex justify-center">
              <div className="rounded-lg bg-red-500/10 border border-red-500/40 text-red-400 px-3 py-1.5 text-[12.5px] font-medium max-w-[80%] text-center">
                {it.text}
              </div>
            </div>
          );
        }
        return null;
      })}
    </>
  );
}

function Bubble({ msg }: { msg: SDKMessageLite }) {
  const m = msg as { type: string; [k: string]: unknown };

  if (m.type === "user") {
    const content = extractText((m as { message?: { content?: unknown } }).message?.content);
    if (!content.trim()) return null;
    const parsed = parseAddressCommentsMessage(content);
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-[var(--user-bubble)] text-[var(--text)] px-4 py-2.5 text-[14px] leading-relaxed border border-[var(--border)]">
          {parsed ? <CommentBriefBubble parsed={parsed} /> : <span className="whitespace-pre-wrap">{content}</span>}
        </div>
      </div>
    );
  }

  if (m.type === "assistant") {
    const parts = ((m as { message?: { content?: unknown[] } }).message?.content ?? []) as Array<{ type: string; [k: string]: unknown }>;
    const groups = groupAssistantParts(parts);
    return (
      <div className="space-y-2">
        {groups.map((g, i) => {
          if (g.type === "tools") {
            return (
              <div key={i} className="flex flex-wrap gap-1">
                {g.parts.map((p, j) => <ToolChip key={j} p={p} />)}
              </div>
            );
          }
          const p = g.part;
          if (p.type === "text") {
            return (
              <div key={i} className="text-[14px] leading-relaxed">
                <Markdown text={p.text as string} />
              </div>
            );
          }
          return null;
        })}
      </div>
    );
  }

  if (m.type === "result") {
    return null;
  }

  return null;
}

// Detects the "Send to agent" comment-briefing message and pulls the file
// path + each comment chip out so we can render it as a card instead of a
// wall of text.
function parseAddressCommentsMessage(text: string): null | {
  filePath: string;
  items: Array<{ id?: number; quote: string; body: string }>;
  footer: string;
} {
  const headerMatch = text.match(/^Please address (?:the following )?comments? on `([^`]+)`:/);
  if (!headerMatch) return null;
  const filePath = headerMatch[1];
  const lines = text.split("\n");
  const items: Array<{ id?: number; quote: string; body: string }> = [];
  let footer = "";
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^- (?:\[comment #(\d+)\] )?on "([^"]*)" — (.+)$/);
    if (m) {
      items.push({ id: m[1] ? Number(m[1]) : undefined, quote: m[2], body: m[3] });
      continue;
    }
    if (items.length > 0 && line.trim() && !line.startsWith("-")) {
      footer = lines.slice(i).join("\n").trim();
      break;
    }
  }
  if (items.length === 0) return null;
  return { filePath, items, footer };
}

function CommentBriefBubble({ parsed }: { parsed: NonNullable<ReturnType<typeof parseAddressCommentsMessage>> }) {
  const [showFooter, setShowFooter] = useState(false);
  return (
    <div className="space-y-2">
      <div className="text-[12px] uppercase tracking-wider text-[var(--muted)] font-semibold">
        Address comments
      </div>
      <div className="text-[13px]">
        on <span className="font-mono text-[12.5px] bg-[rgba(0,0,0,0.06)] rounded px-1.5 py-0.5">{parsed.filePath}</span>
      </div>
      <div className="space-y-1.5 pt-1">
        {parsed.items.map((c, i) => (
          <div key={i} className="rounded-lg bg-[rgba(255,255,255,0.55)] border border-[rgba(0,0,0,0.06)] px-2.5 py-1.5 text-[12.5px]">
            <div className="italic text-[var(--text-soft)] truncate">&ldquo;{c.quote}&rdquo;</div>
            <div className="mt-0.5">{c.body}</div>
          </div>
        ))}
      </div>
      {parsed.footer && (
        <button
          onClick={() => setShowFooter((v) => !v)}
          className="text-[11.5px] text-[var(--muted)] hover:text-[var(--text)] underline underline-offset-2"
        >
          {showFooter ? "hide instructions" : "show instructions"}
        </button>
      )}
      {showFooter && (
        <div className="text-[12px] text-[var(--text-soft)] whitespace-pre-wrap pt-1">{parsed.footer}</div>
      )}
    </div>
  );
}

// Group consecutive `tool_use` parts so we can render them as a row of compact
// chips. Non-tool parts (text) stay as standalone blocks.
type Part = { type: string; [k: string]: unknown };
type AssistantGroup =
  | { type: "tools"; parts: Part[] }
  | { type: "other"; part: Part };

function groupAssistantParts(parts: Part[]): AssistantGroup[] {
  const out: AssistantGroup[] = [];
  let batch: Part[] = [];
  const flush = () => {
    if (batch.length) { out.push({ type: "tools", parts: batch }); batch = []; }
  };
  for (const p of parts) {
    if (p.type === "tool_use") batch.push(p);
    else { flush(); out.push({ type: "other", part: p }); }
  }
  flush();
  return out;
}

// `mcp__workbench-comments__list_comments` → `MCP list_comments`
function shortenToolName(name: string): string {
  const m = name.match(/^mcp__([^_]+(?:-[^_]+)*)__(.+)$/);
  if (m) return `MCP ${m[2]}`;
  return name;
}

function ToolChip({ p }: { p: Part }) {
  const name = shortenToolName(p.name as string);
  return (
    <details className="group inline-block align-top max-w-full">
      <summary
        className="cursor-pointer select-none list-none inline-flex items-center gap-1 text-[11.5px] text-[var(--accent)] bg-[var(--accent-soft)] hover:bg-[rgba(37,99,235,0.18)] rounded-md px-2 py-0.5 border border-[var(--border)] max-w-full"
        title={p.name as string}
      >
        <span className="text-[9px] opacity-70">▸</span>
        <span className="font-mono shrink-0">{name}</span>
      </summary>
      <pre className="mt-1 overflow-x-auto text-[11px] text-[var(--text-soft)] bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1.5 max-w-full whitespace-pre-wrap break-words">
        {JSON.stringify(p.input, null, 2)}
      </pre>
    </details>
  );
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
    // Handle data URLs - they're not videos
    if (url.startsWith("data:")) return "";
    const parsed = new URL(url, "http://x");
    // Check if there's a 'path' query param (used by /api/files/raw)
    const pathParam = parsed.searchParams.get("path");
    const pathToCheck = pathParam || parsed.pathname;
    const idx = pathToCheck.lastIndexOf(".");
    return idx < 0 ? "" : pathToCheck.slice(idx + 1).toLowerCase();
  } catch {
    // Fallback for relative paths
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

function MarkdownMedia({ src, alt }: { src?: string; alt?: string }) {
  if (!src) return null;
  const ext = extFromUrl(src);
  const { alt: cleanAlt, width, height } = parseAltWithSize(alt);
  const style: React.CSSProperties = {};
  if (width) style.width = width;
  if (height) style.height = height;
  if (!width && !height) style.maxHeight = "400px";

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

const markdownComponents = {
  img: ({ src, alt }: { src?: string | Blob; alt?: string }) => (
    <MarkdownMedia src={typeof src === "string" ? src : undefined} alt={alt} />
  ),
};

function Markdown({ text }: { text: string }) {
  return (
    <div className="prose max-w-none text-[14px] leading-relaxed prose-p:my-2 prose-pre:bg-[var(--panel-2)] prose-pre:border prose-pre:border-[var(--border)] prose-code:text-[var(--accent)] prose-code:before:content-none prose-code:after:content-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={markdownComponents}
      >{text}</ReactMarkdown>
    </div>
  );
}
