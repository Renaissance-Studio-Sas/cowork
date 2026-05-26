FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-l10n \
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
    procps \
    tini \
    socat \
    curl \
    ca-certificates \
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
# 9223 = host-facing CDP (socat → 127.0.0.1:9222, where chromium binds since
# v108 silently refuses 0.0.0.0 even with --remote-debugging-address). 6080 = noVNC.
EXPOSE 9223 6080

# tini reaps zombies (chromium spawns many)
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
