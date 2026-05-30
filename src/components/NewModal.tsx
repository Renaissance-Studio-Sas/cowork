"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "@/lib/navigation";
import { handleComposerEnter } from "@/lib/composer";
import { projectSessionRoute } from "@/lib/routes";

function sluggify(s: string): string {
  // The folder name *is* the display name — preserve case + spaces, strip
  // only filesystem-unsafe chars. Server-side sanitizeName does the same.
  return s
    .normalize("NFC")
    .trim()
    .replace(/[/\\:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80) || "Untitled";
}

function ModalShell({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 480,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 px-4" onClick={onClose}>
      <div
        className="bg-[var(--bg)] border border-[var(--border-strong)] rounded-2xl w-full shadow-2xl flex flex-col max-h-[90vh]"
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-5 pb-2 shrink-0">
          <div className="text-[17px] font-semibold">{title}</div>
          {subtitle && <div className="text-[12.5px] text-[var(--muted)] mt-0.5">{subtitle}</div>}
        </div>
        <div className="px-6 py-4 space-y-3 flex-1 min-h-0 overflow-hidden flex flex-col">{children}</div>
        <div className="px-6 pb-5 pt-2 flex justify-end gap-2 shrink-0">{footer}</div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11.5px] uppercase tracking-wider text-[var(--muted)] block mb-1.5">{label}</label>
      {children}
    </div>
  );
}

// -----------------------------------------------------------------------
// New Project
// -----------------------------------------------------------------------

export function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (slug: string) => void }) {
  const [mode, setMode] = useState<"chat" | "quick">("chat");
  return mode === "chat" ? (
    <ChatProjectKickoff onClose={onClose} onSwitchToQuick={() => setMode("quick")} />
  ) : (
    <QuickProjectModal onClose={onClose} onCreated={onCreated} onSwitchToChat={() => setMode("chat")} />
  );
}

function QuickProjectModal({
  onClose,
  onCreated,
  onSwitchToChat,
}: {
  onClose: () => void;
  onCreated: (slug: string) => void;
  onSwitchToChat: () => void;
}) {
  const [name, setName] = useState("");
  const [overview, setOverview] = useState("");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const slug = sluggify(name);
    try {
      await fetch(`/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, overview: overview || name, details }),
      });
      onCreated(slug);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title="New project"
      subtitle="Quick form. Switch to chat for a guided setup."
      onClose={onClose}
      footer={
        <>
          <button onClick={onSwitchToChat} className="mr-auto text-[12.5px] text-[var(--accent)] hover:underline">↩ Plan with an agent</button>
          <button onClick={onClose} className="text-[13px] text-[var(--text-soft)] px-3 py-2 hover:bg-[var(--panel-2)] rounded-lg">Cancel</button>
          <button
            onClick={submit}
            disabled={!name.trim() || busy}
            className="bg-[var(--accent)] text-[var(--accent-text)] rounded-lg px-4 py-2 text-[13.5px] font-medium disabled:opacity-40 hover:brightness-110"
          >Create</button>
        </>
      }
    >
      <Field label="Name">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="e.g. apartment-search"
          className="w-full bg-[var(--panel)] border border-[var(--border)] rounded-lg px-3 py-2 text-[13.5px] outline-none focus:border-[var(--accent)]"
        />
      </Field>
      <Field label="Overview (one line, optional)">
        <input
          value={overview}
          onChange={(e) => setOverview(e.target.value)}
          placeholder="What is this project about?"
          className="w-full bg-[var(--panel)] border border-[var(--border)] rounded-lg px-3 py-2 text-[13.5px] outline-none focus:border-[var(--accent)]"
        />
      </Field>
      <Field label="Details (markdown, optional)">
        <textarea
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          rows={3}
          placeholder="Goals, constraints, context…"
          className="w-full resize-none bg-[var(--panel)] border border-[var(--border)] rounded-lg px-3 py-2 text-[13.5px] outline-none focus:border-[var(--accent)]"
        />
      </Field>
    </ModalShell>
  );
}

// Captures a single first message, kicks off a normal project-level
// planning session (server creates a stub project to host it), then routes
// the user into the chat page. The agent's `propose_plan` tool call shows
// up there as an inline card the user can accept.
function ChatProjectKickoff({
  onClose,
  onSwitchToQuick,
}: {
  onClose: () => void;
  onSwitchToQuick: () => void;
}) {
  return (
    <KickoffShell
      title="New project — plan with an agent"
      subtitle="Tell the agent what you want. It runs as a regular session — you can step away and come back."
      placeholder="Tell the agent about your project…"
      switchLabel="↪ Skip and just enter a name"
      onClose={onClose}
      onSwitch={onSwitchToQuick}
      buildBody={(message) => ({ message })}
    />
  );
}

// -----------------------------------------------------------------------
// New Task
// -----------------------------------------------------------------------

export function NewTaskModal({
  projectSlug,
  onClose,
  onCreated,
}: {
  projectSlug: string;
  onClose: () => void;
  onCreated: (slug: string) => void;
}) {
  const [mode, setMode] = useState<"chat" | "quick">("chat");
  return mode === "chat" ? (
    <ChatTaskKickoff projectSlug={projectSlug} onClose={onClose} onSwitchToQuick={() => setMode("quick")} />
  ) : (
    <QuickTaskModal
      projectSlug={projectSlug}
      onClose={onClose}
      onCreated={onCreated}
      onSwitchToChat={() => setMode("chat")}
    />
  );
}

function QuickTaskModal({
  projectSlug,
  onClose,
  onCreated,
  onSwitchToChat,
}: {
  projectSlug: string;
  onClose: () => void;
  onCreated: (slug: string) => void;
  onSwitchToChat: () => void;
}) {
  const [name, setName] = useState("");
  const [overview, setOverview] = useState("");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const slug = sluggify(name);
    try {
      await fetch(`/api/projects/${projectSlug}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, overview: overview || name, details }),
      });
      onCreated(slug);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title={`New task in ${projectSlug}`}
      subtitle="Quick form. Switch to chat for a guided setup."
      onClose={onClose}
      footer={
        <>
          <button onClick={onSwitchToChat} className="mr-auto text-[12.5px] text-[var(--accent)] hover:underline">↩ Plan with an agent</button>
          <button onClick={onClose} className="text-[13px] text-[var(--text-soft)] px-3 py-2 hover:bg-[var(--panel-2)] rounded-lg">Cancel</button>
          <button
            onClick={submit}
            disabled={!name.trim() || busy}
            className="bg-[var(--accent)] text-[var(--accent-text)] rounded-lg px-4 py-2 text-[13.5px] font-medium disabled:opacity-40 hover:brightness-110"
          >Create</button>
        </>
      }
    >
      <Field label="Name">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="short-title-for-this-task"
          className="w-full bg-[var(--panel)] border border-[var(--border)] rounded-lg px-3 py-2 text-[13.5px] outline-none focus:border-[var(--accent)]"
        />
      </Field>
      <Field label="Overview (one line, optional)">
        <input
          value={overview}
          onChange={(e) => setOverview(e.target.value)}
          placeholder="What should be done?"
          className="w-full bg-[var(--panel)] border border-[var(--border)] rounded-lg px-3 py-2 text-[13.5px] outline-none focus:border-[var(--accent)]"
        />
      </Field>
      <Field label="Details (markdown, optional)">
        <textarea
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          rows={4}
          placeholder="Goals, constraints, context…"
          className="w-full resize-none bg-[var(--panel)] border border-[var(--border)] rounded-lg px-3 py-2 text-[13.5px] outline-none focus:border-[var(--accent)]"
        />
      </Field>
    </ModalShell>
  );
}

function ChatTaskKickoff({
  projectSlug,
  onClose,
  onSwitchToQuick,
}: {
  projectSlug: string;
  onClose: () => void;
  onSwitchToQuick: () => void;
}) {
  return (
    <KickoffShell
      title={`New task in ${projectSlug} — plan with an agent`}
      subtitle="Tell the agent what you want. It runs as a regular session — you can step away and come back."
      placeholder="Tell the agent about this task…"
      switchLabel="↪ Skip and just enter a name"
      onClose={onClose}
      onSwitch={onSwitchToQuick}
      buildBody={(message) => ({ mode: "task", project: projectSlug, message })}
    />
  );
}

// -----------------------------------------------------------------------
// Shared kickoff: composer that POSTs to /api/plan and routes to the
// resulting normal session page.
// -----------------------------------------------------------------------

function KickoffShell({
  title,
  subtitle,
  placeholder,
  switchLabel,
  onClose,
  onSwitch,
  buildBody,
}: {
  title: string;
  subtitle: string;
  placeholder: string;
  switchLabel: string;
  onClose: () => void;
  onSwitch: () => void;
  buildBody: (message: string) => Record<string, unknown>;
}) {
  const router = useRouter();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const text = draft.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(text)),
      });
      const j = await r.json();
      if (!r.ok || !j.id || !j.projectSlug) {
        setError(j.error ?? "failed to start");
        return;
      }
      router.push(projectSessionRoute(j.projectSlug, j.id));
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button onClick={onSwitch} className="mr-auto text-[12.5px] text-[var(--accent)] hover:underline">{switchLabel}</button>
          <button onClick={onClose} className="text-[13px] text-[var(--text-soft)] px-3 py-2 hover:bg-[var(--panel-2)] rounded-lg">Cancel</button>
        </>
      }
    >
      <div className="shrink-0 rounded-xl border border-[var(--border-strong)] bg-[var(--panel)] flex items-end gap-2 px-2 py-1.5 focus-within:border-[var(--accent)] transition">
        <textarea
          autoFocus
          ref={composerRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          rows={3}
          style={{ maxHeight: 200 }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 200) + "px";
          }}
          onKeyDown={(e) => handleComposerEnter(e, send)}
          className="flex-1 resize-none bg-transparent outline-none text-[13.5px] py-1 leading-relaxed"
        />
        <button
          onClick={send}
          disabled={!draft.trim() || submitting}
          className="rounded-md bg-[var(--accent)] text-[var(--accent-text)] w-8 h-8 flex items-center justify-center font-semibold disabled:opacity-40 hover:brightness-110 shrink-0"
          title="Send (↵)"
        >{submitting ? "…" : "↑"}</button>
      </div>
      {error && <div className="text-[12px] text-[#dc2626]">{error}</div>}
    </ModalShell>
  );
}
