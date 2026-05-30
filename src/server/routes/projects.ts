import { Hono } from "hono";
import {
  createProject,
  createTask,
  getProject,
  renameProject,
  setProjectBrief,
  setProjectStatus,
  deleteProject,
  listProjectFiles,
  listProjectFilesMeta,
  deleteTask,
  getTask,
  setTaskStatus,
  listFiles,
  listFilesMeta,
  renameTask,
  moveTask,
} from "@/lib/fs";
import {
  startProjectSession,
  startSession,
  markSessionCompleted,
  moveSessionToTask,
} from "@/lib/sessions";

export const projects = new Hono();

// ---- collection ---------------------------------------------------------
projects.post("/", async (c) => {
  const req = c.req.raw;
  const body = await req.json();
  if (!body.slug || typeof body.slug !== "string") {
    return c.json({ error: "slug required" }, 400);
  }
  const project = await createProject(body.slug, {
    overview: body.overview ?? "",
    details: body.details ?? "",
  });
  return c.json(project);
});

// Materializes a (possibly edited) plan from the "New project" planning chat.
// The chat runs in a normal project-level session inside a stub project
// (created by /api/plan). On accept, we rename the stub to the chosen slug,
// fill in the project brief (overview + details), create the proposed
// tasks, and mark the planning session completed. The session naturally
// moves with the renamed project folder.
projects.post("/from-plan", async (c) => {
  const req = c.req.raw;
  const body = await req.json();
  const currentSlug: string = body.current_slug;
  const newSlug: string = body.slug;
  const overview: string = body.overview ?? "";
  const details: string = body.details ?? "";
  const tasks: Array<{ slug: string; overview?: string; details?: string }> = body.tasks ?? [];
  const sessionId: string | undefined = body.session_id;

  if (!currentSlug || typeof currentSlug !== "string") {
    return c.json({ error: "current_slug required" }, 400);
  }
  if (!newSlug || typeof newSlug !== "string") {
    return c.json({ error: "slug required" }, 400);
  }

  try {
    const existing = await getProject(currentSlug);
    if (!existing) {
      return c.json({ error: `unknown project ${currentSlug}` }, 404);
    }

    if (newSlug !== currentSlug) {
      await renameProject(currentSlug, newSlug);
    }
    await setProjectBrief(newSlug, { overview, details });
    for (const t of tasks) {
      if (!t.slug) continue;
      await createTask(newSlug, t.slug, { overview: t.overview ?? "", details: t.details ?? "" });
    }
    if (sessionId) {
      await markSessionCompleted(newSlug, "", sessionId, true);
    }
    return c.json({ ok: true, slug: newSlug });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

// ---- a single project ---------------------------------------------------
projects.get("/:project", async (c) => {
  const project = c.req.param("project");
  const p = await getProject(project);
  if (!p) return c.json({ error: "not found" }, 404);
  return c.json(p);
});

projects.patch("/:project", async (c) => {
  const req = c.req.raw;
  const project = c.req.param("project");
  const body = await req.json();
  try {
    if (body.status && (body.status === "active" || body.status === "archived")) {
      await setProjectStatus(project, body.status);
    }
    if (typeof body.slug === "string" && body.slug !== project) {
      await renameProject(project, body.slug);
      return c.json({ ok: true, slug: body.slug });
    }
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

projects.delete("/:project", async (c) => {
  const project = c.req.param("project");
  try {
    await deleteProject(project);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

projects.get("/:project/files", async (c) => {
  const project = c.req.param("project");
  const [files, filesMeta] = await Promise.all([
    listProjectFiles(project),
    listProjectFilesMeta(project),
  ]);
  return c.json({ files, filesMeta });
});

// Project-level session — runs with cwd = the project folder. No task slug.
projects.post("/:project/sessions", async (c) => {
  const req = c.req.raw;
  const project = c.req.param("project");
  const body = await req.json();
  if (!body.message || typeof body.message !== "string") {
    return c.json({ error: "message required" }, 400);
  }
  try {
    const s = await startProjectSession({
      projectSlug: project,
      firstMessage: body.message,
      permissionMode: body.permissionMode,
      model: body.model,
      effort: body.effort,
      runtime: body.runtime,
      openArtifact: typeof body.openArtifact === "string" && body.openArtifact.length > 0 ? body.openArtifact : undefined,
    });
    return c.json({ id: s.id, state: s.state });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ---- tasks under a project ----------------------------------------------
projects.post("/:project/tasks", async (c) => {
  const req = c.req.raw;
  const project = c.req.param("project");
  const body = await req.json();
  if (!body.slug || typeof body.slug !== "string") {
    return c.json({ error: "slug required" }, 400);
  }
  const task = await createTask(project, body.slug, {
    overview: body.overview ?? "",
    details: body.details ?? "",
  });
  return c.json(task);
});

// Materializes a (possibly edited) task proposal from the "New task" planning
// chat. The planning session is created at the project level; on accept we
// create the task, then move that session inside it and mark it completed so
// the planning conversation lives with the task it produced.
projects.post("/:project/tasks/from-plan", async (c) => {
  const req = c.req.raw;
  const project = c.req.param("project");
  const body = await req.json();
  const slug: string = body.slug;
  const overview: string = body.overview ?? "";
  const details: string = body.details ?? "";
  const sessionId: string | undefined = body.session_id;

  if (!slug || typeof slug !== "string") {
    return c.json({ error: "slug required" }, 400);
  }

  try {
    const task = await createTask(project, slug, { overview, details });
    if (sessionId) {
      await moveSessionToTask(sessionId, task.slug);
      await markSessionCompleted(project, task.slug, sessionId, true);
    }
    return c.json({ ok: true, slug: task.slug });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

projects.get("/:project/tasks/:task", async (c) => {
  const project = c.req.param("project");
  const task = c.req.param("task");
  const t = await getTask(project, task);
  if (!t) return c.json({ error: "not found" }, 404);
  const [files, filesMeta] = await Promise.all([
    listFiles(project, task),
    listFilesMeta(project, task),
  ]);
  return c.json({ ...t, files, filesMeta });
});

projects.patch("/:project/tasks/:task", async (c) => {
  const req = c.req.raw;
  const project = c.req.param("project");
  const task = c.req.param("task");
  const body = await req.json();

  try {
    if (body.status && (body.status === "active" || body.status === "archived")) {
      await setTaskStatus(project, task, body.status);
    }

    // Move to another project (rename within new parent if needed)
    if (typeof body.project === "string" && body.project !== project) {
      const res = await moveTask(project, task, body.project);
      return c.json({ ok: true, project: res.project, task: res.task });
    }

    // Rename within the same project
    if (typeof body.slug === "string" && body.slug !== task) {
      await renameTask(project, task, body.slug);
      return c.json({ ok: true, task: body.slug });
    }

    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

projects.delete("/:project/tasks/:task", async (c) => {
  const project = c.req.param("project");
  const task = c.req.param("task");
  try {
    await deleteTask(project, task);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

projects.post("/:project/tasks/:task/sessions", async (c) => {
  const req = c.req.raw;
  const project = c.req.param("project");
  const task = c.req.param("task");
  const body = await req.json();
  if (!body.message || typeof body.message !== "string") {
    return c.json({ error: "message required" }, 400);
  }
  try {
    const s = await startSession({
      projectSlug: project,
      taskSlug: task,
      firstMessage: body.message,
      permissionMode: body.permissionMode,
      model: body.model,
      effort: body.effort,
      runtime: body.runtime,
      openArtifact: typeof body.openArtifact === "string" && body.openArtifact.length > 0 ? body.openArtifact : undefined,
    });
    return c.json({ id: s.id, state: s.state });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});
