import { Hono, type Context } from "hono";
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listFiles,
  listFilesMeta,
  listWorkspaces,
  moveWorkspace,
  renameWorkspace,
  setWorkspaceBrief,
  setWorkspaceStatus,
} from "@/lib/fs";
import {
  markSessionCompleted,
  moveSessionToWorkspace,
  startSession,
} from "@/lib/sessions";
import { decodeWorkspacePath } from "@/lib/routes";

// Mirrors the recursive `Workspace` model in src/lib/fs.ts. A workspace is
// identified by a slug-chain (e.g. `["HR", "pay-contractors"]`). On the wire
// the chain is URL-encoded per-segment and joined with `/`, captured by the
// Hono splat (`*`) param — so `GET /api/workspaces/HR/pay-contractors` resolves
// the nested workspace, and `POST /api/workspaces/HR` creates a child under HR.
//
// An empty splat (`/api/workspaces`) targets the root: GET lists every
// top-level workspace (with its child tree), POST creates a top-level
// workspace.
export const workspaces = new Hono();

// Decode the multi-segment `:path{.*}` route param (e.g. "HR/pay-contractors")
// into a slug-chain. Hono 4's bare `*` splat doesn't expose its capture via
// `c.req.param("*")` — a named regex param does, so every route in this file
// uses `:path{.*}` and reads it back here.
// Missing/empty param → empty array (root).
function pathFromSplat(c: Context): string[] {
  const raw = (c.req.param("path") as string | undefined) ?? "";
  return decodeWorkspacePath(raw);
}

// ---- collection (root: empty splat) -------------------------------------

// List all top-level workspaces. Each carries its full nested `children` tree
// so the sidebar can render the whole hierarchy from one fetch.
workspaces.get("/", async (c) => {
  const tree = await listWorkspaces();
  return c.json({ workspaces: tree });
});

// Materializes a (possibly edited) plan from the "New workspace" planning
// chat. The chat runs in a normal session inside a stub workspace (created by
// /api/plan). On accept, we rename the stub to the chosen slug, fill in the
// brief, optionally create proposed child workspaces, and mark the planning
// session completed. The session naturally follows the renamed folder via the
// in-meta `workspace` path.
workspaces.post("/from-plan", async (c) => {
  const body = await c.req.raw.json();
  const currentPath: string[] = Array.isArray(body.current_path) ? body.current_path : [];
  const newSlug: string = body.slug;
  const overview: string = body.overview ?? "";
  const details: string = body.details ?? "";
  const children: Array<{ slug: string; overview?: string; details?: string }> = body.children ?? [];
  const sessionId: string | undefined = body.session_id;

  if (currentPath.length === 0) {
    return c.json({ error: "current_path required" }, 400);
  }
  if (!newSlug || typeof newSlug !== "string") {
    return c.json({ error: "slug required" }, 400);
  }

  try {
    const existing = await getWorkspace(currentPath);
    if (!existing) {
      return c.json({ error: `unknown workspace ${currentPath.join("/")}` }, 404);
    }

    const currentSlug = currentPath[currentPath.length - 1];
    let finalPath = currentPath;
    if (newSlug !== currentSlug) {
      await renameWorkspace(currentPath, newSlug);
      finalPath = [...currentPath.slice(0, -1), newSlug];
    }
    await setWorkspaceBrief(finalPath, { overview, details });
    for (const child of children) {
      if (!child.slug) continue;
      await createWorkspace(finalPath, child.slug, {
        overview: child.overview ?? "",
        details: child.details ?? "",
      });
    }
    if (sessionId) {
      await markSessionCompleted(finalPath, sessionId, true);
    }
    return c.json({ ok: true, path: finalPath });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

// Stub creation at the root: `POST /api/workspaces` (no slug in splat) ends up
// in `POST /*` with an empty splat — but Hono's splat won't match an empty
// path on a `/` POST. Keep an explicit alias so client UIs can hit either.
//
// The path-bearing variant (`POST /api/workspaces/<parent-chain>`) lives at
// the bottom of this file with the other `/:path{.*}` catch-alls — declaring
// it here would shadow `/move/...`, `/sessions/...`, etc. (Hono matches in
// declaration order, and `/:path{.*}` greedily eats those prefixes).
workspaces.post("/", async (c) => {
  const body = await c.req.raw.json();
  if (!body.slug || typeof body.slug !== "string") {
    return c.json({ error: "slug required" }, 400);
  }
  try {
    const created = await createWorkspace([], body.slug, {
      overview: body.overview ?? "",
      details: body.details ?? "",
    });
    return c.json(created);
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

// ---- nested sub-resources on a single workspace -------------------------
//
// These must be declared BEFORE the catch-all `/:* ` handlers below so they
// match first (Hono matches in declaration order).

// Move a workspace to a new parent (or to the root with `toParentPath: []`).
workspaces.post("/move/:path{.*}", async (c) => {
  const body = await c.req.raw.json();
  const slugPath = pathFromSplat(c);
  if (slugPath.length === 0) {
    return c.json({ error: "workspace path required" }, 400);
  }
  if (!Array.isArray(body.toParentPath)) {
    return c.json({ error: "toParentPath (string[]) required" }, 400);
  }
  try {
    const newPath = await moveWorkspace(slugPath, body.toParentPath);
    return c.json({ ok: true, path: newPath });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

// Status (active/archived) — patch is a separate verb so the body shape is
// trivial and never overlaps with brief updates.
workspaces.patch("/status/:path{.*}", async (c) => {
  const body = await c.req.raw.json();
  const slugPath = pathFromSplat(c);
  if (slugPath.length === 0) {
    return c.json({ error: "workspace path required" }, 400);
  }
  if (body.status !== "active" && body.status !== "archived") {
    return c.json({ error: "status must be 'active' or 'archived'" }, 400);
  }
  try {
    await setWorkspaceStatus(slugPath, body.status);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

// Rename a workspace's slug. Body: `{ newSlug }`. Returns the new path.
workspaces.patch("/rename/:path{.*}", async (c) => {
  const body = await c.req.raw.json();
  const slugPath = pathFromSplat(c);
  if (slugPath.length === 0) {
    return c.json({ error: "workspace path required" }, 400);
  }
  if (typeof body.newSlug !== "string" || !body.newSlug.trim()) {
    return c.json({ error: "newSlug required" }, 400);
  }
  try {
    await renameWorkspace(slugPath, body.newSlug);
    const newPath = [...slugPath.slice(0, -1), body.newSlug];
    return c.json({ ok: true, path: newPath });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

// List files inside a workspace's `files/` artifact directory. Returns both
// the flat list and the meta variant (with mtimes) so the UI can sort by
// recency without a second request.
workspaces.get("/files/:path{.*}", async (c) => {
  const slugPath = pathFromSplat(c);
  if (slugPath.length === 0) {
    return c.json({ error: "workspace path required" }, 400);
  }
  const [files, filesMeta] = await Promise.all([
    listFiles(slugPath),
    listFilesMeta(slugPath),
  ]);
  return c.json({ files, filesMeta });
});

// Start a normal session inside a workspace. With `planning: true` the agent
// is started in "New child workspace" planning mode — see
// buildWorkspacePlanningSystemPrompt — so it proposes a child to be added
// later via POST /from-plan.
workspaces.post("/sessions/:path{.*}", async (c) => {
  const body = await c.req.raw.json();
  const workspacePath = pathFromSplat(c);
  if (workspacePath.length === 0) {
    return c.json({ error: "workspace path required" }, 400);
  }
  if (!body.message || typeof body.message !== "string") {
    return c.json({ error: "message required" }, 400);
  }
  try {
    const s = await startSession({
      workspacePath,
      firstMessage: body.message,
      permissionMode: body.permissionMode,
      model: body.model,
      effort: body.effort,
      runtime: body.runtime,
      openArtifact: typeof body.openArtifact === "string" && body.openArtifact.length > 0
        ? body.openArtifact : undefined,
      files: Array.isArray(body.files) && body.files.length > 0 ? body.files : undefined,
      planning: body.planning === true,
    });
    return c.json({ id: s.id, state: s.state });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Move an existing session into a different workspace. This is the planner-
// confirms-child-workspace flow: the planning session itself runs in the
// parent; once the child workspace exists we reparent the session inside it.
workspaces.post("/sessions/:id/move/:path{.*}", async (c) => {
  const sessionId = c.req.param("id");
  const targetPath = pathFromSplat(c);
  if (!sessionId) return c.json({ error: "session id required" }, 400);
  if (targetPath.length === 0) {
    return c.json({ error: "workspace path required" }, 400);
  }
  try {
    const ok = await moveSessionToWorkspace(sessionId, targetPath);
    if (!ok) return c.json({ error: "session not found" }, 404);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

// ---- single workspace by path -------------------------------------------

// Create a workspace under the path captured by the splat. Empty splat would
// match the root, but Hono's splat won't match an empty `/` POST — so the
// root case is handled by the explicit `POST /` alias above. Body: `{ slug,
// overview?, details? }`. This must be declared AFTER every `/move/...`,
// `/sessions/...`, `/status/...`, `/rename/...` sub-resource — the splat is
// greedy and would otherwise eat them.
workspaces.post("/:path{.*}", async (c) => {
  const body = await c.req.raw.json();
  if (!body.slug || typeof body.slug !== "string") {
    return c.json({ error: "slug required" }, 400);
  }
  try {
    const parentPath = pathFromSplat(c);
    const created = await createWorkspace(parentPath, body.slug, {
      overview: body.overview ?? "",
      details: body.details ?? "",
    });
    return c.json(created);
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

// Fetch a single workspace (with its child tree) by slug-path.
workspaces.get("/:path{.*}", async (c) => {
  const slugPath = pathFromSplat(c);
  if (slugPath.length === 0) {
    return c.json({ error: "workspace path required" }, 400);
  }
  const ws = await getWorkspace(slugPath);
  if (!ws) return c.json({ error: "not found" }, 404);
  return c.json(ws);
});

// Update a workspace's brief (overview / details). Body: `{ overview?,
// details? }`. Either or both fields may be omitted; missing fields keep
// their current value via setWorkspaceBrief.
workspaces.put("/:path{.*}", async (c) => {
  const slugPath = pathFromSplat(c);
  if (slugPath.length === 0) {
    return c.json({ error: "workspace path required" }, 400);
  }
  const body = await c.req.raw.json();
  try {
    await setWorkspaceBrief(slugPath, {
      overview: typeof body.overview === "string" ? body.overview : undefined,
      details: typeof body.details === "string" ? body.details : undefined,
    });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

workspaces.delete("/:path{.*}", async (c) => {
  const slugPath = pathFromSplat(c);
  if (slugPath.length === 0) {
    return c.json({ error: "workspace path required" }, 400);
  }
  try {
    await deleteWorkspace(slugPath);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});
