import { Hono, type Context } from "hono";
import {
  addComment,
  commentCounts,
  deleteComment,
  listComments,
  setResolved,
  updateComment,
} from "@/lib/comments-store";
import { decodeWorkspacePath } from "@/lib/routes";

export const comments = new Hono();

// All comment endpoints carry the workspace as a `workspace=` query param —
// the slug-chain URL-encoded per segment and joined with `/`. Empty/missing
// is an error: comments are always workspace-scoped, never global.
function workspacePathFromQuery(c: Context): string[] | null {
  const raw = c.req.query("workspace");
  if (raw === undefined || raw === null) return null;
  return decodeWorkspacePath(raw);
}

// Static path before the param route so `/counts` never matches `/:id`.
comments.get("/counts", async (c) => {
  const workspacePath = workspacePathFromQuery(c);
  if (!workspacePath) {
    return c.json({ error: "workspace required" }, 400);
  }
  const counts = await commentCounts(workspacePath);
  return c.json({ counts });
});

comments.get("/", async (c) => {
  const workspacePath = workspacePathFromQuery(c);
  const file = c.req.query("path");
  if (!workspacePath || !file) {
    return c.json({ error: "workspace, path required" }, 400);
  }
  const rows = await listComments(workspacePath, file);
  // Keep the legacy field name `anchorData` so the FileViewer can normalize
  // backward-compat shapes without changing.
  return c.json({
    comments: rows.map((c) => ({
      id: c.id,
      body: c.body,
      author: c.author,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      resolvedAt: c.resolvedAt,
      anchorType: c.anchorType,
      anchorData: c.anchor,
    })),
  });
});

comments.post("/", async (c) => {
  const body = await c.req.raw.json();
  const { workspace, path: file, anchorType, anchor, body: text, author } = body ?? {};
  if (!workspace || !file || !text || !anchorType) {
    return c.json({ error: "workspace, path, anchorType, body required" }, 400);
  }
  if (anchorType !== "md" && anchorType !== "html") {
    return c.json({ error: "anchorType must be md or html" }, 400);
  }
  const workspacePath = Array.isArray(workspace) ? workspace : decodeWorkspacePath(String(workspace));
  const created = await addComment(workspacePath, {
    filePath: file,
    anchorType,
    anchor: anchor ?? {},
    body: text,
    author: author || "marco",
  });
  return c.json({
    comment: {
      id: created.id,
      body: created.body,
      author: created.author,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      resolvedAt: created.resolvedAt,
      anchorType: created.anchorType,
      anchorData: created.anchor,
    },
  });
});

// The store is keyed by (workspace, id) but our existing API URLs only carry
// `id`. The caller must include `workspace=...` in the query string so we
// know which workspace's `.comments.json` to mutate.
comments.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const workspacePath = workspacePathFromQuery(c);
  if (!workspacePath) {
    return c.json({ error: "workspace required (querystring)" }, 400);
  }
  const removed = await deleteComment(workspacePath, Number(id));
  if (!removed) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

comments.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const workspacePath = workspacePathFromQuery(c);
  if (!workspacePath) {
    return c.json({ error: "workspace required (querystring)" }, 400);
  }
  const body = await c.req.raw.json();

  // Handle body update
  if (typeof body.body === "string") {
    const updated = await updateComment(workspacePath, Number(id), body.body);
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true, comment: updated });
  }

  // Handle resolved status
  if (body.resolved === true) await setResolved(workspacePath, Number(id), true);
  else if (body.resolved === false) await setResolved(workspacePath, Number(id), false);
  return c.json({ ok: true });
});
