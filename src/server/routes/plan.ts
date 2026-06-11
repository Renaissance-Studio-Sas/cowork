import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { createWorkspace, getWorkspace } from "@/lib/fs";
import { startSession } from "@/lib/sessions";

export const plan = new Hono();

// Starts a "create-child-workspace" planning chat as a normal session, so it
// shows up in the sidebar and the user can work in parallel.
//
// With the workspace model unified, planning has one shape: produce a child
// workspace under some parent. There's no "project vs task" distinction
// anymore. The session itself runs inside the parent (planning sessions live
// next to their soon-to-be-sibling workspaces).
//
// - When `parent` is the slug-chain of an existing workspace, the planning
//   session is created inside it; the new child slots underneath on accept.
// - When `parent` is empty / missing, the planner creates a top-level
//   workspace. To give the planning session a place to live we spin up a
//   stub root workspace (`untitled-<id>`) and start the chat inside it. On
//   accept (POST /api/workspaces/from-plan), the stub is renamed to the
//   accepted slug and its brief is filled in.
plan.post("/", async (c) => {
  const body = await c.req.raw.json();
  if (!body.message || typeof body.message !== "string") {
    return c.json({ error: "message required" }, 400);
  }

  try {
    const parentPath: string[] | undefined = Array.isArray(body.parent) ? body.parent : undefined;
    // Optional model pin chosen in the composer; ignore non-strings / blanks so
    // the runtime default applies.
    const model: string | undefined =
      typeof body.model === "string" && body.model.trim() ? body.model : undefined;

    // Nested-workspace planning: parent exists; the session lives in it.
    if (parentPath && parentPath.length > 0) {
      const parent = await getWorkspace(parentPath);
      if (!parent) {
        return c.json({ error: `unknown parent ${parentPath.join("/")}` }, 400);
      }
      const s = await startSession({
        workspacePath: parentPath,
        firstMessage: body.message,
        planning: true,
        model,
      });
      return c.json({ id: s.id, workspacePath: parentPath });
    }

    // Root-workspace planning: no parent → create a stub root workspace then
    // host the planning session inside it. Stub slug is `untitled-<6char>` to
    // avoid clashing with any user-created workspace and to read clearly in
    // the sidebar while the user is still planning.
    const stubSlug = `untitled-${randomUUID().slice(0, 6)}`;
    const stub = await createWorkspace([], stubSlug);
    const s = await startSession({
      workspacePath: stub.path,
      firstMessage: body.message,
      planning: true,
      model,
    });
    return c.json({ id: s.id, workspacePath: stub.path });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});
