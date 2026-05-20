import { NextResponse } from "next/server";
import { resolvePermission } from "@/lib/sessions";

export const runtime = "nodejs";

// Resolve a tool-use approval the agent's `canUseTool` callback is awaiting.
// Body shape:
//   { toolUseId: string,
//     behavior: "allow" | "deny",
//     message?: string,           // deny reason / guidance for the model
//     updatedInput?: object }     // allow with edits to the tool input
//
// Today the only tool we gate through this is ExitPlanMode — the agent
// finishes a plan and the UI shows an Approve/Deny card. On Approve the SDK
// transitions out of plan mode and the agent starts executing.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json() as {
    toolUseId?: string;
    behavior?: "allow" | "deny";
    message?: string;
    updatedInput?: Record<string, unknown>;
  };

  if (!body.toolUseId || (body.behavior !== "allow" && body.behavior !== "deny")) {
    return NextResponse.json(
      { error: "body must include `toolUseId` and `behavior` ('allow' | 'deny')" },
      { status: 400 },
    );
  }

  const result = body.behavior === "allow"
    ? { behavior: "allow" as const, updatedInput: body.updatedInput ?? {} }
    : { behavior: "deny" as const, message: body.message ?? "User denied.", interrupt: false };

  const ok = resolvePermission(id, body.toolUseId, result);
  if (!ok) {
    return NextResponse.json(
      { error: "no pending permission for that toolUseId (already resolved, session not in memory, or wrong id)" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
