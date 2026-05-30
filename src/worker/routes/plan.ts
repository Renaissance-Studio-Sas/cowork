import { Hono } from "hono";
import { proxy, type ProxyBindings } from "../lib/proxy";

// Mirrors src/app/api/plan — starts a planning session on the backend (spawns
// an agent), so it must run there.
export const plan = new Hono<{ Bindings: ProxyBindings }>();

plan.post("/", proxy); // POST /api/plan
