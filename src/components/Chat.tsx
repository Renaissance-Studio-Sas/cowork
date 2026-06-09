"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { handleComposerEnter, handleComposerPaste, useNewlineModifier } from "@/lib/composer";
import type { SessionSummaryDTO } from "@/lib/types";
import { encodeWorkspacePath } from "@/lib/routes";
import { TodoList, extractTodosFromMessages, type TodoItem } from "./TodoList";
import { FileDropZone, AttachmentPreview, filesToAttachments, type FileAttachment } from "./FileDropZone";
import { WorkingIndicator } from "./WorkingIndicator";
import { useStickyDraft } from "./chat/useStickyDraft";
import { MessageStream } from "./chat/MessageStream";
import { extractText, isVisibleSDKMessage } from "./chat/utils";
import { Markdown } from "./chat/Markdown";
import {
  PlanApprovalCard,
  QuestionCard,
  CompletionSuggestionCard,
  CompleteToggleButton,
  BacklogToggleButton,
} from "./chat/cards";
import { ContinueComposer } from "./chat/ContinueComposer";
import { UsageIndicator } from "./chat/UsageIndicator";
import { ModelPicker } from "./chat/ModelPicker";
import { EffortPicker } from "./chat/EffortPicker";
import type { SDKMessageLite, PendingQuestionItem, RateLimitInfoLite } from "./chat/types";

interface UploadedFile {
  name: string;
  path: string;
  mimeType: string;
  size: number;
}

// Number of messages to load initially and per batch
const PAGE_SIZE = 50;

// Detects the SSE echo of a user-typed message — used to pop the optimistic
// bubble queue. Skips tool_result echoes (no visible text), subagent messages,
// and SDK-injected synthetics (resume prompt, interrupt note, compaction
// summary) so those don't accidentally consume a real send.
function isRealUserEcho(msg: unknown): boolean {
  const m = msg as { type?: string; parent_tool_use_id?: string | null; message?: { content?: unknown } };
  if (m?.type !== "user" || m.parent_tool_use_id) return false;
  const text = extractText(m.message?.content)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "")
    .trim();
  if (!text) return false;
  if (text === "[Server restarted — please continue where you left off.]") return false;
  if (text === "[Request interrupted by user]") return false;
  if (text.startsWith("This session is being continued from a previous conversation that ran out of context.")) return false;
  return true;
}

interface Brief {
  label: string;
  overview: string;
  details: string;
}

interface Props {
  session: SessionSummaryDTO;
  onChange: () => void;
  onBack: () => void;
  brief?: Brief | null;
  /**
   * When true, Chat is embedded as a column inside the workspace layout. The
   * host renders its own brief/header context; Chat drops the back button to
   * the parent (project / task) and the inline brief banner.
   */
  embedded?: boolean;
  /**
   * Path of the artifact currently open in the workspace's other column.
   * Passed through to the input endpoint so the agent knows which file the
   * user is looking at when they post a message.
   */
  openArtifactPath?: string;
}

export function Chat({ session, onChange, onBack, brief, embedded = false, openArtifactPath }: Props) {
  const [showBriefDetails, setShowBriefDetails] = useState(false);
  const [messages, setMessages] = useState<SDKMessageLite[]>([]);
  const [state, setState] = useState<string>("idle");
  const [draft, setDraft] = useStickyDraft(session.id);
  // Optimistic user bubbles — rendered immediately when the user hits send so
  // the message appears without waiting for the SSE echo. Each entry is popped
  // (FIFO) when the corresponding `user` SDK message arrives on the stream.
  const [pendingSends, setPendingSends] = useState<Array<{ id: string; text: string }>>([]);
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
  const newlineMod = useNewlineModifier();
  const attachInputRef = useRef<HTMLInputElement>(null);

  // File attachment state
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);

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

  // Set when the remote runner's `claude setup-token` is waiting on the user
  // to paste an OAuth code. Same idea as pendingPermissions/Questions/etc —
  // the session is awaiting user action, not actively computing, so it should
  // read "pending" not "working". Cleared on `auth_done` (success) or
  // `auth_failed` (the user can still re-try; AuthCard stays visible).
  const [pendingAuth, setPendingAuth] = useState(false);

  // Sticky completion mark — drives the header badge and the Mark complete /
  // Reopen toggle. Bootstraps from the DTO (which the listing API populates
  // from meta.json) and stays in sync via `completed_changed` SSE events so
  // the badge flips immediately when the user toggles it or the agent's
  // suggestion is approved.
  const [completed, setCompletedState] = useState<boolean>(session.completed);

  // Sticky backlog mark — drives the composer's Move to Backlog toggle.
  // Bootstraps from the DTO and stays in sync via `backlog_changed` SSE events
  // so the button flips immediately when toggled here or elsewhere.
  const [backlog, setBacklogState] = useState<boolean>(session.backlog);

  // Todo list pushed by the server, derived from the FULL session history. The
  // chat transcript is paginated, so deriving todos from `messages` alone misses
  // tool calls in older, not-yet-loaded messages. Prefer this when present; fall
  // back to client-side derivation (e.g. if the SSE connection failed).
  const [serverTodos, setServerTodos] = useState<TodoItem[] | null>(null);

  // Latest claude.ai subscription usage snapshot for this session, pushed by
  // the server on the `rate_limit` SSE event (and replayed on connect). Drives
  // the small usage indicator below the composer. null until the SDK reports.
  const [rateLimit, setRateLimit] = useState<RateLimitInfoLite | null>(null);

  // Whether the agent is currently failed over to the Anthropic API key because
  // the Claude subscription hit its usage limit. Derived from the latest
  // `provider_switched` event in the stream (provider "api" = on the fallback
  // key, "subscription" = back on the Max plan). Drives the "API fallback" badge
  // shown next to the usage indicator so it's clear the agent is still working,
  // just on metered API billing.
  const fallbackActive = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { type?: string; subtype?: string; provider?: string };
      if (m.type === "system" && m.subtype === "provider_switched") return m.provider === "api";
    }
    return false;
  }, [messages]);

  // Lazy loading state
  const [historyMeta, setHistoryMeta] = useState<{ total: number; hasMore: boolean; offset: number } | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // "Clear" snapshot — when the user clicks Clear, we record the current set of
  // task content strings. The panel stays hidden until a NEW task (one whose
  // content isn't in this snapshot) appears, at which point we reset to null
  // and the panel shows again. Persisted to localStorage so reopening the
  // session keeps it cleared. Declared up here (above the session-reset effect
  // that calls setClearedTasks) so the setter isn't referenced before init.
  const clearedTasksKey = `cowork:clearedTasks:${session.id}`;
  const [clearedTasks, setClearedTasks] = useState<Set<string> | null>(null);

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

  // Stable reference to onChange to avoid re-running the effect.
  const onChangeRef = useRef(onChange);
  // Latest draft + attachments, read at send-error time. Async send() captures
  // both in closure at call time and can't peek at what the user typed while
  // the request was in flight, so we mirror them into refs for the error path.
  const draftRef = useRef(draft);
  const attachmentsRef = useRef(attachments);
  // Mirror the latest values into the refs after each commit. These refs are
  // only read from async callbacks (the SSE effect, the send-error path), never
  // during the same render, so the post-commit timing is fine.
  useEffect(() => {
    onChangeRef.current = onChange;
    draftRef.current = draft;
    attachmentsRef.current = attachments;
  });

  // Derive a stable string key from the workspace path so the SSE effect
  // doesn't tear down on every poll cycle (the WorkspaceContext refresh hands
  // back a fresh `workspacePath` array even when the contents are unchanged).
  const workspacePathKey = useMemo(
    () => session.workspacePath.join("/"),
    [session.workspacePath],
  );

  useEffect(() => {
    // Reset all per-session UI state and (re)open the SSE stream whenever the
    // session changes — an intentional reset-on-prop-change paired with the
    // subscription this effect owns.
    setMessages([]);
    setServerTodos(null);
    setRateLimit(null);
    setClearedTasks(null);
    setState(session.state);
    setStreamConnected(false);
    setHistoryMeta(null);
    setPendingPermissions(new Map());
    setPendingQuestions(new Map());
    setPendingCompletions(new Map());
    setPendingSends([]);
    setCompletedState(session.completed);
    setBacklogState(session.backlog);
    isInitialLoadRef.current = true;

    // Always try to connect to SSE stream first — even if session.isLive is false,
    // the session might actually be live (race condition with API polling)
    const encodedWorkspace = encodeWorkspacePath(session.workspacePath);
    const es = new EventSource(
      `/api/sessions/${session.id}/stream?limit=${PAGE_SIZE}&workspace=${encodedWorkspace}`,
    );
    let connected = false;
    const initialMessages: SDKMessageLite[] = [];
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

    // Server-derived todo list (computed over the full history). Replaces the
    // client-side derivation so the task panel doesn't depend on how much of
    // the transcript has been lazily loaded.
    es.addEventListener("todos", (ev) => {
      try {
        setServerTodos(JSON.parse((ev as MessageEvent).data) as TodoItem[]);
      } catch { /* ignore */ }
    });

    // Subscription usage snapshot — replayed on connect and refreshed whenever
    // the SDK reports new rate-limit info during a turn.
    es.addEventListener("rate_limit", (ev) => {
      try {
        setRateLimit(JSON.parse((ev as MessageEvent).data) as RateLimitInfoLite);
      } catch { /* ignore */ }
    });

    // Server seeds us with the text that streamed before we connected so a
    // mid-stream join shows the full in-progress bubble, not just the
    // post-join tail. Subsequent text_delta events keep appending normally.
    es.addEventListener("stream_snapshot", (ev) => {
      try {
        const { text } = JSON.parse((ev as MessageEvent).data);
        if (typeof text === "string") setStreamingText(text);
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
        // Inline /login flow: flip the "auth pending" flag so the working
        // indicator hides and the session reads as "pending" while the user
        // pastes the OAuth code into the AuthCard. Cleared on auth_done.
        if (msg?.type === "system") {
          if (msg?.subtype === "auth_required") setPendingAuth(true);
          else if (msg?.subtype === "auth_done") setPendingAuth(false);
        }

        if (isInitialLoadRef.current) {
          // Batch initial messages and flush after a brief delay
          initialMessages.push(msg);
          scheduleFlush();
        } else {
          // Append new message and auto-scroll if at bottom
          setMessages((p) => [...p, msg]);
          // When the SSE echoes back a real user-typed message, pop the FIFO
          // head of pendingSends so the optimistic bubble swaps in for the
          // canonical one in the same React batch (no flicker).
          if (isRealUserEcho(msg)) {
            setPendingSends((p) => p.slice(1));
          }
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
    es.addEventListener("backlog_changed", (ev) => {
      try {
        const { backlog: b } = JSON.parse((ev as MessageEvent).data);
        setBacklogState(!!b);
        onChangeRef.current();
      } catch { /* ignore */ }
    });
    es.onerror = () => {
      // If we never connected and got an error, fall back to historical mode
      if (!connected) {
        es.close();
        setStreamConnected(false);
        // Load from disk with pagination
        fetch(`/api/sessions/${session.id}/history?workspace=${encodedWorkspace}&limit=${PAGE_SIZE}&offset=0`)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- workspace is keyed by string above; session.completed/state intentionally not in deps
  }, [session.id, workspacePathKey]);

  // Load more (older) messages when scrolling to top
  const loadMore = useCallback(async () => {
    if (!historyMeta || !historyMeta.hasMore || isLoadingMore) return;

    setIsLoadingMore(true);
    if (scrollRef.current) {
      prevScrollHeightRef.current = scrollRef.current.scrollHeight;
    }

    try {
      const r = await fetch(
        `/api/sessions/${session.id}/history?workspace=${encodeWorkspacePath(session.workspacePath)}&limit=${PAGE_SIZE}&offset=${messages.length}`
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- workspacePath identity churns each poll; the string key above is the real dep
  }, [historyMeta, isLoadingMore, session.id, workspacePathKey, messages.length]);

  useEffect(() => {
    if (composerRef.current) composerRef.current.focus();
  }, [session.id]);

  // Use streamConnected OR session.isLive to determine if we can interact
  const isLive = streamConnected || session.isLive;

  // Prefer the server-derived todo list (computed over the FULL history);
  // fall back to deriving from the loaded messages when the SSE didn't supply
  // it (e.g. the connection dropped to the one-shot history fetch).
  const derivedTodos = useMemo(() => extractTodosFromMessages(messages), [messages]);
  const todos = serverTodos ?? derivedTodos;

  // Todo panel visibility (defaults to shown when there are todos)
  const [showTodos, setShowTodos] = useState(true);

  // Load persisted clear state on session change — client-only localStorage
  // hydration keyed to the session.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(clearedTasksKey);
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        setClearedTasks(Array.isArray(arr) ? new Set(arr) : null);
      } else {
        setClearedTasks(null);
      }
    } catch {
      setClearedTasks(null);
    }
  }, [clearedTasksKey]);

  // If the agent adds a new task that wasn't in the cleared snapshot, unhide
  // and forget the persisted clear (writes happen synchronously alongside the
  // state update to avoid effect-ordering races on session switch).
  useEffect(() => {
    if (clearedTasks === null) return;
    const hasNew = todos.some((t) => !clearedTasks.has(t.content));
    if (hasNew) {
      setClearedTasks(null);
      try { localStorage.removeItem(clearedTasksKey); } catch {}
    }
  }, [todos, clearedTasks, clearedTasksKey]);

  const handleClearTasks = () => {
    const contents = todos.map((t) => t.content);
    setClearedTasks(new Set(contents));
    try { localStorage.setItem(clearedTasksKey, JSON.stringify(contents)); } catch {}
  };

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
    const failed: string[] = [];
    for (const att of files) {
      const formData = new FormData();
      formData.append("file", att.file);
      try {
        const res = await fetch(
          `/api/files/upload?workspace=${encodeWorkspacePath(session.workspacePath)}`,
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
        } else {
          const e = await res.json().catch(() => ({}));
          failed.push(`${att.file.name}: ${e.error ?? `HTTP ${res.status}`}`);
        }
      } catch (err) {
        failed.push(`${att.file.name}: ${String(err)}`);
      }
    }
    if (failed.length > 0) {
      setAttachError(`Couldn't upload ${failed.length} file${failed.length === 1 ? "" : "s"} — ${failed.join("; ")}`);
    }
    return uploaded;
  };

  const send = async () => {
    if (!isLive || (!draft.trim() && attachments.length === 0)) return;
    setAttachError(null);

    const text = draft.trim();
    const messageText = text || "(attached files)";
    const filesToSend = attachments;
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Optimistic UI: clear the composer and show the bubble immediately. The
    // SSE echo from the server (sendInput emits synchronously) will swap in
    // the canonical message and pop this pending entry — typically within a
    // single React batch, so there's no visible flicker.
    setDraft("");
    setAttachments([]);
    setPendingSends((prev) => [...prev, { id: pendingId, text: messageText }]);
    if (isAtBottomRef.current) {
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }

    try {
      let uploadedFiles: UploadedFile[] = [];
      if (filesToSend.length > 0) {
        uploadedFiles = await uploadFiles(filesToSend);
      }

      const res = await fetch(`/api/sessions/${session.id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: messageText,
          workspace: session.workspacePath,
          files: uploadedFiles.length > 0 ? uploadedFiles : undefined,
          openArtifact: openArtifactPath || undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // Send failed — drop the optimistic bubble and restore the input so the
      // user can retry. Only restore the draft if the composer is still empty
      // (the user might have started typing the next message already).
      console.error("Failed to send message:", err);
      setPendingSends((prev) => prev.filter((p) => p.id !== pendingId));
      if (!draftRef.current) setDraft(text);
      if (attachmentsRef.current.length === 0) setAttachments(filesToSend);
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
          workspace: session.workspacePath,
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
          workspace: session.workspacePath,
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

  // A "pending prompt" — agent's turn is parked on a permission, question, or
  // completion card. State stays "running" while the prompt is open, but the
  // user is the one being asked to act, so we treat it as pending.
  const hasPendingPrompt =
    pendingPermissions.size > 0 || pendingQuestions.size > 0 || pendingCompletions.size > 0
    || pendingAuth;
  const isWorking = state === "running" && !hasPendingPrompt;
  const isPending = !completed && state !== "error" && !isWorking;
  const stateLabel =
    completed ? "completed" :
    state === "error" ? "error" :
    isWorking ? "working" :
    "pending";
  const stateColor =
    completed ? "var(--ok)" :
    state === "error" ? "#e87a7a" :
    isWorking ? "var(--accent)" :
    "var(--warn)";

  return (
    <>
      <header className={`border-b border-[var(--border)] flex items-center ${embedded ? "min-h-10 px-3 gap-2 bg-[var(--bg-2)] shrink-0" : "h-14 px-6 gap-3"}`}>
        <button
          onClick={onBack}
          className={embedded
            ? "text-[var(--muted)] hover:text-[var(--text)] text-[14px] leading-none w-6 h-6 rounded hover:bg-[var(--panel-2)] flex items-center justify-center shrink-0"
            : "text-[var(--muted)] hover:text-[var(--text)] text-[13px] -ml-1.5"}
          title={embedded ? "Collapse chat" : "Back to workspace"}
        >{embedded ? "×" : "← Workspace"}</button>
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
          ) : embedded ? (
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[13px] truncate">{session.title || "(empty)"}</span>
              <span
                className={`text-[11px] shrink-0 inline-flex items-center gap-1 ${isPending ? "pulse" : ""}`}
                style={{ color: stateColor }}
                title={stateLabel}
              >
                {isWorking ? (
                  <WorkingIndicator size={9} title="Working" />
                ) : completed ? (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: stateColor }} />
                )}
              </span>
            </div>
          ) : (
            <div className="text-[14px] truncate">{session.title || "(empty)"}</div>
          )}
          {!embedded && (
          <div className="text-[11.5px] text-[var(--muted)] flex items-center gap-1.5">
            <span>{session.workspacePath.join(" › ") || "(no workspace)"}</span>
            <span>·</span>
            <span
              className={`inline-flex items-center gap-1 ${isPending ? "pulse" : ""}`}
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
          </div>
          )}
        </div>
        {/* Mark complete / Reopen lives in the composer now (next to the
            interrupt button), so it's not in the header anymore. */}
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

      {!embedded && brief && (brief.overview || brief.details) && (
        <div className="border-b border-[var(--border)] bg-[var(--panel)] px-6 py-3 shrink-0">
          <div className="max-w-[760px] mx-auto">
            <div className="flex items-start gap-3">
              <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] font-medium pt-1 shrink-0">
                {brief.label}
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
                      onClick={() => setShowBriefDetails((s) => !s)}
                      className="text-[11px] text-[var(--muted)] hover:text-[var(--text)] inline-flex items-center gap-1 mt-1"
                    >
                      <span>{showBriefDetails ? "▾" : "▸"}</span>
                      <span>{showBriefDetails ? "Hide details" : "Show details"}</span>
                    </button>
                    {showBriefDetails && (
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
                {isLoadingMore ? "Loading…" : `Load older messages (${historyMeta.total - messages.filter(isVisibleSDKMessage).length} more)`}
              </button>
            </div>
          )}
          <MessageStream messages={messages} session={session} onChange={onChange} />
          {/* Optimistic user bubbles for messages the user just hit send on
              but whose SSE echo hasn't landed yet. Styled identically to real
              user bubbles in MessageStream so the swap is invisible. */}
          {pendingSends.map((p) => (
            <div key={p.id} className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl rounded-br-md bg-[var(--user-bubble)] text-[var(--text)] px-4 py-2.5 text-[14px] leading-relaxed border border-[var(--border)]">
                <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{p.text}</span>
              </div>
            </div>
          ))}
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
          {messages.length === 0 && !streamingText && pendingSends.length === 0 && (
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
      {todos.length > 0 && clearedTasks === null && (
        <div className="border-t border-[var(--border)] bg-[var(--bg)]">
          <div className="max-w-[760px] mx-auto px-6">
            {showTodos ? (
              <div className="py-3">
                <div className="relative">
                  <TodoList todos={todos} />
                  <div className="absolute top-2 right-2 flex items-center gap-1">
                    <button
                      onClick={handleClearTasks}
                      className="text-[11px] text-[var(--muted)] hover:text-[var(--text)] px-2 py-1 rounded hover:bg-[var(--panel-2)] transition"
                      title="Clear — hide until new tasks are added"
                    >
                      Clear
                    </button>
                    <button
                      onClick={() => setShowTodos(false)}
                      className="text-[var(--muted)] hover:text-[var(--text)] p-1.5 rounded hover:bg-[var(--panel-2)] transition"
                      title="Hide tasks"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
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

      {pendingQuestions.size === 0 && (
      <div className="border-t border-[var(--border)] px-6 py-4 bg-[var(--bg)]">
        <div className="max-w-[760px] mx-auto">
          {/* Show ContinueComposer for stopped/error sessions that need resuming,
              even if they're in the registry (isLive). For truly live sessions
              (running, idle, awaiting_input), show the regular composer. */}
          {isLive && state !== "stopped" && state !== "error" ? (
            <FileDropZone onFiles={handleFiles} onError={setAttachError} className="rounded-2xl">
              {attachError && (
                <div className="mb-2 rounded-lg bg-[var(--warn-soft)] text-[var(--warn)] text-[12px] px-3 py-2 flex items-start gap-2">
                  <span className="flex-1">{attachError}</span>
                  <button onClick={() => setAttachError(null)} title="Dismiss" className="shrink-0 hover:opacity-70">×</button>
                </div>
              )}
              {attachments.length > 0 && (
                <div className="px-3 pt-2">
                  <AttachmentPreview attachments={attachments} onRemove={removeAttachment} />
                </div>
              )}
              <input
                ref={attachInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={async (e) => {
                  const picked = e.target.files;
                  if (picked && picked.length > 0) {
                    handleFiles(await filesToAttachments(picked, undefined, setAttachError));
                  }
                  e.target.value = "";
                }}
              />
              <div className="rounded-2xl border border-[var(--border-strong)] bg-[var(--panel)] flex items-end gap-2 px-3 py-2 focus-within:border-[var(--accent)] transition">
                <textarea
                  ref={composerRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={isPending ? "Reply to your agent…" : "Drop files or type a message…"}
                  rows={1}
                  style={{ maxHeight: 200 }}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = Math.min(el.scrollHeight, 200) + "px";
                  }}
                  onKeyDown={(e) => handleComposerEnter(e, send)}
                  onPaste={handleComposerPaste}
                  className="flex-1 resize-none bg-transparent outline-none text-[14px] py-2 leading-relaxed"
                />
                <button
                  onClick={() => attachInputRef.current?.click()}
                  className="rounded-lg border border-[var(--border-strong)] text-[var(--text-soft)] hover:text-[var(--accent)] hover:border-[var(--accent)] w-9 h-9 flex items-center justify-center transition shrink-0"
                  title="Attach files"
                  aria-label="Attach files"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                  </svg>
                </button>
                <button
                  onClick={send}
                  disabled={!draft.trim() && attachments.length === 0}
                  className={`rounded-lg w-9 h-9 flex items-center justify-center font-semibold disabled:opacity-40 transition shrink-0 ${newlineMod ? "border border-[var(--border-strong)] text-[var(--text-soft)] bg-transparent" : "bg-[var(--accent)] text-[var(--accent-text)] hover:brightness-110"}`}
                  title={newlineMod ? "Insert a new line (↵ — release the modifier to send)" : "Send message (↵)"}
                  aria-label={newlineMod ? "Insert a new line" : "Send message"}
                >{newlineMod ? "↵" : "↑"}</button>
                {isWorking && (
                  <button
                    onClick={stop}
                    className="rounded-lg border border-[var(--border-strong)] text-[var(--text-soft)] hover:text-[#dc2626] hover:border-[#dc2626] w-9 h-9 flex items-center justify-center transition shrink-0"
                    title="Interrupt the agent (stop the current turn)"
                    aria-label="Interrupt the agent"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                  </button>
                )}
              </div>
            </FileDropZone>
          ) : (
            <ContinueComposer
              session={session}
              draft={draft}
              setDraft={setDraft}
              openArtifactPath={openArtifactPath}
            />
          )}
          {/* Footer row: model/usage info on the left, session-level action
              buttons (move to backlog / mark complete) pushed to the right, all on
              one vertically-centered line. The actions live here rather than
              inside the input box so they read as session controls, not
              message-composition affordances. */}
          {(session.model || session.runtime || rateLimit || !isRenaming) && (
            <div className="mt-2 px-1 flex items-center gap-2">
              <div
                className="flex-1 min-w-0 flex items-start gap-2 flex-wrap text-[11px] leading-none select-none"
                style={{ color: "var(--text-soft)" }}
              >
                {(session.model || session.runtime) && (
                  <span className="inline-flex items-center gap-1 shrink-0">
                    <ModelPicker
                      session={session}
                      disabled={state === "running"}
                      onChanged={onChange}
                    />
                    {session.runtime === "cloud" && (
                      <span
                        className="px-1 py-0.5 rounded text-[9px] font-medium uppercase tracking-wide border border-current opacity-70"
                        title="Running on Cloudflare Containers (via /api/agent)"
                      >
                        cloud
                      </span>
                    )}
                    <EffortPicker
                      session={session}
                      disabled={state === "running"}
                      onChanged={onChange}
                    />
                  </span>
                )}
                {(session.model || session.runtime) && rateLimit && (
                  <span className="opacity-40">·</span>
                )}
                {/* Usage indicator ("5h limit reached") with the API-fallback
                    badge stacked directly beneath it. */}
                <span className="inline-flex flex-col items-start gap-1">
                  <UsageIndicator info={rateLimit} />
                  {fallbackActive && (
                    <span
                      className="px-1 py-0.5 rounded text-[9px] font-medium uppercase tracking-wide border"
                      style={{ borderColor: "var(--warn, #d97706)", color: "var(--warn, #d97706)" }}
                      title="Claude subscription usage limit reached — running on the Anthropic API key (metered). Switches back automatically when the limit resets."
                    >
                      API fallback
                    </span>
                  )}
                </span>
              </div>
              {!isRenaming && (
                <div className="shrink-0 flex items-center gap-2">
                  <BacklogToggleButton session={session} backlog={backlog} variant="full" />
                  <CompleteToggleButton session={session} completed={completed} variant="full" />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      )}
    </>
  );
}
