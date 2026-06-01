import { Hono } from "hono";
import { proxy, type ProxyBindings } from "../lib/proxy";

// Mirrors src/server/routes/files.ts — reads/writes artifact files inside a
// workspace's `files/` directory. The workspace is identified by the
// `workspace=` query param (slug-chain). `/raw` streams binary content;
// `/upload` accepts multipart bodies — both pass straight through the
// streaming proxy.
export const files = new Hono<{ Bindings: ProxyBindings }>();

files.get("/raw", proxy); //   GET  /api/files/raw
files.post("/upload", proxy); // POST /api/files/upload

files.get("/", proxy); //      GET    /api/files
files.put("/", proxy); //      PUT    /api/files
files.patch("/", proxy); //    PATCH  /api/files
files.delete("/", proxy); //   DELETE /api/files
