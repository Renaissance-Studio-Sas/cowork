import { NextResponse } from "next/server";
import { createProject } from "@/lib/fs";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json();
  if (!body.slug || typeof body.slug !== "string") {
    return NextResponse.json({ error: "slug required" }, { status: 400 });
  }
  const project = await createProject(body.slug, body.description ?? "");
  return NextResponse.json(project);
}
