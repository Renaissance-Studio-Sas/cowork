"use client";

import { useState, useEffect, useCallback, useRef } from "react";

export interface EmailMessage {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  date: string;
  messageId?: string;
}

export interface EmailPreview {
  id: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  attachments?: string[];
  threadId?: string;
  replyToMessageId?: string;
  isForward?: boolean;
  isReply?: boolean;
  originalThread?: EmailMessage[];
  status: "pending" | "approved" | "rejected" | "sent";
  createdAt: string;
  approvedAt?: string;
  approvalHash?: string;
}

interface Props {
  sessionId: string;
  previewId: string;
  initialData?: Partial<EmailPreview>;
  onStatusChange?: (status: string, approvalToken?: string) => void;
}

// Simple rich text editor using contentEditable
function RichTextEditor({
  value,
  onChange,
  disabled,
  placeholder
}: {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const isInternalUpdate = useRef(false);

  // Set initial content
  useEffect(() => {
    if (editorRef.current && !isInternalUpdate.current) {
      editorRef.current.innerHTML = value;
    }
  }, [value]);

  const handleInput = useCallback(() => {
    if (editorRef.current) {
      isInternalUpdate.current = true;
      onChange(editorRef.current.innerHTML);
      setTimeout(() => { isInternalUpdate.current = false; }, 0);
    }
  }, [onChange]);

  const execCommand = (command: string, value?: string) => {
    document.execCommand(command, false, value);
    editorRef.current?.focus();
    handleInput();
  };

  return (
    <div className="border border-[var(--border)] rounded overflow-hidden bg-[var(--bg)]">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border)] bg-[var(--panel)]">
        <button
          type="button"
          onClick={() => execCommand("bold")}
          disabled={disabled}
          className="p-1 rounded hover:bg-[var(--panel-2)] text-[var(--text)] disabled:opacity-40"
          title="Bold (Ctrl+B)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
            <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => execCommand("italic")}
          disabled={disabled}
          className="p-1 rounded hover:bg-[var(--panel-2)] text-[var(--text)] disabled:opacity-40"
          title="Italic (Ctrl+I)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="19" y1="4" x2="10" y2="4" />
            <line x1="14" y1="20" x2="5" y2="20" />
            <line x1="15" y1="4" x2="9" y2="20" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => execCommand("underline")}
          disabled={disabled}
          className="p-1 rounded hover:bg-[var(--panel-2)] text-[var(--text)] disabled:opacity-40"
          title="Underline (Ctrl+U)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3" />
            <line x1="4" y1="21" x2="20" y2="21" />
          </svg>
        </button>
        <div className="w-px h-4 bg-[var(--border)] mx-1" />
        <button
          type="button"
          onClick={() => execCommand("insertUnorderedList")}
          disabled={disabled}
          className="p-1 rounded hover:bg-[var(--panel-2)] text-[var(--text)] disabled:opacity-40"
          title="Bullet list"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <circle cx="4" cy="6" r="1" fill="currentColor" />
            <circle cx="4" cy="12" r="1" fill="currentColor" />
            <circle cx="4" cy="18" r="1" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => execCommand("insertOrderedList")}
          disabled={disabled}
          className="p-1 rounded hover:bg-[var(--panel-2)] text-[var(--text)] disabled:opacity-40"
          title="Numbered list"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="10" y1="6" x2="21" y2="6" />
            <line x1="10" y1="12" x2="21" y2="12" />
            <line x1="10" y1="18" x2="21" y2="18" />
            <text x="3" y="8" fontSize="6" fill="currentColor" stroke="none">1</text>
            <text x="3" y="14" fontSize="6" fill="currentColor" stroke="none">2</text>
            <text x="3" y="20" fontSize="6" fill="currentColor" stroke="none">3</text>
          </svg>
        </button>
      </div>
      {/* Editor */}
      <div
        ref={editorRef}
        contentEditable={!disabled}
        onInput={handleInput}
        className="min-h-[150px] max-h-[300px] overflow-y-auto px-3 py-2 text-[13px] text-[var(--text)] focus:outline-none [&_*]:!my-1 prose prose-sm max-w-none"
        style={{ whiteSpace: "pre-wrap" }}
        data-placeholder={placeholder}
        suppressContentEditableWarning
      />
    </div>
  );
}

export function EmailPreviewCard({ sessionId, previewId: _previewIdHint, initialData, onStatusChange }: Props) {
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const [actualPreviewId, setActualPreviewId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showThread, setShowThread] = useState(false);

  // Editable fields
  const [editMode, setEditMode] = useState(false);
  const [editTo, setEditTo] = useState("");
  const [editCc, setEditCc] = useState("");
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");

  // Track if user has made edits
  const hasEditsRef = useRef(false);
  const initializedRef = useRef(false);

  // Initialize edit fields from preview (only once per preview)
  const initializeEditFields = useCallback((email: EmailPreview) => {
    if (!initializedRef.current) {
      setEditTo(email.to);
      setEditCc(email.cc || "");
      setEditSubject(email.subject);
      setEditBody(email.body);
      initializedRef.current = true;
    }
  }, []);

  // Fetch the actual email from the store by matching content
  const fetchEmail = useCallback(async () => {
    // Don't fetch if user is editing
    if (editMode || hasEditsRef.current) return;

    if (!initialData?.to || !initialData?.subject || !initialData?.body) {
      const fallback = initialData ? {
        id: _previewIdHint,
        to: initialData.to || "",
        cc: initialData.cc,
        subject: initialData.subject || "",
        body: initialData.body || "",
        attachments: initialData.attachments,
        threadId: initialData.threadId,
        replyToMessageId: initialData.replyToMessageId,
        isForward: initialData.isForward,
        isReply: initialData.isReply,
        originalThread: initialData.originalThread,
        status: "pending" as const,
        createdAt: new Date().toISOString(),
      } : null;
      setPreview(fallback);
      if (fallback) initializeEditFields(fallback);
      setLoading(false);
      return;
    }

    try {
      const r = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/email/find`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: initialData.to,
            subject: initialData.subject,
            body: initialData.body,
          }),
        }
      );

      if (r.ok) {
        const { email } = await r.json();
        setPreview(email);
        setActualPreviewId(email.id);
        initializeEditFields(email);
      } else {
        const fallback = {
          id: _previewIdHint,
          to: initialData.to || "",
          cc: initialData.cc,
          subject: initialData.subject || "",
          body: initialData.body || "",
          attachments: initialData.attachments,
          threadId: initialData.threadId,
          replyToMessageId: initialData.replyToMessageId,
          isForward: initialData.isForward,
          isReply: initialData.isReply,
          originalThread: initialData.originalThread,
          status: "pending" as const,
          createdAt: new Date().toISOString(),
        };
        setPreview(fallback);
        initializeEditFields(fallback);
      }
    } catch {
      const fallback = {
        id: _previewIdHint,
        to: initialData.to || "",
        cc: initialData.cc,
        subject: initialData.subject || "",
        body: initialData.body || "",
        attachments: initialData.attachments,
        threadId: initialData.threadId,
        replyToMessageId: initialData.replyToMessageId,
        isForward: initialData.isForward,
        isReply: initialData.isReply,
        originalThread: initialData.originalThread,
        status: "pending" as const,
        createdAt: new Date().toISOString(),
      };
      setPreview(fallback);
      initializeEditFields(fallback);
    } finally {
      setLoading(false);
    }
  }, [sessionId, _previewIdHint, initialData, editMode, initializeEditFields]);

  useEffect(() => {
    fetchEmail();
    // Poll for status updates only, and only if not editing
    const interval = setInterval(() => {
      if (preview?.status === "pending" && !editMode && !hasEditsRef.current) {
        fetchEmail();
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [fetchEmail, preview?.status, editMode]);

  const previewIdToUse = actualPreviewId || preview?.id || _previewIdHint;

  // Track edits
  const handleEditTo = (v: string) => { setEditTo(v); hasEditsRef.current = true; };
  const handleEditCc = (v: string) => { setEditCc(v); hasEditsRef.current = true; };
  const handleEditSubject = (v: string) => { setEditSubject(v); hasEditsRef.current = true; };
  const handleEditBody = (v: string) => { setEditBody(v); hasEditsRef.current = true; };

  const handleApproveAndSend = async () => {
    if (busy || !preview || !previewIdToUse) return;
    setBusy(true);
    setError(null);

    const emailData = {
      to: editTo,
      cc: editCc || undefined,
      subject: editSubject,
      body: editBody,
      threadId: preview.threadId,
    };

    try {
      // Step 1: Update the email content if edited
      if (hasEditsRef.current) {
        const updateR = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/email/${encodeURIComponent(previewIdToUse)}/update`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(emailData),
          }
        );
        if (!updateR.ok) {
          const j = await updateR.json();
          setError(j.error ?? "Failed to update email");
          setBusy(false);
          return;
        }
      }

      // Step 2: Approve the email
      const approveR = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/email/${encodeURIComponent(previewIdToUse)}/approve`,
        { method: "POST" }
      );
      const approveJ = await approveR.json();
      if (!approveR.ok) {
        setError(approveJ.error ?? "Failed to approve");
        setBusy(false);
        return;
      }

      setPreview((p) => p ? { ...p, status: "approved", approvalHash: approveJ.approvalToken } : p);
      onStatusChange?.("approved", approveJ.approvalToken);

      // Step 3: Actually send the email
      setSending(true);
      const sendR = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/email/${encodeURIComponent(previewIdToUse)}/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            approvalToken: approveJ.approvalToken,
            ...emailData,
          }),
        }
      );
      const sendJ = await sendR.json();

      if (!sendR.ok) {
        setError(sendJ.error ?? "Failed to send email");
        setPreview((p) => p ? { ...p, status: "approved" } : p);
        setBusy(false);
        setSending(false);
        return;
      }

      setPreview((p) => p ? { ...p, status: "sent", ...emailData } : p);
      onStatusChange?.("sent");
      setEditMode(false);

    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setSending(false);
    }
  };

  const handleReject = async () => {
    if (busy || !preview || !previewIdToUse) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/email/${encodeURIComponent(previewIdToUse)}/reject`,
        { method: "POST" }
      );
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? "Failed to reject");
        setBusy(false);
        return;
      }
      setPreview((p) => p ? { ...p, status: "rejected" } : p);
      onStatusChange?.("rejected");
      setEditMode(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
        <div className="text-[12px] text-[var(--muted)]">Loading email preview...</div>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
        <div className="text-[12px] text-[var(--muted)]">Email preview not found</div>
      </div>
    );
  }

  const statusColors = {
    pending: "var(--accent)",
    approved: "#eab308",
    rejected: "#dc2626",
    sent: "var(--ok)",
  };

  const statusLabels = {
    pending: "Pending approval",
    approved: "Sending...",
    rejected: "Rejected",
    sent: "Sent",
  };

  const isPending = preview.status === "pending";
  const canEdit = isPending && !busy;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--border)] bg-[var(--panel-2)] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--accent)]">
            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
            <polyline points="22,6 12,13 2,6" />
          </svg>
          <span className="text-[13px] font-medium">
            {preview.status === "sent" ? "Email Sent" : "Email Preview"}
          </span>
          {preview.isReply && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)]">
              Reply
            </span>
          )}
          {preview.isForward && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)]">
              Forward
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isPending && (
            <button
              onClick={() => setEditMode(!editMode)}
              disabled={busy}
              className="text-[11px] px-2 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--border-strong)] transition disabled:opacity-40"
            >
              {editMode ? "Preview" : "Edit"}
            </button>
          )}
          <span
            className="text-[11px] px-2 py-0.5 rounded-full flex items-center gap-1"
            style={{
              color: statusColors[preview.status],
              background: `${statusColors[preview.status]}20`,
            }}
          >
            {sending && (
              <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            )}
            {statusLabels[preview.status]}
          </span>
        </div>
      </div>

      {/* Email metadata */}
      <div className="px-4 py-3 border-b border-[var(--border)] space-y-2 text-[13px]">
        <div className="flex items-start">
          <span className="text-[var(--muted)] w-16 shrink-0 pt-1">To:</span>
          {editMode && canEdit ? (
            <input
              type="text"
              value={editTo}
              onChange={(e) => handleEditTo(e.target.value)}
              className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)] focus:outline-none focus:border-[var(--accent)]"
            />
          ) : (
            <span className="text-[var(--text)]">{editTo || preview.to}</span>
          )}
        </div>
        <div className="flex items-start">
          <span className="text-[var(--muted)] w-16 shrink-0 pt-1">Cc:</span>
          {editMode && canEdit ? (
            <input
              type="text"
              value={editCc}
              onChange={(e) => handleEditCc(e.target.value)}
              placeholder="(optional)"
              className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)] placeholder:text-[var(--muted)] focus:outline-none focus:border-[var(--accent)]"
            />
          ) : (
            <span className="text-[var(--text)]">{editCc || preview.cc || "—"}</span>
          )}
        </div>
        <div className="flex items-start">
          <span className="text-[var(--muted)] w-16 shrink-0 pt-1">Subject:</span>
          {editMode && canEdit ? (
            <input
              type="text"
              value={editSubject}
              onChange={(e) => handleEditSubject(e.target.value)}
              className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)] font-medium focus:outline-none focus:border-[var(--accent)]"
            />
          ) : (
            <span className="text-[var(--text)] font-medium">{editSubject || preview.subject}</span>
          )}
        </div>
        {preview.attachments && preview.attachments.length > 0 && (
          <div className="flex">
            <span className="text-[var(--muted)] w-16 shrink-0">Files:</span>
            <span className="text-[var(--text)]">{preview.attachments.join(", ")}</span>
          </div>
        )}
      </div>

      {/* Thread context (collapsible) */}
      {preview.originalThread && preview.originalThread.length > 0 && (
        <div className="border-b border-[var(--border)]">
          <button
            onClick={() => setShowThread(!showThread)}
            className="w-full px-4 py-2 text-left text-[12px] text-[var(--muted)] hover:bg-[var(--panel-2)] flex items-center gap-2 transition"
          >
            <span className="text-[9px]">{showThread ? "▾" : "▸"}</span>
            Show thread ({preview.originalThread.length} message{preview.originalThread.length > 1 ? "s" : ""})
          </button>
          {showThread && (
            <div className="px-4 pb-3 space-y-2 max-h-[200px] overflow-y-auto">
              {preview.originalThread.map((msg, i) => (
                <div key={i} className="rounded-lg bg-[var(--bg)] p-3 text-[12px]">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-[var(--text)]">{msg.from}</span>
                    <span className="text-[var(--muted)]">·</span>
                    <span className="text-[var(--muted)]">{msg.date}</span>
                  </div>
                  <div className="text-[var(--text-soft)] line-clamp-3">
                    {msg.body.replace(/<[^>]*>/g, "").slice(0, 200)}
                    {msg.body.length > 200 && "..."}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Email body */}
      <div className="px-4 py-3">
        {editMode && canEdit ? (
          <RichTextEditor
            value={editBody}
            onChange={handleEditBody}
            disabled={busy}
            placeholder="Email body"
          />
        ) : (
          <div
            className="text-[13px] leading-relaxed prose prose-sm max-w-none [&_*]:!my-1 max-h-[300px] overflow-y-auto"
            dangerouslySetInnerHTML={{ __html: editBody || preview.body }}
          />
        )}
      </div>

      {/* Actions */}
      {isPending && (
        <div className="px-4 py-3 border-t border-[var(--border)] bg-[var(--panel-2)] flex items-center justify-between">
          <div className="text-[11px] text-[var(--muted)]">
            {editMode ? "Edit the email, then approve to send" : "Review the email above before sending"}
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleReject}
              disabled={busy}
              className="text-[12px] px-3 py-1.5 rounded-md border border-[var(--border-strong)] text-[var(--text-soft)] hover:text-[#dc2626] hover:border-[#dc2626] disabled:opacity-40 transition"
            >
              Reject
            </button>
            <button
              onClick={handleApproveAndSend}
              disabled={busy}
              className="text-[12px] px-4 py-1.5 rounded-md bg-[var(--ok)] text-white disabled:opacity-40 hover:brightness-110 transition font-medium flex items-center gap-2"
            >
              {busy ? (
                <>
                  <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Sending...
                </>
              ) : (
                "Approve & Send"
              )}
            </button>
          </div>
        </div>
      )}

      {preview.status === "approved" && (
        <div className="px-4 py-3 border-t border-[var(--border)] bg-[rgba(234,179,8,0.1)]">
          <div className="flex items-center gap-2 text-[12px] text-[#eab308]">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span>Sending email...</span>
          </div>
        </div>
      )}

      {preview.status === "rejected" && (
        <div className="px-4 py-3 border-t border-[var(--border)] bg-[rgba(220,38,38,0.1)]">
          <div className="flex items-center gap-2 text-[12px] text-[#dc2626]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
            <span>Email rejected. Provide feedback to the agent.</span>
          </div>
        </div>
      )}

      {preview.status === "sent" && (
        <div className="px-4 py-3 border-t border-[var(--border)] bg-[rgba(34,197,94,0.15)]">
          <div className="flex items-center gap-2 text-[12px] text-[var(--ok)]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="20,6 9,17 4,12" />
            </svg>
            <span className="font-medium">Email sent successfully!</span>
          </div>
        </div>
      )}

      {error && (
        <div className="px-4 py-2 border-t border-[var(--border)] text-[12px] text-[#dc2626] bg-[rgba(220,38,38,0.1)]">
          {error}
        </div>
      )}
    </div>
  );
}
