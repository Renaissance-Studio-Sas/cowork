"use client";

import { useEffect, useRef, useState } from "react";
import { handleComposerEnter } from "@/lib/composer";

interface Props {
  sessionId: string;
  projectSlug: string;
  taskSlug: string;
  onClose: () => void;
  onOpenFull: () => void;
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
          | { type: "thinking"; thinking: string }
        >;
      };
    }
  | { type: "result"; subtype: string }
  | { type: "system"; subtype: string }
  | Record<string, unknown>;

export function AgentPanel({ sessionId, projectSlug, taskSlug, onClose, onOpenFull }: Props) {
  const [messages, setMessages] = useState<SDKMessageLite[]>([]);
  const [state, setState] = useState<string>("idle");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setMessages([]);
    const es = new EventSource(
      `/api/sessions/${sessionId}/stream?project=${encodeURIComponent(projectSlug)}&task=${encodeURIComponent(taskSlug)}`,
    );
    es.addEventListener("message", (ev) => {
      try { setMessages((p) => [...p, JSON.parse((ev as MessageEvent).data)]); } catch { /* ignore */ }
    });
    es.addEventListener("state", (ev) => {
      try { setState(JSON.parse((ev as MessageEvent).data).state); } catch { /* ignore */ }
    });
    es.onerror = () => { /* auto-reconnect */ };
    return () => es.close();
  }, [sessionId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  const send = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    try {
      await fetch(`/api/sessions/${sessionId}/input`, {
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
    await fetch(`/api/sessions/${sessionId}/interrupt`, { method: "POST" });
  };

  const isWorking = state === "running";
  const isAwaiting = state === "awaiting_input";
  const isDone = state === "idle" || state === "stopped"; // stopped sessions seamlessly resume, treat as done
  const label = isAwaiting ? "needs your reply" : isWorking ? "working" : isDone ? "done" : state === "error" ? "error" : "idle";
  const color = isAwaiting ? "var(--warn)" : isWorking ? "var(--accent)" : isDone ? "var(--ok)" : state === "error" ? "#dc2626" : "var(--muted)";

  return (
    <aside className="w-[380px] shrink-0 border-l border-[var(--border)] bg-[var(--bg-2)] flex flex-col">
      <div className="px-3 py-3 border-b border-[var(--border)] flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[12px] uppercase tracking-wider text-[var(--muted)] font-semibold">Agent</div>
          <div className="text-[11.5px] flex items-center gap-1.5 mt-0.5" style={{ color }}>
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${isWorking || isAwaiting ? "pulse" : ""}`} style={{ background: color }} />
            <span className={isWorking || isAwaiting ? "pulse" : ""}>{label}</span>
            {isWorking && <span className="dots" aria-hidden />}
          </div>
        </div>
        <button onClick={onOpenFull} title="Open full view" className="text-[var(--muted)] hover:text-[var(--text)] text-[11px] px-1.5 py-0.5 rounded hover:bg-[var(--panel-2)]">↗</button>
        {!(state === "stopped" || state === "error") && (
          <button onClick={stop} title="Stop" className="text-[var(--muted)] hover:text-[#dc2626] text-[11px] px-1.5 py-0.5 rounded hover:bg-[var(--panel-2)]">■</button>
        )}
        <button onClick={onClose} title="Close" className="text-[var(--muted)] hover:text-[var(--text)] text-[14px] leading-none px-1.5 py-0.5 rounded hover:bg-[var(--panel-2)]">×</button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        <PanelMessageStream messages={messages} />
        {messages.length === 0 && (
          <div className="text-[var(--muted)] text-[12.5px]">Waiting for the agent to start…</div>
        )}
        {isWorking && (
          <div className="flex items-center gap-2 text-[12.5px] text-[var(--accent)]">
            <span className="inline-block w-2 h-2 rounded-full bg-[var(--accent)] pulse" />
            <span>Working<span className="dots" aria-hidden /></span>
          </div>
        )}
      </div>

      <div className="border-t border-[var(--border)] p-2.5 bg-[var(--bg-2)]">
        <div className="rounded-xl border border-[var(--border-strong)] bg-[var(--panel)] flex items-end gap-2 px-2 py-1.5 focus-within:border-[var(--accent)] transition">
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={isAwaiting ? "Reply…" : "Send a message…"}
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
            disabled={!draft.trim() || sending}
            className="rounded-md bg-[var(--accent)] text-[var(--accent-text)] w-8 h-8 flex items-center justify-center font-semibold disabled:opacity-40 hover:brightness-110 shrink-0"
            title="Send (↵)"
          >↑</button>
        </div>
        <div className="text-[10.5px] text-[var(--muted)] px-1 pt-1">
          {projectSlug} · {taskSlug}
        </div>
      </div>
    </aside>
  );
}

type PanelPart = { type: string; [k: string]: unknown };

function PanelMessageStream({ messages }: { messages: SDKMessageLite[] }) {
  type Chip =
    | { kind: "tool"; part: PanelPart }
    | { kind: "think"; text: string };
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
      // Tool-result echoes have no visible text — don't break the chip row.
      const text = extractText(mm.message?.content).trim();
      if (text) {
        flush();
        items.push({ kind: "user", key: `u-${i}`, text });
      }
    } else if (mm.type === "assistant") {
      const parts = (mm.message?.content as PanelPart[] | undefined) ?? [];
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
              <div className="max-w-[88%] rounded-xl rounded-br-sm bg-[var(--user-bubble)] text-[var(--text)] border border-[var(--border)] px-2.5 py-1.5 text-[13px] whitespace-pre-wrap">{it.text}</div>
            </div>
          );
        }
        if (it.kind === "asst-text") {
          return <div key={it.key} className="text-[13px] whitespace-pre-wrap leading-relaxed">{it.text}</div>;
        }
        if (it.kind === "chip-row") {
          return (
            <div key={it.key} className="flex flex-wrap gap-1">
              {it.chips.map((c, j) => c.kind === "tool"
                ? <PanelToolChip key={j} p={c.part} />
                : <PanelThinkChip key={j} text={c.text} />)}
            </div>
          );
        }
        if (it.kind === "result") {
          return <div key={it.key} className="text-[10.5px] text-[var(--muted)] text-center pt-1">— turn complete —</div>;
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

function PanelThinkChip({ text }: { text: string }) {
  return (
    <details className="group inline-block align-top max-w-full">
      <summary
        className="cursor-pointer select-none list-none inline-flex items-center gap-1 text-[11px] text-[var(--muted)] italic bg-[var(--panel)] hover:bg-[var(--panel-2)] rounded-md px-1.5 py-0.5 border border-[var(--border)]"
      >
        <span className="text-[9px] opacity-70 not-italic">▸</span>
        <span>thinking</span>
      </summary>
      <pre className="mt-1 overflow-x-auto text-[10.5px] text-[var(--text-soft)] bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1 max-w-full whitespace-pre-wrap break-words not-italic">
        {text}
      </pre>
    </details>
  );
}

function shortenToolName(name: string): string {
  const m = name.match(/^mcp__([^_]+(?:-[^_]+)*)__(.+)$/);
  if (m) return `MCP ${m[2]}`;
  return name;
}

function PanelToolChip({ p }: { p: PanelPart }) {
  const name = shortenToolName(p.name as string);
  return (
    <details className="group inline-block align-top max-w-full">
      <summary
        className="cursor-pointer select-none list-none inline-flex items-center gap-1 text-[11px] text-[var(--accent)] bg-[var(--accent-soft)] hover:bg-[rgba(37,99,235,0.18)] rounded-md px-1.5 py-0.5 border border-[var(--border)]"
        title={p.name as string}
      >
        <span className="text-[9px] opacity-70">▸</span>
        <span className="font-mono">{name}</span>
      </summary>
      <pre className="mt-1 overflow-x-auto text-[10.5px] text-[var(--text-soft)] bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1 max-w-full whitespace-pre-wrap break-words">
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
