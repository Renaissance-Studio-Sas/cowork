import { retrySession } from "@/lib/sessions";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const success = await retrySession(id);
  if (!success) {
    return new Response("Session not found or not in error state", { status: 404 });
  }
  return Response.json({ success: true });
}
