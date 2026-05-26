# Pin platform to linux/amd64 — Google Chrome for Linux ships amd64 only
# (no native arm64 build), and the production target (Cloudflare) is amd64.
# On Apple Silicon, Docker Desktop runs this under Rosetta 2 — small perf hit
# but dev and prod stay on the same architecture.
FROM --platform=linux/amd64 debian:bookworm-slim

# Base packages: VNC + window manager + fonts + utilities + keyring.
# gnome-keyring + libsecret-1-0 + dbus-x11 let Chrome use --password-store=
# gnome-libsecret so cookies are encrypted with a key in the keyring (rather
# than Chrome's "basic" fallback that uses a hardcoded key embedded in the
# binary). The keyring DB persists with the profile (see XDG_DATA_HOME in
# entrypoint.sh) so encrypted state survives across container restarts.
RUN apt-get update && apt-get install -y --no-install-recommends \
    tigervnc-standalone-server \
    novnc \
    websockify \
    fluxbox \
    wmctrl \
    x11-xserver-utils \
    fonts-liberation \
    fonts-noto \
    fonts-noto-color-emoji \
    fonts-noto-cjk \
    dbus \
    dbus-x11 \
    gnome-keyring \
    libsecret-1-0 \
    procps \
    tini \
    socat \
    curl \
    wget \
    gnupg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Google Chrome stable. Add Google's signing key + apt repo, then install.
RUN wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# noVNC convenience: serve vnc.html at /
RUN ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html

# fluxbox runs fbsetbg every time the screen resizes (not just at startup),
# to restore the wallpaper. Without one of its helper image-loaders installed
# (Esetroot/feh/hsetroot/…) it pops up an xmessage error each time, briefly
# visible during every panel resize. We don't want a wallpaper anyway, so
# replace fbsetbg with /bin/true and the call is a silent no-op forever.
RUN ln -sf /bin/true /usr/bin/fbsetbg

# Custom minimal noVNC client (just the canvas, no control bar) — served from
# the same webroot so it can import noVNC's core/rfb.js as a same-origin ESM.
COPY embed.html /usr/share/novnc/embed.html

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Profile dir lives at /profile; bind-mounted by the MCP server
RUN mkdir -p /profile

ENV DISPLAY=:99
# 9223 = host-facing CDP (socat → 127.0.0.1:9222, where chrome binds since
# v108 silently refuses 0.0.0.0 even with --remote-debugging-address). 6080 = noVNC.
EXPOSE 9223 6080

# tini reaps zombies (chrome spawns many)
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
