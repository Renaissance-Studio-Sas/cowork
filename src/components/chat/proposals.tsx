// Cards for the agent's planning-mode proposals. The MessageStream switches
// `propose_plan` / `propose_task` tool_use chips into these inline editors;
// only the most recent proposal is interactive (earlier ones render dimmed
// as a record of what was offered).
//
// With the recursive Workspace model both tools collapse onto one action:
// "create a child workspace under <current>". `propose_plan` carries a
// nested-children list, `propose_task` is a single child. Both POST to
// `/api/workspaces/from-plan`, which renames the planning session's stub
// workspace into the accepted slug, fills in the brief, and creates any
// proposed child workspaces.

import { useState } from "react";
import { useRouter } from "@/lib/navigation";
import type { SessionSummaryDTO } from "@/lib/types";
import { workspaceRoute } from "@/lib/routes";
import { sluggifyName } from "./utils";

interface ProposedTaskInput {
  // Legacy `task_*` field names — kept so old planning-mode prompts still
  // hydrate the form correctly. The shape on the wire is unchanged.
  task_slug?: string;
  task_overview?: string;
  task_details?: string;
}

interface ProposedPlanInput {
  // Same story: keep the original field names that the agent's planning tool
  // emits ("project_*", "tasks"). We map them onto workspace-shaped state on
  // load.
  project_slug?: string;
  project_overview?: string;
  project_details?: string;
  tasks?: Array<{ slug?: string; overview?: string; details?: string }>;
}

// Current planning tool (`propose_workspace`): one recursive workspace with
// optional children. Its field names differ from the legacy plan tool, so we
// normalize it onto ProposedPlanInput before reusing PlanProposalCard.
interface ProposedWorkspaceInput {
  workspace_slug?: string;
  workspace_overview?: string;
  workspace_details?: string;
  children?: Array<{ slug?: string; overview?: string; details?: string }>;
}

function workspaceInputToPlan(input: ProposedWorkspaceInput): ProposedPlanInput {
  return {
    project_slug: input.workspace_slug,
    project_overview: input.workspace_overview,
    project_details: input.workspace_details,
    tasks: input.children,
  };
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
  if (/propose_workspace$/.test(name)) {
    return (
      <PlanProposalCard
        initial={workspaceInputToPlan(input as ProposedWorkspaceInput)}
        isLatest={isLatest}
        currentPath={session.workspacePath}
        sessionId={session.id}
        onCreated={(path) => {
          onCreated();
          router.push(workspaceRoute(path));
        }}
      />
    );
  }
  if (/propose_task$/.test(name)) {
    return (
      <ChildWorkspaceProposalCard
        initial={input as ProposedTaskInput}
        isLatest={isLatest}
        currentPath={session.workspacePath}
        sessionId={session.id}
        onCreated={(slug) => {
          onCreated();
          router.push(workspaceRoute([...session.workspacePath, slug]));
        }}
      />
    );
  }
  if (/propose_plan$/.test(name)) {
    return (
      <PlanProposalCard
        initial={input as ProposedPlanInput}
        isLatest={isLatest}
        currentPath={session.workspacePath}
        sessionId={session.id}
        onCreated={(path) => {
          onCreated();
          router.push(workspaceRoute(path));
        }}
      />
    );
  }
  return null;
}

// Quick add: create a single child workspace under the session's current
// workspace. The session itself doesn't move — the child is added beside it.
function ChildWorkspaceProposalCard({
  initial,
  isLatest,
  currentPath,
  sessionId,
  onCreated,
}: {
  initial: ProposedTaskInput;
  isLatest: boolean;
  currentPath: string[];
  sessionId: string;
  onCreated: (slug: string) => void;
}) {
  const [slug, setSlug] = useState(initial.task_slug ?? "Untitled");
  const [overview, setOverview] = useState(initial.task_overview ?? "");
  const [details, setDetails] = useState(initial.task_details ?? "");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once accepted, fold the editor into its header. `collapsed` stays
  // user-toggleable so they can re-expand to inspect what was created.
  const [created, setCreated] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const create = async () => {
    if (!slug.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const cleanSlug = sluggifyName(slug);
      // POST /api/workspaces/<parent-chain> creates a child under that parent.
      // The chain is URL-encoded per segment, joined with `/`. encodeURI is
      // safe per-segment because slugs can contain spaces.
      const url = `/api/workspaces/${currentPath.map(encodeURIComponent).join("/")}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: cleanSlug, overview, details, session_id: sessionId }),
      });
      const j = await r.json();
      if (!r.ok) { setError(j.error ?? "failed to create"); return; }
      setCreated(true);
      setCollapsed(true);
      onCreated(j.slug ?? cleanSlug);
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  };

  const opacity = isLatest && !created ? "" : "opacity-60";
  const editable = isLatest && !created;
  return (
    <div className={`rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-3 ${opacity}`}>
      <ProposalHeader
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        label={created ? "Workspace created" : isLatest ? "Proposed child workspace" : "Earlier proposal"}
        summary={collapsed ? slug : undefined}
        created={created}
      />
      {!collapsed && (
      <div className="space-y-2">
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] mb-1">Workspace name</div>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            disabled={!editable}
            className="w-full bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1.5 text-[13.5px] outline-none focus:border-[var(--accent)] font-mono disabled:opacity-60"
          />
        </div>
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] mb-1">Overview (one line)</div>
          <input
            value={overview}
            onChange={(e) => setOverview(e.target.value)}
            disabled={!editable}
            className="w-full bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1.5 text-[13.5px] outline-none focus:border-[var(--accent)] disabled:opacity-60"
          />
        </div>
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] mb-1">Details (markdown)</div>
          <textarea
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            disabled={!editable}
            rows={8}
            className="w-full resize-y bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1.5 text-[13px] outline-none focus:border-[var(--accent)] font-mono leading-relaxed disabled:opacity-60"
          />
        </div>
      </div>
      )}
      {editable && (
        <div className="mt-3 flex items-center justify-end gap-2">
          {error && <div className="text-[12px] text-[#dc2626] mr-auto">{error}</div>}
          <button
            onClick={create}
            disabled={creating || !slug.trim()}
            className="bg-[var(--accent)] text-[var(--accent-text)] rounded-md px-3 py-1.5 text-[13px] font-medium disabled:opacity-40 hover:brightness-110"
          >{creating ? "Creating…" : "Create workspace"}</button>
        </div>
      )}
    </div>
  );
}

// Shared header for proposal cards. Clickable to fold/unfold the editor body;
// shows a ✓ + the chosen name once the workspace has been created.
function ProposalHeader({
  collapsed,
  onToggle,
  label,
  summary,
  created,
}: {
  collapsed: boolean;
  onToggle: () => void;
  label: string;
  summary?: string;
  created: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-full flex items-center gap-1.5 text-left text-[10.5px] uppercase tracking-wider font-semibold ${collapsed ? "" : "mb-2"} text-[var(--accent)] hover:brightness-110`}
    >
      <span className="text-[8px] leading-none w-2 shrink-0">{collapsed ? "▸" : "▾"}</span>
      {created && <span className="leading-none">✓</span>}
      <span>{label}</span>
      {summary && (
        <span className="normal-case tracking-normal font-normal text-[var(--muted)] truncate">· {summary}</span>
      )}
    </button>
  );
}

// Plan acceptance: rename the stub workspace at `currentPath` into the chosen
// slug, fill in its brief, and create any nested child workspaces. The
// planning session itself follows the renamed folder via the in-meta
// `workspace` path.
function PlanProposalCard({
  initial,
  isLatest,
  currentPath,
  sessionId,
  onCreated,
}: {
  initial: ProposedPlanInput;
  isLatest: boolean;
  currentPath: string[];
  sessionId: string;
  onCreated: (path: string[]) => void;
}) {
  // Bootstrap from the planning session's own (stub) slug when the agent
  // didn't propose one — so the user sees something meaningful pre-filled.
  const stubSlug = currentPath[currentPath.length - 1] ?? "";
  const [wsSlug, setWsSlug] = useState(initial.project_slug ?? stubSlug);
  const [wsOverview, setWsOverview] = useState(initial.project_overview ?? "");
  const [wsDetails, setWsDetails] = useState(initial.project_details ?? "");
  const [children, setChildren] = useState<Array<{ slug: string; overview: string; details: string }>>(
    (initial.tasks ?? []).map((t) => ({
      slug: t.slug ?? "",
      overview: t.overview ?? "",
      details: t.details ?? "",
    })),
  );
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fold the plan into its header once accepted; stays re-expandable.
  const [created, setCreated] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const updateChild = (i: number, patch: Partial<{ slug: string; overview: string; details: string }>) => {
    setChildren((prev) => prev.map((t, j) => (i === j ? { ...t, ...patch } : t)));
  };
  const removeChild = (i: number) => setChildren((prev) => prev.filter((_, j) => j !== i));
  const addChild = () => setChildren((prev) => [...prev, { slug: "new-workspace", overview: "", details: "" }]);

  const create = async () => {
    if (!wsSlug.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const cleanSlug = sluggifyName(wsSlug);
      const r = await fetch("/api/workspaces/from-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_path: currentPath,
          slug: cleanSlug,
          overview: wsOverview,
          details: wsDetails,
          children: children
            .filter((c) => c.slug.trim())
            .map((c) => ({ slug: sluggifyName(c.slug), overview: c.overview, details: c.details })),
          session_id: sessionId,
        }),
      });
      const j = await r.json();
      if (!r.ok) { setError(j.error ?? "failed to create"); return; }
      const finalPath: string[] = Array.isArray(j.path) && j.path.length > 0
        ? j.path
        : [...currentPath.slice(0, -1), cleanSlug];
      setCreated(true);
      setCollapsed(true);
      onCreated(finalPath);
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  };

  const opacity = isLatest && !created ? "" : "opacity-60";
  const editable = isLatest && !created;
  const childSummary = children.length ? ` + ${children.length} child${children.length > 1 ? "ren" : ""}` : "";
  return (
    <div className={`rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-3 ${opacity}`}>
      <ProposalHeader
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        label={created ? "Workspace created" : isLatest ? "Proposed workspace plan" : "Earlier proposal"}
        summary={collapsed ? `${wsSlug}${childSummary}` : undefined}
        created={created}
      />
      {!collapsed && (
      <div className="space-y-2">
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] mb-1">Workspace name</div>
          <input
            value={wsSlug}
            onChange={(e) => setWsSlug(e.target.value)}
            disabled={!editable}
            className="w-full bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1.5 text-[13.5px] outline-none focus:border-[var(--accent)] font-mono disabled:opacity-60"
          />
        </div>
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] mb-1">Overview (one line)</div>
          <input
            value={wsOverview}
            onChange={(e) => setWsOverview(e.target.value)}
            disabled={!editable}
            className="w-full bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1.5 text-[13px] outline-none focus:border-[var(--accent)] disabled:opacity-60"
          />
        </div>
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] mb-1">Details (markdown)</div>
          <textarea
            value={wsDetails}
            onChange={(e) => setWsDetails(e.target.value)}
            disabled={!editable}
            rows={4}
            className="w-full resize-y bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1.5 text-[13px] outline-none focus:border-[var(--accent)] font-mono leading-relaxed disabled:opacity-60"
          />
        </div>
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--muted)] mb-1">Child workspaces · {children.length}</div>
          <div className="space-y-1.5">
            {children.map((c, i) => (
              <div key={i} className="flex items-center gap-1.5 bg-[var(--panel)] border border-[var(--border)] rounded-md px-2 py-1">
                <input
                  value={c.slug}
                  onChange={(e) => updateChild(i, { slug: e.target.value })}
                  disabled={!editable}
                  className="w-[140px] shrink-0 bg-transparent border-b border-transparent focus:border-[var(--accent)] outline-none text-[12.5px] font-mono py-0.5 disabled:opacity-60"
                  placeholder="slug"
                />
                <input
                  value={c.overview}
                  onChange={(e) => updateChild(i, { overview: e.target.value })}
                  disabled={!editable}
                  className="flex-1 bg-transparent border-b border-transparent focus:border-[var(--accent)] outline-none text-[12.5px] py-0.5 disabled:opacity-60"
                  placeholder="overview"
                />
                {editable && (
                  <button
                    onClick={() => removeChild(i)}
                    className="text-[var(--muted)] hover:text-[#dc2626] text-[12px] px-1"
                    title="Remove"
                  >×</button>
                )}
              </div>
            ))}
            {editable && (
              <button
                onClick={addChild}
                className="text-[11.5px] text-[var(--muted)] hover:text-[var(--text)] underline underline-offset-2"
              >+ add child workspace</button>
            )}
          </div>
        </div>
      </div>
      )}
      {editable && (
        <div className="mt-3 flex items-center justify-end gap-2">
          {error && <div className="text-[12px] text-[#dc2626] mr-auto">{error}</div>}
          <button
            onClick={create}
            disabled={creating || !wsSlug.trim()}
            className="bg-[var(--accent)] text-[var(--accent-text)] rounded-md px-3 py-1.5 text-[13px] font-medium disabled:opacity-40 hover:brightness-110"
          >{creating ? "Creating…" : "Create workspace"}</button>
        </div>
      )}
    </div>
  );
}
