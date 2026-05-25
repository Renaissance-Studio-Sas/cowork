// Cards for the agent's planning-mode proposals. The MessageStream switches
// `propose_plan` / `propose_task` tool_use chips into these inline editors;
// only the most recent proposal is interactive (earlier ones render dimmed
// as a record of what was offered).

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SessionSummaryDTO } from "@/lib/types";
import { taskRoute, projectRoute } from "@/lib/routes";
import { sluggifyName } from "./utils";

interface ProposedTaskInput {
  task_slug?: string;
  task_overview?: string;
  task_details?: string;
}

interface ProposedPlanInput {
  project_slug?: string;
  project_overview?: string;
  project_details?: string;
  tasks?: Array<{ slug?: string; overview?: string; details?: string }>;
}

export function ProposalCard({
  name,
  input,
  isLatest,
  session,
  onCreated,
}: {
  name: string;
  input: Record<string, unknown>;
  isLatest: boolean;
  session: SessionSummaryDTO;
  onCreated: () => void;
}) {
  const router = useRouter();
  if (/propose_task$/.test(name)) {
    return (
      <TaskProposalCard
        initial={input as ProposedTaskInput}
        isLatest={isLatest}
        projectSlug={session.projectSlug}
        sessionId={session.id}
        onCreated={(slug) => {
          onCreated();
          router.push(taskRoute(session.projectSlug, slug));
        }}
      />
    );
  }
  if (/propose_plan$/.test(name)) {
    return (
      <PlanProposalCard
        initial={input as ProposedPlanInput}
        isLatest={isLatest}
        stubSlug={session.projectSlug}
        sessionId={session.id}
        onCreated={(slug) => {
          onCreated();
          router.push(projectRoute(slug));
        }}
      />
    );
  }
  return null;
}

function TaskProposalCard({
  initial,
  isLatest,
  projectSlug,
  sessionId,
  onCreated,
}: {
  initial: ProposedTaskInput;
  isLatest: boolean;
  projectSlug: string;
  sessionId: string;
  onCreated: (slug: string) => void;
}) {
  const [slug, setSlug] = useState(initial.task_slug ?? "Untitled");
  const [overview, setOverview] = useState(initial.task_overview ?? "");
  const [details, setDetails] = useState(initial.task_details ?? "");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!slug.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const cleanSlug = sluggifyName(slug);
      const r = await fetch(`/api/projects/${encodeURIComponent(projectSlug)}/tasks/from-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: cleanSlug, overview, details, session_id: sessionId }),
      });
      const j = await r.json();
      if (!r.ok) { setError(j.error ?? "failed to create"); return; }
      onCreated(j.slug);
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  };

  const opacity = isLatest ? "" : "opacity-60";
  return (
    <div className={`rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-3 ${opacity}`}>
      <div className="text-[10.5px] uppercase tracking-wider text-[var(--accent)] font-semibold mb-2">
        {isLatest ? "Proposed task" : "Earlier proposal"}
      </div>
      <div className="space-y-2">
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] mb-1">Task name</div>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            disabled={!isLatest}
            className="w-full bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1.5 text-[13.5px] outline-none focus:border-[var(--accent)] font-mono disabled:opacity-60"
          />
        </div>
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] mb-1">Overview (one line)</div>
          <input
            value={overview}
            onChange={(e) => setOverview(e.target.value)}
            disabled={!isLatest}
            className="w-full bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1.5 text-[13.5px] outline-none focus:border-[var(--accent)] disabled:opacity-60"
          />
        </div>
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] mb-1">Details (markdown)</div>
          <textarea
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            disabled={!isLatest}
            rows={8}
            className="w-full resize-y bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1.5 text-[13px] outline-none focus:border-[var(--accent)] font-mono leading-relaxed disabled:opacity-60"
          />
        </div>
      </div>
      {isLatest && (
        <div className="mt-3 flex items-center justify-end gap-2">
          {error && <div className="text-[12px] text-[#dc2626] mr-auto">{error}</div>}
          <button
            onClick={create}
            disabled={creating || !slug.trim()}
            className="bg-[var(--accent)] text-[var(--accent-text)] rounded-md px-3 py-1.5 text-[13px] font-medium disabled:opacity-40 hover:brightness-110"
          >{creating ? "Creating…" : "Create task"}</button>
        </div>
      )}
    </div>
  );
}

function PlanProposalCard({
  initial,
  isLatest,
  stubSlug,
  sessionId,
  onCreated,
}: {
  initial: ProposedPlanInput;
  isLatest: boolean;
  stubSlug: string;
  sessionId: string;
  onCreated: (slug: string) => void;
}) {
  const [projectSlug, setProjectSlug] = useState(initial.project_slug ?? stubSlug);
  const [projectOverview, setProjectOverview] = useState(initial.project_overview ?? "");
  const [projectDetails, setProjectDetails] = useState(initial.project_details ?? "");
  const [tasks, setTasks] = useState<Array<{ slug: string; overview: string; details: string }>>(
    (initial.tasks ?? []).map((t) => ({
      slug: t.slug ?? "",
      overview: t.overview ?? "",
      details: t.details ?? "",
    })),
  );
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateTask = (i: number, patch: Partial<{ slug: string; overview: string; details: string }>) => {
    setTasks((prev) => prev.map((t, j) => (i === j ? { ...t, ...patch } : t)));
  };
  const removeTask = (i: number) => setTasks((prev) => prev.filter((_, j) => j !== i));
  const addTask = () => setTasks((prev) => [...prev, { slug: "new-task", overview: "", details: "" }]);

  const create = async () => {
    if (!projectSlug.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const cleanSlug = sluggifyName(projectSlug);
      const r = await fetch("/api/projects/from-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_slug: stubSlug,
          slug: cleanSlug,
          overview: projectOverview,
          details: projectDetails,
          tasks: tasks
            .filter((t) => t.slug.trim())
            .map((t) => ({ slug: sluggifyName(t.slug), overview: t.overview, details: t.details })),
          session_id: sessionId,
        }),
      });
      const j = await r.json();
      if (!r.ok) { setError(j.error ?? "failed to create"); return; }
      onCreated(j.slug);
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  };

  const opacity = isLatest ? "" : "opacity-60";
  return (
    <div className={`rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-3 ${opacity}`}>
      <div className="text-[10.5px] uppercase tracking-wider text-[var(--accent)] font-semibold mb-2">
        {isLatest ? "Proposed plan" : "Earlier proposal"}
      </div>
      <div className="space-y-2">
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] mb-1">Project name</div>
          <input
            value={projectSlug}
            onChange={(e) => setProjectSlug(e.target.value)}
            disabled={!isLatest}
            className="w-full bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1.5 text-[13.5px] outline-none focus:border-[var(--accent)] font-mono disabled:opacity-60"
          />
        </div>
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] mb-1">Overview (one line)</div>
          <input
            value={projectOverview}
            onChange={(e) => setProjectOverview(e.target.value)}
            disabled={!isLatest}
            className="w-full bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1.5 text-[13px] outline-none focus:border-[var(--accent)] disabled:opacity-60"
          />
        </div>
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] mb-1">Details (markdown)</div>
          <textarea
            value={projectDetails}
            onChange={(e) => setProjectDetails(e.target.value)}
            disabled={!isLatest}
            rows={4}
            className="w-full resize-y bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1.5 text-[13px] outline-none focus:border-[var(--accent)] font-mono leading-relaxed disabled:opacity-60"
          />
        </div>
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] mb-1">Tasks · {tasks.length}</div>
          <div className="space-y-1.5">
            {tasks.map((t, i) => (
              <div key={i} className="flex items-center gap-1.5 bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1">
                <input
                  value={t.slug}
                  onChange={(e) => updateTask(i, { slug: e.target.value })}
                  disabled={!isLatest}
                  className="w-[140px] shrink-0 bg-transparent border-b border-transparent focus:border-[var(--accent)] outline-none text-[12.5px] font-mono py-0.5 disabled:opacity-60"
                  placeholder="slug"
                />
                <input
                  value={t.overview}
                  onChange={(e) => updateTask(i, { overview: e.target.value })}
                  disabled={!isLatest}
                  className="flex-1 bg-transparent border-b border-transparent focus:border-[var(--accent)] outline-none text-[12.5px] py-0.5 disabled:opacity-60"
                  placeholder="overview"
                />
                {isLatest && (
                  <button
                    onClick={() => removeTask(i)}
                    className="text-[var(--muted)] hover:text-[#dc2626] text-[12px] px-1"
                    title="Remove"
                  >×</button>
                )}
              </div>
            ))}
            {isLatest && (
              <button
                onClick={addTask}
                className="text-[11.5px] text-[var(--muted)] hover:text-[var(--text)] underline underline-offset-2"
              >+ add task</button>
            )}
          </div>
        </div>
      </div>
      {isLatest && (
        <div className="mt-3 flex items-center justify-end gap-2">
          {error && <div className="text-[12px] text-[#dc2626] mr-auto">{error}</div>}
          <button
            onClick={create}
            disabled={creating || !projectSlug.trim()}
            className="bg-[var(--accent)] text-[var(--accent-text)] rounded-md px-3 py-1.5 text-[13px] font-medium disabled:opacity-40 hover:brightness-110"
          >{creating ? "Creating…" : "Create project"}</button>
        </div>
      )}
    </div>
  );
}
