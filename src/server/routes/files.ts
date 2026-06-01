import { Hono, type Context } from "hono";
import fs from "node:fs/promises";
import path from "node:path";
import {
  deleteFile,
  getWorkspace,
  readFileText,
  renameFile,
  workspaceDir,
  writeFileText,
} from "@/lib/fs";
import { decodeWorkspacePath } from "@/lib/routes";

export const files = new Hono();

// Workspaces collapse the old (project, task) pair into a single slug-chain
// passed via the `workspace=` query param (each segment URI-encoded, joined
// with `/`). Helper used by every handler below.
function workspacePathFromQuery(c: Context): string[] | null {
  const raw = c.req.query("workspace");
  if (raw === undefined || raw === null) return null;
  return decodeWorkspacePath(raw);
}

function mimeFor(p: string): string {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case ".css": return "text/css; charset=utf-8";
    case ".js": case ".mjs": return "text/javascript; charset=utf-8";
    case ".ts": case ".tsx": return "text/typescript; charset=utf-8";
    case ".md": case ".txt": return "text/plain; charset=utf-8";
    case ".html": case ".htm": return "text/html; charset=utf-8";
    case ".json": return "application/json";
    case ".xml": return "application/xml";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    case ".ttf": return "font/ttf";
    case ".otf": return "font/otf";
    case ".eot": return "application/vnd.ms-fontobject";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".ico": return "image/x-icon";
    case ".pdf": return "application/pdf";
    case ".csv": return "text/csv; charset=utf-8";
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".zip": return "application/zip";
    default: return "application/octet-stream";
  }
}

// Stream a file's raw bytes out of a workspace's `files/` directory.
// Identification is `workspace=<slug-chain>&path=<relative path>`. With the
// project/task split gone there's only one shape — no second viewer code
// path.
files.get("/raw", async (c) => {
  const workspacePath = workspacePathFromQuery(c);
  const file = c.req.query("path");
  if (!workspacePath || !file) {
    return c.json({ error: "workspace, path required" }, 400);
  }

  const ws = await getWorkspace(workspacePath);
  if (!ws) return c.json({ error: "not found" }, 404);
  const base = path.join(workspaceDir(ws), "files");

  const full = path.resolve(base, file);
  if (!full.startsWith(base + path.sep) && full !== base) {
    return c.json({ error: "forbidden" }, 403);
  }
  try {
    const data = await fs.readFile(full);
    const name = path.basename(file);
    const asciiName = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    const disposition = `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`;
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": mimeFor(file),
        "Content-Disposition": disposition,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return c.json({ error: "not found" }, 404);
  }
});

// Max file size: 500MB
const MAX_FILE_SIZE = 500 * 1024 * 1024;

function ensureSafePath(base: string, rel: string): string {
  const target = path.resolve(base, rel);
  if (!target.startsWith(base + path.sep) && target !== base) {
    throw new Error("path escapes directory");
  }
  return target;
}

function sanitizeFilename(name: string): string {
  // Remove path separators and dangerous characters
  return name
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\.\./g, "-")
    .trim()
    .slice(0, 200);
}

files.post("/upload", async (c) => {
  const workspacePath = workspacePathFromQuery(c);
  // Default to the artifacts root (files/). Callers can still pass an explicit
  // subdir (e.g. the artifacts list passes the folder currently being viewed).
  const subdir = c.req.query("subdir") || "";

  if (!workspacePath) {
    return c.json({ error: "workspace required" }, 400);
  }

  // Parse multipart form data
  const formData = await c.req.raw.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return c.json({ error: "file required" }, 400);
  }

  if (file.size > MAX_FILE_SIZE) {
    return c.json(
      { error: `File too large. Max size is ${MAX_FILE_SIZE / 1024 / 1024}MB` },
      400,
    );
  }

  const ws = await getWorkspace(workspacePath);
  if (!ws) {
    return c.json({ error: "workspace not found" }, 404);
  }
  const base = path.join(workspaceDir(ws), "files");

  // Generate unique filename with timestamp
  const timestamp = Date.now();
  const safeName = sanitizeFilename(file.name);
  const filename = `${timestamp}-${safeName}`;
  const relativePath = path.join(subdir, filename);

  try {
    const fullPath = ensureSafePath(base, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    // Read file as ArrayBuffer and write to disk
    const buffer = await file.arrayBuffer();
    await fs.writeFile(fullPath, Buffer.from(buffer));

    return c.json({
      ok: true,
      path: relativePath,
      name: file.name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
    });
  } catch (err) {
    console.error("Upload error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// Read a text file (JSON wrapper, used by the in-app editor / viewer).
files.get("/", async (c) => {
  const workspacePath = workspacePathFromQuery(c);
  const file = c.req.query("path");
  if (!workspacePath || !file) {
    return c.json({ error: "workspace, path required" }, 400);
  }
  try {
    const content = await readFileText(workspacePath, file);
    return c.json({ content });
  } catch (err) {
    return c.json({ error: String(err) }, 404);
  }
});

files.put("/", async (c) => {
  const workspacePath = workspacePathFromQuery(c);
  const file = c.req.query("path");
  const { content } = await c.req.raw.json();
  if (!workspacePath || !file || typeof content !== "string") {
    return c.json({ error: "workspace, path, content required" }, 400);
  }
  await writeFileText(workspacePath, file, content);
  return c.json({ ok: true });
});

files.patch("/", async (c) => {
  const body = await c.req.raw.json();
  const { workspace, from, to } = body ?? {};
  if (!workspace || !from || !to) {
    return c.json({ error: "workspace, from, to required" }, 400);
  }
  const workspacePath = Array.isArray(workspace) ? workspace : decodeWorkspacePath(String(workspace));
  try {
    await renameFile(workspacePath, from, to);
    return c.json({ ok: true, path: to });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

files.delete("/", async (c) => {
  const workspacePath = workspacePathFromQuery(c);
  const file = c.req.query("path");
  if (!workspacePath || !file) {
    return c.json({ error: "workspace, path required" }, 400);
  }
  try {
    await deleteFile(workspacePath, file);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});
