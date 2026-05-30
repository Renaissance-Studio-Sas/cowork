import { Hono } from "hono";
import { listProjects, ensureWorkspace } from "@/lib/fs";

export const workspace = new Hono();

workspace.get("/", async (c) => {
  await ensureWorkspace();
  const projects = await listProjects();
  return c.json({ projects });
});
