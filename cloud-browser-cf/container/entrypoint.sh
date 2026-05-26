#!/bin/bash
# Boot the headful display + Chromium (CDP on 9223 via socat) + noVNC, then the
# Node agent.
set -e

W="${VIEWPORT_WIDTH:-1280}"; H="${VIEWPORT_HEIGHT:-800}"
rm -f /profile/Singleton* 2>/dev/null || true

Xvnc :99 -SecurityTypes None -rfbport 5900 -geometry "${W}x${H}" -depth 24 -AlwaysShared -DisconnectClients=0 >/dev/null 2>&1 &
for i in $(seq 1 30); do xdpyinfo -display :99 >/dev/null 2>&1 && break; sleep 0.1; done

mkdir -p /root/.fluxbox
printf 'session.screen0.rootCommand: true\nsession.screen0.toolbar.visible: false\n' > /root/.fluxbox/init
printf '[app] (.*)\n  [Deco] {NONE}\n  [Maximized] {yes}\n[end]\n' > /root/.fluxbox/apps
DISPLAY=:99 fluxbox >/dev/null 2>&1 &
( while true; do DISPLAY=:99 pkill -x xmessage 2>/dev/null || true; sleep 1; done ) &

websockify --web=/usr/share/novnc 6080 localhost:5900 &

# socat: external 9223 → chromium's localhost-only 9222 (Chromium v108+ ignores --remote-debugging-address)
( until curl -sf http://127.0.0.1:9222/json/version >/dev/null 2>&1; do sleep 0.1; done; exec socat -d tcp-listen:9223,fork,reuseaddr tcp:127.0.0.1:9222 ) &

# The Node agent (drives Chrome over localhost CDP; serves ops on :8080)
( cd /agent && node agent.mjs ) &

exec chromium \
  --no-sandbox --test-type --disable-gpu --disable-dev-shm-usage \
  --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 \
  --user-data-dir=/profile --no-first-run --no-default-browser-check \
  --disable-features=Translate --start-maximized "about:blank"
