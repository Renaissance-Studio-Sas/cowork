import { Hono } from "hono";
import {
  addComment,
  listComments,
  deleteComment,
  setResolved,
  updateComment,
  commentCounts,
} from "@/lib/comments-store";

export const comments = new Hono();

// Static path before the param route so `/counts` never matches `/:id`.
comments.get("/counts", async (c) => {
  const req = c.req.raw;
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const task = url.searchParams.get("task") ?? "";  // empty = project-level
  if (!project) {
    return c.json({ error: "project required" }, 400);
  }
  const counts = await commentCounts(project, task);
  return c.json({ counts });
});

comments.get("/", async (c) => {
  const req = c.req.raw;
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const task = url.searchParams.get("task") ?? "";  // empty string for project-level
  const file = url.searchParams.get("path");
  if (!project || !file) {
    return c.json({ error: "project, path required" }, 400);
  }
  const rows = await listComments(project, task, file);
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
  const req = c.req.raw;
  const body = await req.json();
  const { project, task = "", path: file, anchorType, anchor, body: text, author } = body ?? {};
  if (!project || !file || !text || !anchorType) {
    return c.json({ error: "project, path, anchorType, body required" }, 400);
  }
  if (anchorType !== "md" && anchorType !== "html") {
    return c.json({ error: "anchorType must be md or html" }, 400);
  }
  const created = await addComment(project, task, {
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

// The store is keyed by (project, task, id) but our existing API URLs only
// carry `id`. The caller must include project + task in the query string so
// we know which project/task's `.comments.json` to mutate.
// Task is optional — empty string means project-level comments.
comments.delete("/:id", async (c) => {
  const req = c.req.raw;
  const id = c.req.param("id");
  const url = new URL(req.url);
  const project = url.searchParams.get("project") ?? "";
  const task = url.searchParams.get("task") ?? "";  // empty = project-level
  if (!project) {
    return c.json({ error: "project required (querystring)" }, 400);
  }
  const removed = await deleteComment(project, task, Number(id));
  if (!removed) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

comments.patch("/:id", async (c) => {
  const req = c.req.raw;
  const id = c.req.param("id");
  const url = new URL(req.url);
  const project = url.searchParams.get("project") ?? "";
  const task = url.searchParams.get("task") ?? "";  // empty = project-level
  if (!project) {
    return c.json({ error: "project required (querystring)" }, 400);
  }
  const body = await req.json();

  // Handle body update
  if (typeof body.body === "string") {
    const updated = await updateComment(project, task, Number(id), body.body);
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true, comment: updated });
  }

  // Handle resolved status
  if (body.resolved === true) await setResolved(project, task, Number(id), true);
  else if (body.resolved === false) await setResolved(project, task, Number(id), false);
  return c.json({ ok: true });
});
