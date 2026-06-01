import { Hono } from "hono";
import { proxy, type ProxyBindings } from "../lib/proxy";

// Mirrors src/server/routes/plan.ts — starts a planning session on the
// backend (spawns an agent), so it must run there. Body shape now: `{
// message, parent?: string[] }` — `parent` is the slug-chain of the parent
// workspace the new child will live under (empty/missing = top-level
// workspace, server creates a stub root).
export const plan = new Hono<{ Bindings: ProxyBindings }>();

plan.post("/", proxy); // POST /api/plan
