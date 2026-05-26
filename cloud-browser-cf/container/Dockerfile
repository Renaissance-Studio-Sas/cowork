# Chromium + headful display (Xvnc/noVNC) + a Node "agent" that drives Chrome
# over localhost CDP and exposes high-level browser ops as HTTP. The Worker/DO
# proxies tool calls + the live view to this container; CDP never leaves it.
# linux/amd64 (Cloudflare Containers requirement).
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium chromium-l10n \
    tigervnc-standalone-server novnc websockify fluxbox \
    x11-xserver-utils fonts-liberation fonts-noto fonts-noto-color-emoji \
    dbus dbus-x11 procps tini socat curl ca-certificates tar gzip \
    nodejs npm \
  && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html \
  && ln -sf /bin/true /usr/bin/fbsetbg
# (Optional) drop in a custom embed.html for a chrome-less noVNC viewer.

WORKDIR /agent
COPY agent/package.json agent/package-lock.json* ./
RUN npm install --omit=dev
COPY agent/agent.mjs ./

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /profile

ENV DISPLAY=:99
# 8080 = agent HTTP (Worker proxies here). 6080 = noVNC live view. 9223 = CDP (internal).
EXPOSE 8080 6080
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
