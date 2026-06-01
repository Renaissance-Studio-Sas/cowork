"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { encodeWorkspacePath } from "@/lib/routes";

// JSON schema produced by `rowads email save-thread`. Kept in sync with
// `thread_to_record()` in scripts/automations/google_workspace/manage_emails.py.
export interface ThreadAttachment {
  filename: string;
  mime_type: string;
  size: number;
  attachment_id: string;
  part_id: string;
  /** Path of the saved attachment file, relative to the thread JSON's directory.
   *  Present when `save_thread()` downloaded the binary alongside the JSON. */
  path?: string;
}

export interface ThreadMessage {
  id: string;
  thread_id: string;
  message_id_header: string;
  in_reply_to: string;
  references: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  reply_to: string;
  subject: string;
  date: string;
  internal_date_ms: number | null;
  labels: string[];
  snippet: string;
  body_text: string;
  body_html: string;
  attachments: ThreadAttachment[];
}

export interface ThreadRecord {
  format: string;            // "emlthread.v1"
  thread_id: string;
  account: string;
  subject: string;
  participants: string[];
  message_count: number;
  saved_at: string;
  messages: ThreadMessage[];
}

interface Props {
  thread: ThreadRecord;
  /** Path of the thread JSON inside the workspace, used to resolve attachment URLs. */
  filePath: string;
  /** Slug-chain of the workspace this thread lives in. */
  workspacePath: string[];
}

export function EmailThreadViewer({ thread, filePath, workspacePath }: Props) {
  const encodedWorkspace = encodeWorkspacePath(workspacePath);
  // Most recent message expanded by default; older ones collapsed.
  const lastIdx = thread.messages.length - 1;
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set([lastIdx]));

  const toggle = (idx: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });

  const expandAll = () => setExpanded(new Set(thread.messages.map((_, i) => i)));
  const collapseAll = () => setExpanded(new Set([lastIdx]));

  const threadDir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  const attachmentUrl = (relPath: string) => {
    const joined = threadDir ? `${threadDir}/${relPath}` : relPath;
    return `/api/files/raw?workspace=${encodedWorkspace}&path=${encodeURIComponent(joined)}`;
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <header className="mb-4 pb-4 border-b border-[var(--border)]">
          <div className="flex items-start gap-2 mb-2">
            <h1 className="text-[20px] font-semibold flex-1 leading-tight">
              {thread.subject || "(no subject)"}
            </h1>
            <CopyButton value={thread.thread_id} label="thread ID" />
          </div>
          <div className="text-[12px] text-[var(--muted)] flex flex-wrap gap-x-3 gap-y-1">
            <span>
              {thread.message_count} message{thread.message_count === 1 ? "" : "s"}
            </span>
            {thread.account && <span>· {thread.account}</span>}
            <span>· saved {formatSavedAt(thread.saved_at)}</span>
            {thread.messages.length > 1 && (
              <span className="ml-auto flex gap-2">
                <button
                  onClick={expandAll}
                  className="text-[var(--accent)] hover:underline"
                >Expand all</button>
                <span>·</span>
                <button
                  onClick={collapseAll}
                  className="text-[var(--accent)] hover:underline"
                >Collapse</button>
              </span>
            )}
          </div>
          {thread.participants.length > 0 && (
            <div className="text-[11.5px] text-[var(--muted)] mt-2 truncate">
              <span className="font-medium text-[var(--text-soft)]">Participants:</span>{" "}
              {thread.participants.join(", ")}
            </div>
          )}
        </header>

        <div className="space-y-3">
          {thread.messages.map((msg, idx) => (
            <MessageCard
              key={msg.id}
              msg={msg}
              isOpen={expanded.has(idx)}
              onToggle={() => toggle(idx)}
              attachmentUrl={attachmentUrl}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function MessageCard({
  msg,
  isOpen,
  onToggle,
  attachmentUrl,
}: {
  msg: ThreadMessage;
  isOpen: boolean;
  onToggle: () => void;
  attachmentUrl: (relPath: string) => string;
}) {
  const isDraft = msg.labels.includes("DRAFT");
  const isSent = msg.labels.includes("SENT");
  const isUnread = msg.labels.includes("UNREAD");

  return (
    <article
      className={`rounded-xl border bg-[var(--panel)] transition ${
        isOpen
          ? "border-[var(--border-strong)] shadow-sm"
          : "border-[var(--border)]"
      } ${isUnread ? "border-l-[3px] border-l-[var(--accent)]" : ""}`}
    >
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 flex items-center gap-3"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-medium truncate">
              {formatAddress(msg.from)}
            </span>
            {isDraft && <Pill text="Draft" tone="warn" />}
            {isSent && <Pill text="Sent" tone="muted" />}
          </div>
          {!isOpen && msg.snippet && (
            <div className="text-[12px] text-[var(--muted)] truncate mt-0.5">
              {msg.snippet}
            </div>
          )}
        </div>
        <div className="text-[11.5px] text-[var(--muted)] shrink-0">
          {formatDate(msg.date)}
        </div>
      </button>

      {isOpen && (
        <div className="px-4 pb-4">
          <Headers msg={msg} />
          {msg.attachments.length > 0 && (
            <Attachments items={msg.attachments} attachmentUrl={attachmentUrl} />
          )}
          <Body msg={msg} />
        </div>
      )}
    </article>
  );
}

function Headers({ msg }: { msg: ThreadMessage }) {
  return (
    <div className="text-[11.5px] text-[var(--text-soft)] border-t border-[var(--border)] pt-2.5 mt-1 mb-3 grid grid-cols-[auto_1fr_auto] gap-x-2 gap-y-0.5 items-baseline">
      <span className="text-[var(--muted)]">From:</span>
      <span className="truncate">{msg.from || "—"}</span>
      <CopyButton value={msg.id} label="message ID" />

      <span className="text-[var(--muted)]">To:</span>
      <span className="truncate col-span-2">{msg.to || "—"}</span>

      {msg.cc && (
        <>
          <span className="text-[var(--muted)]">Cc:</span>
          <span className="truncate col-span-2">{msg.cc}</span>
        </>
      )}

      <span className="text-[var(--muted)]">Date:</span>
      <span className="truncate col-span-2">{msg.date || "—"}</span>
    </div>
  );
}

function Attachments({
  items,
  attachmentUrl,
}: {
  items: ThreadAttachment[];
  attachmentUrl: (relPath: string) => string;
}) {
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {items.map((a) => {
        const className =
          "inline-flex items-center gap-2 text-[11.5px] bg-[var(--panel-2)] border border-[var(--border)] rounded-md px-2 py-1";
        const tooltip = `${a.mime_type} · attachment ID: ${a.attachment_id}`;
        const inner = (
          <>
            <span>📎</span>
            <span className="font-mono">{a.filename}</span>
            <span className="text-[var(--muted)]">{formatSize(a.size)}</span>
          </>
        );
        if (a.path) {
          return (
            <a
              key={`${a.attachment_id}-${a.filename}`}
              href={attachmentUrl(a.path)}
              download={a.filename}
              target="_blank"
              rel="noreferrer"
              title={tooltip}
              className={`${className} hover:bg-[var(--panel)] hover:border-[var(--accent)] text-[var(--text)]`}
            >
              {inner}
            </a>
          );
        }
        return (
          <div
            key={`${a.attachment_id}-${a.filename}`}
            className={className}
            title={`${tooltip} (not downloaded — re-run save-thread to fetch)`}
          >
            {inner}
          </div>
        );
      })}
    </div>
  );
}

function Body({ msg }: { msg: ThreadMessage }) {
  if (msg.body_html) {
    return <HtmlBody html={msg.body_html} />;
  }
  if (msg.body_text) {
    return (
      <pre className="text-[13px] leading-relaxed whitespace-pre-wrap break-words font-sans bg-[var(--panel-2)] border border-[var(--border)] rounded-lg p-3">
        {msg.body_text}
      </pre>
    );
  }
  return (
    <div className="text-[12px] italic text-[var(--muted)]">
      (no body — snippet: {msg.snippet || "—"})
    </div>
  );
}

function HtmlBody({ html }: { html: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Initial guess; resized via postMessage from the iframe once loaded.
  const [height, setHeight] = useState(120);

  // Wrap with a minimal CSS reset + a tiny script that posts its scrollHeight
  // back to the parent so we can size the iframe to its content.
  const srcDoc = useMemo(() => buildMessageHtml(html), [html]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe || e.source !== iframe.contentWindow) return;
      const data = e.data as { type?: string; height?: number; href?: string };
      if (data?.type === "wb-thread:height" && typeof data.height === "number") {
        // No upper cap — let the iframe match its full content height so the
        // outer scroll behaves like Gmail (single scroll, no nested scrollbars).
        setHeight(Math.max(40, Math.ceil(data.height)));
      } else if (data?.type === "wb-thread:open-external" && data.href) {
        window.open(data.href, "_blank", "noopener");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups"
      className="w-full bg-white rounded-lg border border-[var(--border)]"
      style={{ height }}
      title="email body"
    />
  );
}

function buildMessageHtml(userHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/>
<base target="_blank">
<style>
  html, body { margin: 0; padding: 0; }
  body { font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #1f2937; padding: 14px 16px; word-wrap: break-word; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  blockquote { border-left: 3px solid #e5e7eb; margin: 0; padding: 0 12px; color: #4b5563; }
  pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  pre { background: #f9fafb; padding: 10px; border-radius: 6px; overflow-x: auto; }
  a { color: #2563eb; }
</style>
</head><body>
${userHtml}
<script>
(function() {
  function postHeight() {
    var h = document.documentElement.scrollHeight || document.body.scrollHeight;
    parent.postMessage({ type: "wb-thread:height", height: h }, "*");
  }
  // Re-measure on load, images loading, and content mutations.
  window.addEventListener("load", postHeight);
  document.addEventListener("DOMContentLoaded", postHeight);
  var imgs = document.querySelectorAll("img");
  imgs.forEach(function(img){ img.addEventListener("load", postHeight); img.addEventListener("error", postHeight); });
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(postHeight).observe(document.body);
  }
  // Intercept link clicks so they open in a new tab even in sandboxed mode.
  document.addEventListener("click", function(e){
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#") return;
    e.preventDefault();
    parent.postMessage({ type: "wb-thread:open-external", href: href }, "*");
  });
  setTimeout(postHeight, 50);
})();
</script>
</body></html>`;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  return (
    <button
      onClick={onClick}
      title={`Copy ${label}: ${value}`}
      className="shrink-0 text-[10.5px] font-mono text-[var(--muted)] hover:text-[var(--accent)] border border-[var(--border)] hover:border-[var(--accent)] rounded px-1.5 py-0.5"
    >
      {copied ? "✓ copied" : `⧉ ${label}`}
    </button>
  );
}

function Pill({ text, tone }: { text: string; tone: "warn" | "muted" }) {
  const cls =
    tone === "warn"
      ? "bg-[var(--accent-soft)] text-[var(--accent)]"
      : "bg-[var(--panel-2)] text-[var(--muted)]";
  return (
    <span className={`text-[10px] uppercase tracking-wider font-semibold rounded px-1.5 py-0.5 ${cls}`}>
      {text}
    </span>
  );
}

function formatAddress(addr: string): string {
  if (!addr) return "—";
  // "Name <email>" → "Name" if present, else the email
  const m = addr.match(/^\s*(?:"?([^"<]+?)"?\s*)?<([^>]+)>\s*$/);
  if (m) return m[1]?.trim() || m[2];
  return addr;
}

function formatDate(date: string): string {
  if (!date) return "";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function formatSavedAt(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
