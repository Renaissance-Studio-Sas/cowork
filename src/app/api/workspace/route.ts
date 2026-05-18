import { NextResponse } from "next/server";
import { listProjects, ensureWorkspace } from "@/lib/fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await ensureWorkspace();
  const projects = await listProjects();
  return NextResponse.json({ projects });
}
