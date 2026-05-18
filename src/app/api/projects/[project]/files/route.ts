import { NextResponse } from "next/server";
import { listProjectFiles } from "@/lib/fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ project: string }> }) {
  const { project } = await ctx.params;
  const files = await listProjectFiles(project);
  return NextResponse.json({ files });
}
