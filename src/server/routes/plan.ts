import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { createProject, getProject } from "@/lib/fs";
import { startProjectSession } from "@/lib/sessions";

export const plan = new Hono();

// Starts a create-project or create-task planning chat as a normal
// project-level session, so it shows up in the sidebar and the user can
// work in parallel.
//
// - mode=task: scoped to an existing project; the agent proposes one task.
// - mode=project (default): creates a stub project up-front named
//   "untitled-<6char>" and starts the session inside it. The user accepts
//   the plan via /api/projects/from-plan which renames the stub.
plan.post("/", async (c) => {
  const req = c.req.raw;
  const body = await req.json();
  if (!body.message || typeof body.message !== "string") {
    return c.json({ error: "message required" }, 400);
  }

  try {
    if (body.mode === "task") {
      if (!body.project || typeof body.project !== "string") {
        return c.json({ error: "project required for mode=task" }, 400);
      }
      const project = await getProject(body.project);
      if (!project) {
        return c.json({ error: `unknown project ${body.project}` }, 400);
      }
      const s = await startProjectSession({
        projectSlug: project.slug,
        firstMessage: body.message,
        planning: "task",
      });
      return c.json({ id: s.id, projectSlug: project.slug });
    }

    // mode=project (default): create stub then start a session inside it.
    const stubSlug = `untitled-${randomUUID().slice(0, 6)}`;
    const stub = await createProject(stubSlug);
    const s = await startProjectSession({
      projectSlug: stub.slug,
      firstMessage: body.message,
      planning: "project",
    });
    return c.json({ id: s.id, projectSlug: stub.slug });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});
