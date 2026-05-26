#!/bin/bash
set -e

# Initial framebuffer size. The client (embed.html, with resizeSession=true)
# can resize to any dimensions at runtime — Xvnc supports that natively via
# SetDesktopSize; there's no max-mode envelope to pre-allocate.
VIEWPORT_WIDTH="${VIEWPORT_WIDTH:-1280}"
VIEWPORT_HEIGHT="${VIEWPORT_HEIGHT:-800}"

# Clear any stale Chrome singleton lock (a previous container died uncleanly)
rm -f /profile/Singleton* 2>/dev/null || true

# Symlink Chrome's downloadable component caches from /opt/chrome-shared,
# which the MCP server bind-mounts (read-write) from SHARED_COMPONENTS_DIR
# on the host. The MCP pre-creates each subdir before spawning so the symlink
# always has a real target. Chrome reads / writes through the symlink:
#   - First session on a fresh host populates the dirs as component_updater
#     fires (~30–60s after browser start)
#   - Every subsequent session in any profile sees them already populated
#   - Updates Chrome writes propagate to every future session
#
# We only create symlinks for dirs that don't already exist in /profile
# (in case a prior session ever wrote a real subdir of one of these names).
# EXCLUDE_NAMES in src/profile-store.ts filters all these dirs out of the
# persisted profile so /opt/chrome-shared is always the source of truth.
if [ -d /opt/chrome-shared ]; then
  for src in /opt/chrome-shared/*; do
    [ -d "$src" ] || continue
    name=$(basename "$src")
    if [ ! -e "/profile/$name" ]; then
      ln -s "$src" "/profile/$name"
    fi
  done
fi

# Xvnc (TigerVNC's standalone X server) instead of Xvfb + x11vnc. Xvnc
# accepts arbitrary client-driven resize via the RFB SetDesktopSize /
# ExtendedDesktopSize extensions out of the box — no pre-defined RANDR modes,
# no x11vnc xrandr dance. When the embed.html client resizes, Xvnc resizes
# its framebuffer to those exact pixels; fluxbox then re-maximizes the
# chromium window; the page re-layouts at the new size.
#
# -SecurityTypes None : no auth (we only bind on localhost via websockify).
# -AlwaysShared       : multiple clients can attach (debug + agent + human).
# -DisconnectClients=0: don't kick existing clients on new connections.
Xvnc :99 \
  -SecurityTypes None \
  -rfbport 5900 \
  -geometry "${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}" \
  -depth 24 \
  -AlwaysShared \
  -DisconnectClients=0 \
  >/dev/null 2>&1 &
XVNC_PID=$!

# Wait for X server to be up
for i in $(seq 1 30); do
  if xdpyinfo -display :99 >/dev/null 2>&1; then break; fi
  sleep 0.1
done

# Fluxbox — a minimal window manager. Needed so chromium's --start-maximized
# actually fills the screen, and so the chrome window re-maximizes when the
# Xvnc framebuffer is resized (a WM-less X just leaves windows where they
# are at their original pixel size).
#
# Pre-seed the fluxbox config dir so it skips its first-run welcome (which
# launches xmessage and floats on top of chrome) and so every window opens
# undecorated + maximized — we want the chromium window edge-to-edge with no
# fluxbox titlebar stealing the top 39px.
mkdir -p /root/.fluxbox
: > /root/.fluxbox/keys
: > /root/.fluxbox/menu
: > /root/.fluxbox/startup
# Disable fluxbox's wallpaper restorer (fbsetbg). It hunts for a helper tool
# (Esetroot/feh/hsetroot/…); finding none, it pops up an xmessage error
# ("fbsetbg: I can't find an app…") that floats over chrome. rootCommand:true
# is a no-op stand-in: fluxbox runs `true` instead of fbsetbg. We don't need a
# wallpaper — chrome fills the screen.
cat > /root/.fluxbox/init <<'EOF'
session.screen0.rootCommand: true
session.screen0.toolbar.visible: false
session.screen0.slit.placement: TopLeft
session.screen0.slit.autoHide: true
EOF
cat > /root/.fluxbox/apps <<'EOF'
[app] (.*)
  [Deco] {NONE}
  [Maximized] {yes}
[end]
EOF
DISPLAY=:99 fluxbox >/dev/null 2>&1 &
WM_PID=$!

# Kill the giant xmessage "welcome" popup fluxbox throws up. It can appear
# at first run AND after later screen-resize events (fluxbox re-displays it),
# so we keep a forever-watcher rather than a bounded boot-time killer —
# whenever an xmessage window exists, kill it.
( while true; do
    DISPLAY=:99 pkill -x xmessage 2>/dev/null || true
    sleep 1
  done ) &
XMSG_KILLER_PID=$!

# noVNC websocket bridge → browser-accessible at http://host:6080/.
# /usr/share/novnc/embed.html is our minimal client (see browser/embed.html).
websockify --web=/usr/share/novnc 6080 localhost:5900 &
NOVNC_PID=$!

# Chromium v108+ silently binds CDP to 127.0.0.1 only, ignoring
# --remote-debugging-address. socat forwards container-external 9223 to it.
# Started in the background: it'll retry until chromium binds 9222.
(
  until curl -sf http://127.0.0.1:9222/json/version >/dev/null 2>&1; do sleep 0.1; done
  exec socat -d tcp-listen:9223,fork,reuseaddr tcp:127.0.0.1:9222
) &
SOCAT_PID=$!

# Chrome window sizing is delegated to fluxbox (see the apps config above:
# [Maximized] {yes} for every window). Fluxbox keeps chrome maximized at boot
# and re-maximizes it on RANDR resize events when Xvnc grows the framebuffer
# — so the chrome window tracks the screen with no extra polling. Earlier
# versions of this script polled with wmctrl + unmaximize/resize on every
# screen change; that fought with fluxbox's own re-maximize and destabilized
# chrome's renderer (tabs vanished after ~30s of resize traffic).

# Graceful shutdown — when this script exits, kill the auxiliaries
cleanup() {
  kill -TERM "$XMSG_KILLER_PID" "$SOCAT_PID" "$NOVNC_PID" "$WM_PID" "$XVNC_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Run chromium as PID 1 (well, child of tini) so docker stop signals reach it.
#
# --test-type suppresses the yellow "You are using an unsupported command-line
# flag: --no-sandbox" infobar that otherwise covers the top of the viewport.
# Trade-off: a few anti-bot heuristics can detect the test-type marker. If a
# target site flakes on that, the cleaner long-term fix is to run chromium as
# a non-root user (in which case --no-sandbox stops being necessary).
#
# --start-maximized + fluxbox makes chrome fill the current screen; when the
# Xvnc framebuffer later resizes (client-requested via embed.html), fluxbox
# re-maximizes the chrome window so the page re-layouts at the new size.
exec chromium \
  --no-sandbox \
  --test-type \
  --disable-gpu \
  --disable-dev-shm-usage \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --user-data-dir=/profile \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=Translate \
  --start-maximized \
  "about:blank"
