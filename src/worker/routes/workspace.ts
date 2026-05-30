import { Hono } from "hono";
import { proxy, type ProxyBindings } from "../lib/proxy";

// Mirrors src/app/api/workspace — lists projects from the backend filesystem.
export const workspace = new Hono<{ Bindings: ProxyBindings }>();

workspace.get("/", proxy); // GET /api/workspace
