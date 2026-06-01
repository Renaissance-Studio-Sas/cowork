import { Hono } from "hono";
import { proxy, type ProxyBindings } from "../lib/proxy";

// Mirrors src/server/routes/workspace.ts — lists all top-level workspaces
// from the backend filesystem (each entry carries its full child tree, so
// the sidebar gets the whole hierarchy from a single fetch).
export const workspace = new Hono<{ Bindings: ProxyBindings }>();

workspace.get("/", proxy); // GET /api/workspace
