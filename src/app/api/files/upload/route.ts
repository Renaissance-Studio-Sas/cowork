import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { getProject, getTask, taskDir, projectDir } from "@/lib/fs";

export const runtime = "nodejs";

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

export async function POST(req: Request) {
  const url = new URL(req.url);
  const projectSlug = url.searchParams.get("project");
  const taskSlug = url.searchParams.get("task") || "";
  // Default to the artifacts root (files/). Callers can still pass an explicit
  // subdir (e.g. the artifacts list passes the folder currently being viewed).
  const subdir = url.searchParams.get("subdir") || "";

  if (!projectSlug) {
    return NextResponse.json({ error: "project required" }, { status: 400 });
  }

  // Parse multipart form data
  const formData = await req.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: `File too large. Max size is ${MAX_FILE_SIZE / 1024 / 1024}MB` },
      { status: 400 }
    );
  }

  // Determine base directory
  let base: string;
  if (taskSlug) {
    const project = await getProject(projectSlug);
    const task = project?.tasks.find((t) => t.slug === taskSlug);
    if (!project || !task) {
      return NextResponse.json({ error: "task not found" }, { status: 404 });
    }
    base = path.join(taskDir(project, task), "files");
  } else {
    const project = await getProject(projectSlug);
    if (!project) {
      return NextResponse.json({ error: "project not found" }, { status: 404 });
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

    return NextResponse.json({
      ok: true,
      path: relativePath,
      name: file.name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
    });
  } catch (err) {
    console.error("Upload error:", err);
    return NextResponse.json(
      { error: String(err) },
      { status: 500 }
    );
  }
}
