import { NextResponse } from "next/server";
import { addComment, listComments } from "@/lib/comments-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const task = url.searchParams.get("task") ?? "";  // empty string for project-level
  const file = url.searchParams.get("path");
  if (!project || !file) {
    return NextResponse.json({ error: "project, path required" }, { status: 400 });
  }
  const rows = await listComments(project, task, file);
  // Keep the legacy field name `anchorData` so the FileViewer can normalize
  // backward-compat shapes without changing.
  return NextResponse.json({
    comments: rows.map((c) => ({
      id: c.id,
      body: c.body,
      author: c.author,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      resolvedAt: c.resolvedAt,
      anchorType: c.anchorType,
      anchorData: c.anchor,
    })),
  });
}

export async function POST(req: Request) {
  const body = await req.json();
  const { project, task = "", path: file, anchorType, anchor, body: text, author } = body ?? {};
  if (!project || !file || !text || !anchorType) {
    return NextResponse.json({ error: "project, path, anchorType, body required" }, { status: 400 });
  }
  if (anchorType !== "md" && anchorType !== "html") {
    return NextResponse.json({ error: "anchorType must be md or html" }, { status: 400 });
  }
  const created = await addComment(project, task, {
    filePath: file,
    anchorType,
    anchor: anchor ?? {},
    body: text,
    author: author || "marco",
  });
  return NextResponse.json({
    comment: {
      id: created.id,
      body: created.body,
      author: created.author,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      resolvedAt: created.resolvedAt,
      anchorType: created.anchorType,
      anchorData: created.anchor,
    },
  });
}
