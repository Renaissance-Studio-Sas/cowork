import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { getProject, projectDirFor, taskDir } from "@/lib/fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mimeFor(p: string): string {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case ".md": case ".txt": return "text/plain; charset=utf-8";
    case ".html": case ".htm": return "text/html; charset=utf-8";
    case ".json": return "application/json";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".pdf": return "application/pdf";
    case ".csv": return "text/csv; charset=utf-8";
    default: return "application/octet-stream";
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const task = url.searchParams.get("task") || "";
  const file = url.searchParams.get("path");
  if (!project || !file) {
    return NextResponse.json({ error: "project, path required" }, { status: 400 });
  }

  let base: string;
  if (task) {
    const p = await getProject(project);
    const t = p?.tasks.find((x) => x.slug === task);
    if (!p || !t) return NextResponse.json({ error: "not found" }, { status: 404 });
    base = path.join(taskDir(p, t), "files");
  } else {
    try { base = path.join(await projectDirFor(project), "files"); }
    catch { return NextResponse.json({ error: "not found" }, { status: 404 }); }
  }

  const full = path.resolve(base, file);
  if (!full.startsWith(base + path.sep) && full !== base) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const data = await fs.readFile(full);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": mimeFor(file),
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
