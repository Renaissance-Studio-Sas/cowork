import { NextResponse } from "next/server";
import { deleteFile, readFileText, renameFile, writeFileText, readProjectFileText } from "@/lib/fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const task = url.searchParams.get("task") || "";
  const file = url.searchParams.get("path");
  if (!project || !file) {
    return NextResponse.json({ error: "project, path required" }, { status: 400 });
  }
  try {
    const content = task
      ? await readFileText(project, task, file)
      : await readProjectFileText(project, file);
    return NextResponse.json({ content });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 404 });
  }
}

export async function PUT(req: Request) {
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const task = url.searchParams.get("task");
  const file = url.searchParams.get("path");
  const { content } = await req.json();
  if (!project || !task || !file || typeof content !== "string") {
    return NextResponse.json({ error: "project, task, path, content required" }, { status: 400 });
  }
  await writeFileText(project, task, file, content);
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request) {
  const body = await req.json();
  const { project, task, from, to } = body ?? {};
  if (!project || !task || !from || !to) {
    return NextResponse.json({ error: "project, task, from, to required" }, { status: 400 });
  }
  try {
    await renameFile(project, task, from, to);
    return NextResponse.json({ ok: true, path: to });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const task = url.searchParams.get("task");
  const file = url.searchParams.get("path");
  if (!project || !task || !file) {
    return NextResponse.json({ error: "project, task, path required" }, { status: 400 });
  }
  try {
    await deleteFile(project, task, file);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}
