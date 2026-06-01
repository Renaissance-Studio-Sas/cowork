import { Hono } from "hono";
import { ensureWorkspace, listWorkspaces } from "@/lib/fs";

// Legacy "list everything" endpoint. The sidebar uses this on boot to get the
// top-level workspace tree (each entry carries its child tree recursively, so
// one request describes the whole hierarchy).
export const workspace = new Hono();

workspace.get("/", async (c) => {
  await ensureWorkspace();
  const workspaces = await listWorkspaces();
  return c.json({ workspaces });
});
