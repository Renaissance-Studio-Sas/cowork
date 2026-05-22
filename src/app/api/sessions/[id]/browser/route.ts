import { NextResponse } from "next/server";
import { tabsInfo } from "@/lib/browser/playwright-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Live tab list for the session's bound browser (index, url, title) plus which
// tab the agent is currently operating on. Used by the live-view panel's tab
// strip. Returns an empty list when no browser is bound.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const info = await tabsInfo(id);
  return NextResponse.json(info ?? { activeIndex: -1, tabs: [] });
}
