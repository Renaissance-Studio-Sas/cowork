#!/bin/sh
# Container entrypoint. Installs the rowads CLI from the bind-mounted workspace
# (so `rowads ...` works inside the agent), then starts the session manager.
#
# Required env (set by the controller via docker run -e):
#   RUNNER_TOKEN          bearer token cowork must send on every request
#   ANTHROPIC_API_KEY     or other auth that the Claude Agent SDK consults
# Optional:
#   PORT                  default 8080
#   IDLE_TIMEOUT_MS       default 900000 (15 min)

set -eu

WORKSPACE=${WORKSPACE_DIR:-/workspace}
export PATH="$HOME/.local/bin:$PATH"

# Optional: install the rowads CLI from the bind-mounted workspace so the
# agent can call `rowads`. Heavy deps (pyannote.audio, playwright) take
# minutes to compile, so we run it detached in the background — the agent
# can still launch immediately and rowads becomes available once it lands.
# Skip entirely if INSTALL_ROWADS=0.
if [ -d "$WORKSPACE" ] && [ -f "$WORKSPACE/pyproject.toml" ] \
   && [ "${INSTALL_ROWADS:-1}" = "1" ]; then
  (
    pip3 install --quiet --user --break-system-packages -e "$WORKSPACE" \
      >/tmp/pip-install.log 2>&1 \
      && echo "[entrypoint] rowads CLI installed" \
      || echo "[entrypoint] rowads install failed (see /tmp/pip-install.log)"
  ) &
fi

# nodemon restarts the runner process whenever a file under /opt/runner/src
# changes. We use nodemon (not `node --watch`) because Docker for Mac's
# bind-mount doesn't propagate fsnotify events from the host — Node's
# built-in watcher silently misses every edit. nodemon with -L (legacy
# polling) reliably picks up host edits via mtime polling. The downside is
# the in-flight session (and any auth subprocess) gets killed on each save
# — fine for dev, turn off via DEV_WATCH=0 to freeze the process during a
# long session.
if [ "${DEV_WATCH:-1}" = "1" ]; then
  exec /opt/runner/node_modules/.bin/nodemon -L --watch /opt/runner/src \
    /opt/runner/src/server.mjs
else
  exec node /opt/runner/src/server.mjs
fi
