import { NextResponse } from "next/server";
import { startPreview, previewLogs, stopPreviewApp, isPreviewAlive, PreviewError } from "@/lib/preview/manager";
import { setPreviewSession, getPreviewSession, clearPreviewSession } from "@/lib/preview/preview-session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROD_BASE = process.env.ROWADS_GATEWAY_URL ?? "https://app.rowads.studio";

// Current inline preview for a session + whether it's still alive + recent logs.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const preview = getPreviewSession(id);
  // Remote (prod/preview URL) previews have no local process — always "alive".
  const alive = preview ? (preview.remote || isPreviewAlive(preview.app)) : false;
  const logs = preview && !preview.remote ? previewLogs(preview.app, 150) : [];
  return NextResponse.json({ preview, alive, logs });
}

// Start (or bind) a preview for `app`. `target`: "local" (default, spawns
// `rw worker dev`), "prod" (embeds the deployed app), or a full URL.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { app?: string; target?: string };
  if (!body.app || typeof body.app !== "string") {
    return NextResponse.json({ error: "app required" }, { status: 400 });
  }
  const target = (body.target ?? "local").trim();
  try {
    if (target === "local") {
      const r = await startPreview(body.app, id);
      setPreviewSession(id, r.app, r.url, false);
      return NextResponse.json({ ok: true, preview: { ...r, remote: false } });
    }
    // Remote: prod keyword → gateway/<app>; otherwise treat target as a URL.
    const url = target === "prod" ? `${PROD_BASE}/${body.app}` : target;
    if (!/^https?:\/\//.test(url)) {
      return NextResponse.json({ error: `target must be "local", "prod", or a full http(s) URL (got "${target}")` }, { status: 400 });
    }
    setPreviewSession(id, body.app, url, true);
    return NextResponse.json({ ok: true, preview: { app: body.app, url, remote: true } });
  } catch (e) {
    const msg = e instanceof PreviewError ? e.message : e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// Stop this session's preview (optionally a specific local app outright).
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const app = new URL(req.url).searchParams.get("app");
  if (app) stopPreviewApp(app);
  clearPreviewSession(id);
  return NextResponse.json({ ok: true });
}
