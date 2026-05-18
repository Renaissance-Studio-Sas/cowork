"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { handleComposerEnter } from "@/lib/composer";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
// Note: we intentionally do NOT use rehype-raw — assistant messages can
// contain XML-like tags (e.g. <quote>, <file>) that React then warns about
// as unknown custom elements. skipHtml strips them cleanly.
import type { SessionSummaryDTO } from "@/lib/types";
import { taskSessionRoute, projectSessionRoute } from "@/lib/routes";

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

  useEffect(() => {
    setMessages([]);
    setState(session.state);
    setStreamConnected(false);

    // Always try to connect to SSE stream first — even if session.isLive is false,
    // the session might actually be live (race condition with API polling)
    const es = new EventSource(`/api/sessions/${session.id}/stream`);
    let connected = false;

    es.addEventListener("message", (ev) => {
      try {
        if (!connected) {
          connected = true;
          setStreamConnected(true);
        }
        setMessages((p) => [...p, JSON.parse((ev as MessageEvent).data)]);
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
        onChange();
      } catch { /* ignore */ }
    });
    es.onerror = () => {
      // If we never connected and got an error, fall back to historical mode
      if (!connected) {
        es.close();
        setStreamConnected(false);
        // Load from disk
        fetch(`/api/sessions/${session.id}/history?project=${session.projectSlug}&task=${session.taskSlug}`)
          .then((r) => r.json())
          .then((j) => {
            if (j.events) setMessages(j.events);
          });
      }
      // If we were connected before, SSE will auto-reconnect
    };
    return () => es.close();
  }, [session.id, session.projectSlug, session.taskSlug, session.state, onChange]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  useEffect(() => {
    if (composerRef.current) composerRef.current.focus();
  }, [session.id]);

  // Use streamConnected OR session.isLive to determine if we can interact
  const isLive = streamConnected || session.isLive;

  const send = async () => {
    if (!isLive || !draft.trim() || sending) return;
    setSending(true);
    try {
      await fetch(`/api/sessions/${session.id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: draft.trim() }),
      });
      setDraft("");
    } finally {
      setSending(false);
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
  const isDone = state === "idle";
  const stateLabel =
    isAwaiting ? "needs your reply" :
    isWorking ? "working" :
    state === "stopped" ? "stopped" :
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

      <div className="border-t border-[var(--border)] px-6 py-4 bg-[var(--bg)]">
        <div className="max-w-[760px] mx-auto">
          {isLive ? (
            <div className="rounded-2xl border border-[var(--border-strong)] bg-[var(--panel)] flex items-end gap-2 px-3 py-2 focus-within:border-[var(--accent)] transition">
              <textarea
                ref={composerRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={state === "awaiting_input" ? "Reply to your agent…" : "Send a message…"}
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
                disabled={!draft.trim() || sending}
                className="rounded-lg bg-[var(--accent)] text-[var(--accent-text)] w-9 h-9 flex items-center justify-center font-semibold disabled:opacity-40 hover:brightness-110 transition shrink-0"
                title="Send (↵)"
              >↑</button>
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
          ) : (
            <ContinueComposer session={session} messages={messages} />
          )}
        </div>
      </div>
    </>
  );
}

// Composer for past sessions: spawn a fresh live session in the same task and
// seed it with a brief recap of the prior conversation so the agent has
// context to continue from.
function ContinueComposer({ session, messages }: { session: SessionSummaryDTO; messages: SDKMessageLite[] }) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const start = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      const recap = buildRecap(messages);
      const fullMessage =
        `Continuing a prior conversation${recap ? `:\n\n${recap}\n\n` : ". "}` +
        `My next message:\n\n${draft.trim()}`;
      const isProjectScope = !session.taskSlug;
      const url = isProjectScope
        ? `/api/projects/${encodeURIComponent(session.projectSlug)}/sessions`
        : `/api/projects/${encodeURIComponent(session.projectSlug)}/tasks/${encodeURIComponent(session.taskSlug)}/sessions`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: fullMessage }),
      });
      const j = await r.json();
      if (!j.id) { alert(j.error ?? "failed to start"); return; }
      const route = isProjectScope
        ? projectSessionRoute(session.projectSlug, j.id)
        : taskSessionRoute(session.projectSlug, session.taskSlug, j.id);
      router.push(route);
      setDraft("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-[11.5px] text-[var(--muted)] px-1">
        This is a past conversation. Sending will spawn a fresh live session in the same task, seeded with a recap of this chat so the agent can pick up where it left off.
      </div>
      <div className="rounded-2xl border border-[var(--border-strong)] bg-[var(--panel)] flex items-end gap-2 px-3 py-2 focus-within:border-[var(--accent)] transition">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Continue the conversation in a new live session…"
          rows={2}
          style={{ maxHeight: 200 }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 200) + "px";
          }}
          onKeyDown={(e) => handleComposerEnter(e, start)}
          className="flex-1 resize-none bg-transparent outline-none text-[14px] py-2 leading-relaxed"
        />
        <button
          onClick={start}
          disabled={!draft.trim() || busy}
          className="rounded-lg bg-[var(--accent)] text-[var(--accent-text)] w-9 h-9 flex items-center justify-center font-semibold disabled:opacity-40 hover:brightness-110 transition shrink-0"
          title="Continue in a new session (↵)"
        >↑</button>
      </div>
    </div>
  );
}

// Build a short, structural recap of the past conversation for the new agent
// to read. We cap the size so we don't blow the context window.
function buildRecap(messages: SDKMessageLite[]): string {
  const MAX = 6000; // chars
  const parts: string[] = [];
  for (const m of messages) {
    const t = (m as { type?: string }).type;
    if (t === "user") {
      const text = extractText((m as { message?: { content?: unknown } }).message?.content).trim();
      if (text) parts.push(`User: ${text}`);
    } else if (t === "assistant") {
      const content = ((m as { message?: { content?: unknown[] } }).message?.content ?? []) as Array<{ type?: string; text?: string; name?: string }>;
      const text = content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("").trim();
      const tools = content.filter((p) => p.type === "tool_use").map((p) => p.name).filter(Boolean);
      const summary = [text, tools.length ? `(tools: ${tools.join(", ")})` : ""].filter(Boolean).join(" ");
      if (summary) parts.push(`Assistant: ${summary}`);
    }
  }
  let joined = parts.join("\n\n");
  if (joined.length > MAX) {
    // Keep tail (most recent) since it's most relevant.
    joined = "…(truncated)…\n\n" + joined.slice(joined.length - MAX);
  }
  return joined;
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
