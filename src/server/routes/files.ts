import { Hono } from "hono";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getProject,
  projectDirFor,
  taskDir,
  projectDir,
  deleteFile,
  deleteProjectFile,
  readFileText,
  readProjectFileText,
  renameFile,
  renameProjectFile,
  writeFileText,
} from "@/lib/fs";

export const files = new Hono();

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

files.get("/raw", async (c) => {
  const req = c.req.raw;
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const task = url.searchParams.get("task") || "";
  const file = url.searchParams.get("path");
  if (!project || !file) {
    return c.json({ error: "project, path required" }, 400);
  }

  let base: string;
  if (task) {
    const p = await getProject(project);
    const t = p?.tasks.find((x) => x.slug === task);
    if (!p || !t) return c.json({ error: "not found" }, 404);
    base = path.join(taskDir(p, t), "files");
  } else {
    try { base = path.join(await projectDirFor(project), "files"); }
    catch { return c.json({ error: "not found" }, 404); }
  }

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

// Max file size: 10MB
const MAX_FILE_SIZE = 10 * 1024 * 1024;

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
  const req = c.req.raw;
  const url = new URL(req.url);
  const projectSlug = url.searchParams.get("project");
  const taskSlug = url.searchParams.get("task") || "";
  const subdir = url.searchParams.get("subdir") || "uploads";

  if (!projectSlug) {
    return c.json({ error: "project required" }, 400);
  }

  // Parse multipart form data
  const formData = await req.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return c.json({ error: "file required" }, 400);
  }

  if (file.size > MAX_FILE_SIZE) {
    return c.json(
      { error: `File too large. Max size is ${MAX_FILE_SIZE / 1024 / 1024}MB` },
      400
    );
  }

  // Determine base directory
  let base: string;
  if (taskSlug) {
    const project = await getProject(projectSlug);
    const task = project?.tasks.find((t) => t.slug === taskSlug);
    if (!project || !task) {
      return c.json({ error: "task not found" }, 404);
    }
    base = path.join(taskDir(project, task), "files");
  } else {
    const project = await getProject(projectSlug);
    if (!project) {
      return c.json({ error: "project not found" }, 404);
    }
    base = path.join(projectDir(project), "files");
  }

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
    return c.json(
      { error: String(err) },
      500
    );
  }
});

files.get("/", async (c) => {
  const req = c.req.raw;
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const task = url.searchParams.get("task") || "";
  const file = url.searchParams.get("path");
  if (!project || !file) {
    return c.json({ error: "project, path required" }, 400);
  }
  try {
    const content = task
      ? await readFileText(project, task, file)
      : await readProjectFileText(project, file);
    return c.json({ content });
  } catch (err) {
    return c.json({ error: String(err) }, 404);
  }
});

files.put("/", async (c) => {
  const req = c.req.raw;
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const task = url.searchParams.get("task");
  const file = url.searchParams.get("path");
  const { content } = await req.json();
  if (!project || !task || !file || typeof content !== "string") {
    return c.json({ error: "project, task, path, content required" }, 400);
  }
  await writeFileText(project, task, file, content);
  return c.json({ ok: true });
});

files.patch("/", async (c) => {
  const req = c.req.raw;
  const body = await req.json();
  const { project, task, from, to } = body ?? {};
  if (!project || !from || !to) {
    return c.json({ error: "project, from, to required" }, 400);
  }
  try {
    if (task) {
      await renameFile(project, task, from, to);
    } else {
      await renameProjectFile(project, from, to);
    }
    return c.json({ ok: true, path: to });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

files.delete("/", async (c) => {
  const req = c.req.raw;
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const task = url.searchParams.get("task");
  const file = url.searchParams.get("path");
  if (!project || !file) {
    return c.json({ error: "project, path required" }, 400);
  }
  try {
    if (task) {
      await deleteFile(project, task, file);
    } else {
      await deleteProjectFile(project, file);
    }
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});
