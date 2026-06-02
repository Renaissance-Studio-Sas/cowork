// Workbench tools for session management. Runtime-agnostic — they rename the
// session, open artifacts, and park completion suggestions.
//
// The local Chrome-bridge tools (chrome_connect / chrome_open_profile / …) were
// removed: browser automation now runs entirely in the cloud browser
// (cloud-browser MCP, registered in src/lib/claude-chrome-tools.ts). There is no
// longer a local native-messaging bridge.

import { z } from "zod";
import { renameLiveSession, getSession, addPendingCompletion } from "../sessions";
import { defineTool, type WorkbenchTool } from "./types";

export function buildSessionTools(
  sessionId: string,
  _workspacePath: string[],
): WorkbenchTool[] {
  return [
    defineTool(
      "set_session_title",
      `Override the session title shown in the cowork sidebar. The workbench
auto-titles each session from turn 1, so you usually do nothing — call this
only when you want a different title than the auto-generated one (e.g. the
focus of the session shifted, or the auto-title misses the point).`,
      { title: z.string().min(1).max(60).describe("Short descriptive title (3-6 words)") },
      async ({ title }) => {
        const ok = await renameLiveSession(sessionId, title);
        if (!ok) {
          return {
            content: [{ type: "text", text: "Failed to set session title (session not found)." }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: `Session title set to: "${title}"` }] };
      },
      { alwaysLoad: true },
    ),

    defineTool(
      "open_artifact",
      `Open a file artifact in the user's artifact panel — switches the preview
to the named file so the user sees it right now without clicking. Use after
saving a file you want the user to look at immediately (a freshly-generated
report, a live-view page, a screenshot they should review). Quiet no-op if
the user isn't viewing this session's workspace.`,
      {
        path: z
          .string()
          .min(1)
          .describe(
            `Artifact path relative to the task's files/ directory, e.g. "browser-foo.html" or "reports/summary.md".`,
          ),
      },
      async ({ path: artifactPath }) => {
        const s = getSession(sessionId);
        if (!s) {
          return {
            content: [{ type: "text", text: `Session ${sessionId} not found.` }],
            isError: true,
          };
        }
        s.events.emit("open_artifact", { path: artifactPath });
        return { content: [{ type: "text", text: `Opened "${artifactPath}" in the artifact panel.` }] };
      },
    ),

    defineTool(
      "suggest_session_complete",
      `Suggest that this session is complete and the work is done. The UI surfaces
an Approve / Dismiss card to the human — the tool waits for their decision and
returns either "approved" (session is now marked complete in the workspace) or
"dismissed" (continue working). Call this when you're confident the task is
finished; the human stays in control of the final mark. If the human later
sends another message, the completion is cleared automatically.`,
      {
        reason: z.string().max(200).optional().describe(
          "Optional one-line summary of what was accomplished (shown to the human in the approval card).",
        ),
      },
      async ({ reason }) => {
        const parked = addPendingCompletion(sessionId, reason);
        if (!parked) {
          return {
            content: [{ type: "text", text: "Failed to park completion suggestion (session not found)." }],
            isError: true,
          };
        }
        const approved = await parked.promise;
        return {
          content: [{
            type: "text",
            text: approved
              ? "Session marked complete by the human. Stop here unless they send more work."
              : "Human dismissed the completion suggestion — keep working.",
          }],
        };
      },
      { alwaysLoad: true },
    ),
  ];
}
