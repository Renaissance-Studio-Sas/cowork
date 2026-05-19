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
import { taskSessionRoute, projectSessionRoute } from "@/lib/routes";
import { TodoList, extractTodosFromMessages } from "./TodoList";
import { FileDropZone, AttachmentPreview, type FileAttachment } from "./FileDropZone";

interface UploadedFile {
  name: string;
  path: string;
  mimeType: string;
  size: number;
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
          | { type: "thinking"; thinking: string }
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

export function Chat({ session, onChange, onBack }: Props) {
  const router = useRouter();
  const [messages, setMessages] = useState<SDKMessageLite[]>([]);
  const [state, setState] = useState<string>("idle");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // Track whether we have an active SSE connection (session is truly live)
  const [streamConnected, setStreamConnected] = useState(false);
  // Session management state
  const [showMenu, setShowMenu] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [editName, setEditName] = useState(session.title);
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

  const isWorking = state === "running";
  const isAwaiting = state === "awaiting_input";
  const isDone = state === "idle" || state === "stopped"; // stopped sessions seamlessly resume, treat as done
  const stateLabel =
    isAwaiting ? "needs your reply" :
    isWorking ? "working" :
    state === "error" ? "error" :
    isDone ? "done" : "idle";
  const stateColor =
    isAwaiting ? "var(--warn)" :
    isWorking ? "var(--accent)" :
    state === "error" ? "#e87a7a" :
    isDone ? "var(--ok)" :
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
              className={`inline-flex items-center gap-1 ${isAwaiting || isWorking ? "pulse" : ""}`}
              style={{ color: stateColor }}
            >
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full`}
                style={{ background: stateColor }}
              />
              {stateLabel}
              {isWorking && <span className="dots" aria-hidden />}
            </span>
          </div>
        </div>
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
          {messages.length === 0 && (
            <div className="text-[var(--muted)] text-[13px]">Waiting for the agent to start…</div>
          )}
          {isWorking && (
            <div className="flex items-center gap-2 text-[13px] text-[var(--accent)] pl-1">
              <span className="inline-block w-2 h-2 rounded-full bg-[var(--accent)] pulse" />
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

// Composer for past sessions: resume the existing session via the SDK resume
// mechanism, which preserves full conversation context natively.
function ContinueComposer({ session }: { session: SessionSummaryDTO; messages: SDKMessageLite[] }) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
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

// Flatten the message stream into render items, batching consecutive tool
// calls and thinking blocks (across messages) into a single inline-flex
// row of compact chips. Visible text and user messages break the row.
function MessageStream({ messages }: { messages: SDKMessageLite[] }) {
  type Chip =
    | { kind: "tool"; part: Part }
    | { kind: "think"; text: string };
  type Item =
    | { kind: "user"; key: string; text: string }
    | { kind: "asst-text"; key: string; text: string }
    | { kind: "chip-row"; key: string; chips: Chip[] }
    | { kind: "result"; key: string };

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
      if (text) {
        flush();
        items.push({ kind: "user", key: `u-${i}`, text });
      }
    } else if (mm.type === "assistant") {
      const parts = (mm.message?.content as Part[] | undefined) ?? [];
      parts.forEach((p, j) => {
        if (p.type === "tool_use") {
          if (!batch.length) batchKey = `c-${i}-${j}`;
          batch.push({ kind: "tool", part: p });
        } else if (p.type === "thinking") {
          if (!batch.length) batchKey = `c-${i}-${j}`;
          batch.push({ kind: "think", text: (p.thinking as string) ?? "" });
        } else if (p.type === "text" && typeof p.text === "string" && (p.text as string).trim()) {
          flush();
          items.push({ kind: "asst-text", key: `at-${i}-${j}`, text: p.text as string });
        }
      });
    } else if (mm.type === "result") {
      flush();
      items.push({ kind: "result", key: `r-${i}` });
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
              {it.chips.map((c, j) => c.kind === "tool"
                ? <ToolChip key={j} p={c.part} />
                : <ThinkChip key={j} text={c.text} />)}
            </div>
          );
        }
        if (it.kind === "result") {
          return (
            <div key={it.key} className="text-[11px] text-[var(--muted)] text-center py-1">
              — turn complete —
            </div>
          );
        }
        return null;
      })}
    </>
  );
}

function ThinkChip({ text }: { text: string }) {
  return (
    <details className="group inline-block align-top max-w-full">
      <summary
        className="cursor-pointer select-none list-none inline-flex items-center gap-1 text-[11.5px] text-[var(--muted)] italic bg-[var(--panel)] hover:bg-[var(--panel-2)] rounded-md px-2 py-0.5 border border-[var(--border)]"
        title="model thinking"
      >
        <span className="text-[9px] opacity-70 not-italic">▸</span>
        <span>thinking</span>
      </summary>
      <pre className="mt-1 overflow-x-auto text-[11px] text-[var(--text-soft)] bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1.5 max-w-full whitespace-pre-wrap break-words not-italic">
        {text}
      </pre>
    </details>
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
          if (p.type === "thinking") {
            return (
              <details key={i} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[12px] text-[var(--muted)] italic">
                <summary className="cursor-pointer select-none">thinking…</summary>
                <div className="mt-2 whitespace-pre-wrap not-italic text-[var(--text-soft)]">{p.thinking as string}</div>
              </details>
            );
          }
          return null;
        })}
      </div>
    );
  }

  if (m.type === "result") {
    return (
      <div className="text-[11px] text-[var(--muted)] text-center py-1">
        — turn complete —
      </div>
    );
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
// chips. Non-tool parts (text, thinking) stay as standalone blocks.
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
        className="cursor-pointer select-none list-none inline-flex items-center gap-1 text-[11.5px] text-[var(--accent)] bg-[var(--accent-soft)] hover:bg-[rgba(37,99,235,0.18)] rounded-md px-2 py-0.5 border border-[var(--border)]"
        title={p.name as string}
      >
        <span className="text-[9px] opacity-70">▸</span>
        <span className="font-mono">{name}</span>
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

function Markdown({ text }: { text: string }) {
  return (
    <div className="prose max-w-none text-[14px] leading-relaxed prose-p:my-2 prose-pre:bg-[var(--panel-2)] prose-pre:border prose-pre:border-[var(--border)] prose-code:text-[var(--accent)] prose-code:before:content-none prose-code:after:content-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{text}</ReactMarkdown>
    </div>
  );
}
