// workbench-preview tools: run a rowads monorepo app's dev server (`rw worker
// dev`) and show it live, inline in the chat via an iframe. Use these to give
// the user a working, hot-reloading preview of the app you're building.

import { z } from "zod";
import {
  startPreview,
  stopPreviewApp,
  previewLogs,
  getPreviewByApp,
  localApiCaveat,
  PreviewError,
} from "../preview/manager";

const PROD_BASE = process.env.ROWADS_GATEWAY_URL ?? "https://app.rowads.studio";
import {
  setPreviewSession,
  getPreviewSession,
  clearPreviewSession,
} from "../preview/preview-session-store";
import { defineTool, type WorkbenchTool, type ToolCallResult } from "./types";

function errText(msg: string): ToolCallResult {
  return { content: [{ type: "text", text: msg }], isError: true };
}
function okText(msg: string): ToolCallResult {
  return { content: [{ type: "text", text: msg }] };
}

export function buildPreviewTools(
  sessionId: string,
  _projectSlug: string,
  _taskSlug: string,
): WorkbenchTool[] {
  return [
    defineTool(
      "preview_app",
      `Show a rowads monorepo app inline in this chat via an iframe.

target (where to run it):
- "local" (default): start a local dev server via \`rw worker dev\` — assigns a
  port, injects auth, wires /api, hot-reloads as you edit. Best for seeing your
  in-progress changes. Note: some apps' dev servers 404 on gateway-only routes
  (e.g. /api/storage), so media/assets may not load locally.
- "prod": embed the deployed app at ${PROD_BASE}/<app>. Fully real data, no
  spawn. Caveat: inside the iframe it may render logged-out (cross-site cookie),
  so use the panel's "Open ↗" for an authenticated view.
- a full https URL: embed that (e.g. a preview deployment).

IMPORTANT: if the user hasn't said WHERE to run it (local vs prod/deployed),
ASK them first (AskUserQuestion) before calling this — don't assume.

Pass the app's directory name under monorepo/apps/ (e.g. "billing").`,
      {
        app: z.string().describe('App directory name under monorepo/apps/, e.g. "billing"'),
        target: z.string().optional().describe('"local" (default), "prod", or a full https URL'),
      },
      async ({ app, target }) => {
        const t = (target ?? "local").trim();
        try {
          if (t === "local") {
            const r = await startPreview(app, sessionId);
            setPreviewSession(sessionId, r.app, r.url, false);
            const caveat = localApiCaveat(app);
            return okText(
              `Local preview running for "${r.app}" at ${r.url} (status: ${r.status}).\n`
              + `Shown inline — open the Preview panel (header toggle). Live edits hot-reload. If it errors or looks blank, call preview_logs.`
              + (caveat ? `\n\n⚠ ${caveat}` : ""),
            );
          }
          const url = t === "prod" ? `${PROD_BASE}/${app}` : t;
          if (!/^https?:\/\//.test(url)) {
            return errText(`target must be "local", "prod", or a full http(s) URL (got "${t}").`);
          }
          setPreviewSession(sessionId, app, url, true);
          return okText(
            `Showing "${app}" from ${url} (deployed).\n`
            + `Shown inline — open the Preview panel. Note: it may render logged-out inside the iframe (cross-site cookies); use "Open ↗" for an authenticated view.`,
          );
        } catch (e) {
          if (e instanceof PreviewError) return errText(e.message);
          return errText(`Preview error: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),

    defineTool(
      "preview_status",
      `Report the current inline preview for this session (app + URL + status),
if any. Use to check whether a preview is already running before starting one.`,
      {},
      async () => {
        const bound = getPreviewSession(sessionId);
        if (!bound) return okText("No app is being previewed in this session. Start one with preview_app.");
        if (bound.remote) return okText(`Previewing "${bound.app}" from ${bound.url} (deployed/remote).`);
        const live = getPreviewByApp(bound.app);
        return okText(`Previewing "${bound.app}" at ${bound.url} (local dev, status: ${live?.status ?? "stopped"}).`);
      },
    ),

    defineTool(
      "preview_logs",
      `Read recent dev-server output (build/runtime errors, request logs) for a
preview. Defaults to this session's app. Use this to diagnose why a preview is
blank, erroring, or not authenticated.`,
      {
        app: z.string().optional().describe("App name; defaults to this session's previewed app"),
        tail: z.number().optional().describe("How many recent lines (default 80)"),
      },
      async ({ app, tail }) => {
        const target = app ?? getPreviewSession(sessionId)?.app;
        if (!target) return errText("No app specified and none is being previewed. Start one with preview_app first.");
        const lines = previewLogs(target, tail ?? 80);
        if (lines.length === 0) return okText(`No logs for "${target}" (not running, or no output yet).`);
        return okText(`Dev-server logs for "${target}" (last ${lines.length} lines):\n${lines.join("\n")}`);
      },
    ),

    defineTool(
      "stop_preview",
      `Stop the inline preview. Without an app, stops this session's preview;
with an app, stops that app's dev server outright.`,
      { app: z.string().optional().describe("App to stop; defaults to this session's preview") },
      async ({ app }) => {
        if (app) {
          const stopped = stopPreviewApp(app);
          if (getPreviewSession(sessionId)?.app === app) clearPreviewSession(sessionId);
          return okText(stopped ? `Stopped dev server for "${app}".` : `No dev server was running for "${app}".`);
        }
        const bound = getPreviewSession(sessionId);
        if (!bound) return okText("No preview to stop in this session.");
        clearPreviewSession(sessionId);
        return okText(`Stopped previewing "${bound.app}".`);
      },
    ),
  ];
}
