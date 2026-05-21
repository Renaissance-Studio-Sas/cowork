"use client";

import { useEffect, useRef, useState } from "react";
import { handleComposerEnter } from "@/lib/composer";

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

export function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (slug: string) => void }) {
  const [mode, setMode] = useState<"chat" | "quick">("chat");
  return mode === "chat" ? (
    <ChatProjectModal onClose={onClose} onCreated={onCreated} onSwitchToQuick={() => setMode("quick")} />
  ) : (
    <QuickProjectModal onClose={onClose} onCreated={onCreated} onSwitchToChat={() => setMode("chat")} />
  );
}

// -----------------------------------------------------------------------
// Quick path: a name + optional description.
// -----------------------------------------------------------------------

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
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const slug = sluggify(name);
    try {
      await fetch(`/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, description: desc || name }),
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
      <Field label="Description (optional)">
        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          rows={3}
          placeholder="What is this project about?"
          className="w-full resize-none bg-[var(--panel)] border border-[var(--border)] rounded-lg px-3 py-2 text-[13.5px] outline-none focus:border-[var(--accent)]"
        />
      </Field>
    </ModalShell>
  );
}

// -----------------------------------------------------------------------
// Chat path: a streaming agent conversation that proposes a plan via the
// `propose_plan` MCP tool. The user can revise the proposal inline and
// click "Create project" to materialize it.
// -----------------------------------------------------------------------

interface ChatMsg {
  role: "user" | "assistant";
  text: string;
  proposal?: ProposedPlan;
  taskProposal?: ProposedTask;
  toolUseId?: string;
}

interface ProposedPlan {
  project_slug: string;
  project_description: string;
  tasks: Array<{ slug: string; description: string }>;
}

function ChatProjectModal({
  onClose,
  onCreated,
  onSwitchToQuick,
}: {
  onClose: () => void;
  onCreated: (slug: string) => void;
  onSwitchToQuick: () => void;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [state, setState] = useState<string>("idle");
  const [draft, setDraft] = useState("");
  const [proposal, setProposal] = useState<ProposedPlan | null>(null);
  const [creating, setCreating] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Start the planning session on first message
  const startSession = async (firstMessage: string) => {
    const r = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: firstMessage }),
    });
    const j = await r.json();
    if (!j.id) { alert(j.error ?? "failed to start"); return; }
    setSessionId(j.id);
    setMessages([{ role: "user", text: firstMessage }]);
  };

  // SSE stream
  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/api/sessions/${sessionId}/stream`);
    es.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse((ev as MessageEvent).data);
        handleSdkMessage(msg, setMessages, setProposal);
      } catch { /* ignore */ }
    });
    es.addEventListener("state", (ev) => {
      try { setState(JSON.parse((ev as MessageEvent).data).state); } catch { /* ignore */ }
    });
    return () => es.close();
  }, [sessionId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, proposal]);

  // Clean up the planning session when the modal closes (best effort)
  useEffect(() => {
    return () => {
      if (sessionId) fetch(`/api/sessions/${sessionId}/interrupt`, { method: "POST" }).catch(() => {});
    };
  }, [sessionId]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (!sessionId) {
      await startSession(text);
      return;
    }
    setMessages((p) => [...p, { role: "user", text }]);
    await fetch(`/api/sessions/${sessionId}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
  };

  const createFromPlan = async () => {
    if (!proposal || creating) return;
    setCreating(true);
    try {
      const slug = sluggify(proposal.project_slug);
      const r = await fetch("/api/projects/from-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          description: proposal.project_description,
          tasks: proposal.tasks
            .filter((t) => t.slug.trim())
            .map((t) => ({ slug: sluggify(t.slug), description: t.description })),
          // Adopt the planning chat into the new project so it shows up in
          // the project's sessions list.
          session_id: sessionId,
        }),
      });
      const j = await r.json();
      if (!r.ok) { alert(j.error ?? "failed to create"); return; }
      onCreated(j.slug);
    } finally {
      setCreating(false);
    }
  };

  const isWorking = state === "running";

  return (
    <ModalShell
      title="New project — plan with an agent"
      subtitle="Tell the agent what you want. It'll propose a name + initial tasks."
      onClose={onClose}
      width={620}
      footer={
        <>
          <button onClick={onSwitchToQuick} className="mr-auto text-[12.5px] text-[var(--accent)] hover:underline">↪ Skip and just enter a name</button>
          <button onClick={onClose} className="text-[13px] text-[var(--text-soft)] px-3 py-2 hover:bg-[var(--panel-2)] rounded-lg">Cancel</button>
        </>
      }
    >
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2 space-y-3 pb-1">
        {messages.length === 0 && !sessionId && (
          <div className="text-[13px] text-[var(--text-soft)] leading-relaxed py-2">
            What do you want this project to be about? A few sentences are plenty — the agent will ask follow-ups if it needs them.
          </div>
        )}
        {messages.map((m, i) =>
          m.proposal ? (
            <PlanCard
              key={i}
              plan={m.proposal}
              onChange={(next) => {
                setProposal(next);
                setMessages((prev) => prev.map((mm, ii) => (ii === i ? { ...mm, proposal: next } : mm)));
              }}
              onCreate={createFromPlan}
              creating={creating}
            />
          ) : (
            <Bubble key={i} role={m.role} text={m.text} />
          ),
        )}
        {isWorking && (
          <div className="flex items-center gap-2 text-[12.5px] text-[var(--accent)]">
            <span className="inline-block w-2 h-2 rounded-full bg-[var(--accent)] pulse" />
            <span>Working<span className="dots" aria-hidden /></span>
          </div>
        )}
      </div>

      <div className="shrink-0 rounded-xl border border-[var(--border-strong)] bg-[var(--panel)] flex items-end gap-2 px-2 py-1.5 focus-within:border-[var(--accent)] transition">
        <textarea
          ref={composerRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={sessionId ? "Reply…" : "Tell the agent about your project…"}
          rows={2}
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
          disabled={!draft.trim()}
          className="rounded-md bg-[var(--accent)] text-[var(--accent-text)] w-8 h-8 flex items-center justify-center font-semibold disabled:opacity-40 hover:brightness-110 shrink-0"
          title="Send (↵)"
        >↑</button>
      </div>
    </ModalShell>
  );
}

// Process an SDK message and update the chat state. Handles:
//   - assistant text → assistant bubble
//   - tool_use named workbench-planning's propose_plan → plan card
function handleSdkMessage(
  msg: Record<string, unknown>,
  setMessages: React.Dispatch<React.SetStateAction<ChatMsg[]>>,
  setProposal: React.Dispatch<React.SetStateAction<ProposedPlan | null>>,
): void {
  if (msg.type !== "assistant") return;
  const message = msg.message as { content?: unknown[] } | undefined;
  const parts = (message?.content ?? []) as Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
  for (const p of parts) {
    if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
      const text = p.text;
      setMessages((prev) => [...prev, { role: "assistant", text }]);
    } else if (p.type === "tool_use" && p.name && /propose_plan/.test(p.name)) {
      const input = p.input as Partial<ProposedPlan> | undefined;
      const proposal: ProposedPlan = {
        project_slug: input?.project_slug ?? "untitled",
        project_description: input?.project_description ?? "",
        tasks: Array.isArray(input?.tasks) ? (input!.tasks as ProposedPlan["tasks"]) : [],
      };
      setProposal(proposal);
      setMessages((prev) => [...prev, { role: "assistant", text: "", proposal }]);
    }
  }
}

function Bubble({ role, text }: { role: "user" | "assistant"; text: string }) {
  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-xl rounded-br-sm bg-[var(--user-bubble)] text-[var(--text)] border border-[var(--border)] px-3 py-2 text-[13.5px] whitespace-pre-wrap">{text}</div>
      </div>
    );
  }
  return (
    <div className="text-[13.5px] whitespace-pre-wrap leading-relaxed">{text}</div>
  );
}

function PlanCard({
  plan, onChange, onCreate, creating,
}: {
  plan: ProposedPlan;
  onChange: (next: ProposedPlan) => void;
  onCreate: () => void;
  creating: boolean;
}) {
  const update = (patch: Partial<ProposedPlan>) => onChange({ ...plan, ...patch });
  const updateTask = (i: number, patch: Partial<ProposedPlan["tasks"][number]>) => {
    onChange({ ...plan, tasks: plan.tasks.map((t, j) => (i === j ? { ...t, ...patch } : t)) });
  };
  const removeTask = (i: number) => {
    onChange({ ...plan, tasks: plan.tasks.filter((_, j) => j !== i) });
  };
  const addTask = () => {
    onChange({ ...plan, tasks: [...plan.tasks, { slug: "new-task", description: "" }] });
  };

  return (
    <div className="rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-3">
      <div className="text-[10.5px] uppercase tracking-wider text-[var(--accent)] font-semibold mb-2">Proposed plan</div>
      <div className="space-y-2">
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] mb-1">Project slug</div>
          <input
            value={plan.project_slug}
            onChange={(e) => update({ project_slug: e.target.value })}
            className="w-full bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1.5 text-[13.5px] outline-none focus:border-[var(--accent)] font-mono"
          />
        </div>
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] mb-1">Description</div>
          <textarea
            value={plan.project_description}
            onChange={(e) => update({ project_description: e.target.value })}
            rows={2}
            className="w-full resize-none bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1.5 text-[13px] outline-none focus:border-[var(--accent)]"
          />
        </div>
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] mb-1">Tasks · {plan.tasks.length}</div>
          <div className="space-y-1.5">
            {plan.tasks.map((t, i) => (
              <div key={i} className="flex items-center gap-1.5 bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1">
                <input
                  value={t.slug}
                  onChange={(e) => updateTask(i, { slug: e.target.value })}
                  className="w-[140px] shrink-0 bg-transparent border-b border-transparent focus:border-[var(--accent)] outline-none text-[12.5px] font-mono py-0.5"
                  placeholder="slug"
                />
                <input
                  value={t.description}
                  onChange={(e) => updateTask(i, { description: e.target.value })}
                  className="flex-1 bg-transparent border-b border-transparent focus:border-[var(--accent)] outline-none text-[12.5px] py-0.5"
                  placeholder="description"
                />
                <button
                  onClick={() => removeTask(i)}
                  className="text-[var(--muted)] hover:text-[#dc2626] text-[12px] px-1"
                  title="Remove"
                >×</button>
              </div>
            ))}
            <button
              onClick={addTask}
              className="text-[11.5px] text-[var(--muted)] hover:text-[var(--text)] underline underline-offset-2"
            >+ add task</button>
          </div>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          onClick={onCreate}
          disabled={creating || !plan.project_slug.trim()}
          className="bg-[var(--accent)] text-[var(--accent-text)] rounded-md px-3 py-1.5 text-[13px] font-medium disabled:opacity-40 hover:brightness-110"
        >{creating ? "Creating…" : "Create project"}</button>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// NewTaskModal — chat-first like NewProjectModal. The agent proposes a
// single { slug, description } card scoped to the given project; the user
// edits inline and accepts to materialize the task. A "quick" form is
// still reachable as an escape hatch.
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
    <ChatTaskModal
      projectSlug={projectSlug}
      onClose={onClose}
      onCreated={onCreated}
      onSwitchToQuick={() => setMode("quick")}
    />
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
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const slug = sluggify(name);
    try {
      await fetch(`/api/projects/${projectSlug}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, description: desc || name }),
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
      <Field label="Brief (optional)">
        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          rows={4}
          placeholder="What should be done? Goals, constraints, context…"
          className="w-full resize-none bg-[var(--panel)] border border-[var(--border)] rounded-lg px-3 py-2 text-[13.5px] outline-none focus:border-[var(--accent)]"
        />
      </Field>
    </ModalShell>
  );
}

interface ProposedTask {
  task_slug: string;
  task_description: string;
}

function ChatTaskModal({
  projectSlug,
  onClose,
  onCreated,
  onSwitchToQuick,
}: {
  projectSlug: string;
  onClose: () => void;
  onCreated: (slug: string) => void;
  onSwitchToQuick: () => void;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [state, setState] = useState<string>("idle");
  const [draft, setDraft] = useState("");
  const [proposal, setProposal] = useState<ProposedTask | null>(null);
  const [creating, setCreating] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const startSession = async (firstMessage: string) => {
    const r = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "task", project: projectSlug, message: firstMessage }),
    });
    const j = await r.json();
    if (!j.id) { alert(j.error ?? "failed to start"); return; }
    setSessionId(j.id);
    setMessages([{ role: "user", text: firstMessage }]);
  };

  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/api/sessions/${sessionId}/stream`);
    es.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse((ev as MessageEvent).data);
        handleTaskSdkMessage(msg, setMessages, setProposal);
      } catch { /* ignore */ }
    });
    es.addEventListener("state", (ev) => {
      try { setState(JSON.parse((ev as MessageEvent).data).state); } catch { /* ignore */ }
    });
    return () => es.close();
  }, [sessionId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, proposal]);

  useEffect(() => {
    return () => {
      if (sessionId) fetch(`/api/sessions/${sessionId}/interrupt`, { method: "POST" }).catch(() => {});
    };
  }, [sessionId]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (!sessionId) {
      await startSession(text);
      return;
    }
    setMessages((p) => [...p, { role: "user", text }]);
    await fetch(`/api/sessions/${sessionId}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
  };

  const createFromPlan = async () => {
    if (!proposal || creating) return;
    setCreating(true);
    try {
      const slug = sluggify(proposal.task_slug);
      const r = await fetch(`/api/projects/${projectSlug}/tasks/from-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          description: proposal.task_description,
          session_id: sessionId,
        }),
      });
      const j = await r.json();
      if (!r.ok) { alert(j.error ?? "failed to create"); return; }
      onCreated(j.slug);
    } finally {
      setCreating(false);
    }
  };

  const isWorking = state === "running";

  return (
    <ModalShell
      title={`New task in ${projectSlug} — plan with an agent`}
      subtitle="Tell the agent what you want. It'll propose a name + a clean task.md."
      onClose={onClose}
      width={620}
      footer={
        <>
          <button onClick={onSwitchToQuick} className="mr-auto text-[12.5px] text-[var(--accent)] hover:underline">↪ Skip and just enter a name</button>
          <button onClick={onClose} className="text-[13px] text-[var(--text-soft)] px-3 py-2 hover:bg-[var(--panel-2)] rounded-lg">Cancel</button>
        </>
      }
    >
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2 space-y-3 pb-1">
        {messages.length === 0 && !sessionId && (
          <div className="text-[13px] text-[var(--text-soft)] leading-relaxed py-2">
            What is this task about? A few sentences are plenty — the agent will ask follow-ups if it needs them.
          </div>
        )}
        {messages.map((m, i) =>
          m.taskProposal ? (
            <TaskCard
              key={i}
              task={m.taskProposal}
              onChange={(next) => {
                setProposal(next);
                setMessages((prev) => prev.map((mm, ii) => (ii === i ? { ...mm, taskProposal: next } : mm)));
              }}
              onCreate={createFromPlan}
              creating={creating}
            />
          ) : (
            <Bubble key={i} role={m.role} text={m.text} />
          ),
        )}
        {isWorking && (
          <div className="flex items-center gap-2 text-[12.5px] text-[var(--accent)]">
            <span className="inline-block w-2 h-2 rounded-full bg-[var(--accent)] pulse" />
            <span>Working<span className="dots" aria-hidden /></span>
          </div>
        )}
      </div>

      <div className="shrink-0 rounded-xl border border-[var(--border-strong)] bg-[var(--panel)] flex items-end gap-2 px-2 py-1.5 focus-within:border-[var(--accent)] transition">
        <textarea
          ref={composerRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={sessionId ? "Reply…" : "Tell the agent about this task…"}
          rows={2}
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
          disabled={!draft.trim()}
          className="rounded-md bg-[var(--accent)] text-[var(--accent-text)] w-8 h-8 flex items-center justify-center font-semibold disabled:opacity-40 hover:brightness-110 shrink-0"
          title="Send (↵)"
        >↑</button>
      </div>
    </ModalShell>
  );
}

function handleTaskSdkMessage(
  msg: Record<string, unknown>,
  setMessages: React.Dispatch<React.SetStateAction<ChatMsg[]>>,
  setProposal: React.Dispatch<React.SetStateAction<ProposedTask | null>>,
): void {
  if (msg.type !== "assistant") return;
  const message = msg.message as { content?: unknown[] } | undefined;
  const parts = (message?.content ?? []) as Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
  for (const p of parts) {
    if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
      const text = p.text;
      setMessages((prev) => [...prev, { role: "assistant", text }]);
    } else if (p.type === "tool_use" && p.name && /propose_task/.test(p.name)) {
      const input = p.input as Partial<ProposedTask> | undefined;
      const proposal: ProposedTask = {
        task_slug: input?.task_slug ?? "untitled",
        task_description: input?.task_description ?? "",
      };
      setProposal(proposal);
      setMessages((prev) => [...prev, { role: "assistant", text: "", taskProposal: proposal }]);
    }
  }
}

function TaskCard({
  task, onChange, onCreate, creating,
}: {
  task: ProposedTask;
  onChange: (next: ProposedTask) => void;
  onCreate: () => void;
  creating: boolean;
}) {
  const update = (patch: Partial<ProposedTask>) => onChange({ ...task, ...patch });
  return (
    <div className="rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-3">
      <div className="text-[10.5px] uppercase tracking-wider text-[var(--accent)] font-semibold mb-2">Proposed task</div>
      <div className="space-y-2">
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] mb-1">Task name</div>
          <input
            value={task.task_slug}
            onChange={(e) => update({ task_slug: e.target.value })}
            className="w-full bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1.5 text-[13.5px] outline-none focus:border-[var(--accent)] font-mono"
          />
        </div>
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] mb-1">task.md</div>
          <textarea
            value={task.task_description}
            onChange={(e) => update({ task_description: e.target.value })}
            rows={8}
            className="w-full resize-y bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1.5 text-[13px] outline-none focus:border-[var(--accent)] font-mono leading-relaxed"
          />
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          onClick={onCreate}
          disabled={creating || !task.task_slug.trim()}
          className="bg-[var(--accent)] text-[var(--accent-text)] rounded-md px-3 py-1.5 text-[13px] font-medium disabled:opacity-40 hover:brightness-110"
        >{creating ? "Creating…" : "Create task"}</button>
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
