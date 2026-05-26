// Live-view artifacts.
//
// This MCP can't write to the host's filesystem itself (it's a generic stdio
// server with no knowledge of the host's workspace). Instead, on session
// acquire it hands the agent a ready-to-save HTML page that embeds the
// session's noVNC display in an iframe, and asks the agent to save it as a
// file artifact. Hosts that surface saved files to the user (e.g. cowork's
// Artifacts panel) then render it — the user can watch and drive the browser.
// On release the agent is asked to delete it. No host-specific protocol: it's
// just an HTML file the agent writes and removes with its normal file tools.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Stable per-profile artifact filename. */
export function artifactPath(profile: string): string {
  return `browser-${profile}.html`;
}

// A minimal HTML page that frames the noVNC display full-bleed, with a small
// header linking to the same URL in a standalone tab.
//
// The embedded iframe loads our custom `embed.html` (just a canvas wired up
// with RFB.js — no control bar, no status strip, no "Send Ctrl-Alt-Del"
// button). RFB.js is configured with `resizeSession = true`, so when the
// iframe resizes the page asks x11vnc to resize Xvfb (xrandr) → fluxbox
// resizes the maximized chrome window → the website re-layouts at the new
// pixel size. True server-side resize, not a stretched bitmap.
//
// The "open in new tab" link keeps `vnc.html` so the user gets the full
// noVNC UI when they pop it out (settings, keyboard remapping, etc).
function liveViewHtml(profile: string, novncUrl: string): string {
  const p = escapeHtml(profile);
  const fullUrl = escapeHtml(novncUrl);
  // Swap vnc.html for our custom embed.html (served by websockify from the
  // same noVNC origin). embed.html is a bare canvas wired up with RFB.js —
  // no control bar, no status strip, no "Send Ctrl-Alt-Del" button — so the
  // iframe shows nothing but the live browser, no cropping needed.
  const embedUrl = escapeHtml(novncUrl.replace(/\/vnc\.html(\?.*)?$/, "/embed.html"));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Live browser — ${p}</title>
<style>
  html, body { margin: 0; height: 100%; background: #1e1e1e; font-family: system-ui, sans-serif; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; color: #ddd; font-size: 13px; background: #2b2b2b; border-bottom: 1px solid #000; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; box-shadow: 0 0 6px #3fb950; }
  .bar a { color: #58a6ff; text-decoration: none; margin-left: auto; }
  .bar a:hover { text-decoration: underline; }
  .frame-wrap { flex: 1; min-height: 0; background: #000; }
  iframe { width: 100%; height: 100%; border: 0; display: block; background: #000; }
</style>
</head>
<body style="display:flex;flex-direction:column;height:100%">
  <div class="bar">
    <span class="dot"></span>
    <span>Live browser · profile <b>${p}</b></span>
    <a href="${fullUrl}" target="_blank" rel="noopener">open in new tab ↗</a>
  </div>
  <div class="frame-wrap">
    <iframe src="${embedUrl}" allow="clipboard-read; clipboard-write"></iframe>
  </div>
</body>
</html>`;
}

/**
 * Instruction (appended to the acquire tool result) asking the agent to save
 * the live-view page as a file artifact and surface it to the user. Includes
 * the full HTML so the agent can write it verbatim.
 */
export function saveArtifactInstruction(profile: string, novncUrl: string): string {
  const file = artifactPath(profile);
  return (
    `\n\nTo let the user watch and drive this browser, save the HTML below as a ` +
    `file artifact in this task (write it to the task's files/ directory as ` +
    `"${file}") and then call the workbench tool ` +
    `\`mcp__workbench-session__open_artifact\` with \`path: "${file}"\` so it ` +
    `opens in the user's artifact panel right away. Delete "${file}" when you ` +
    `release this profile.\n\n` +
    "```html\n" +
    liveViewHtml(profile, novncUrl) +
    "\n```"
  );
}

/**
 * Instruction (appended to the release tool result) asking the agent to remove
 * the live-view artifact it created for this profile.
 */
export function deleteArtifactInstruction(profile: string): string {
  const file = artifactPath(profile);
  return (
    `\n\nThe live view for this profile is no longer available — if you saved ` +
    `the artifact "${file}" for it, delete that file now.`
  );
}
