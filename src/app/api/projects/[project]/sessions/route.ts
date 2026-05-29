import { NextResponse } from "next/server";
import { startProjectSession } from "@/lib/sessions";

export const runtime = "nodejs";

// Project-level session — runs with cwd = the project folder. No task slug.
export async function POST(req: Request, ctx: { params: Promise<{ project: string }> }) {
  const { project } = await ctx.params;
  const body = await req.json();
  if (!body.message || typeof body.message !== "string") {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }
  try {
    const s = await startProjectSession({
      projectSlug: project,
      firstMessage: body.message,
      permissionMode: body.permissionMode,
      model: body.model,
      effort: body.effort,
      runtime: body.runtime,
      openArtifact: typeof body.openArtifact === "string" && body.openArtifact.length > 0 ? body.openArtifact : undefined,
    });
    return NextResponse.json({ id: s.id, state: s.state });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
