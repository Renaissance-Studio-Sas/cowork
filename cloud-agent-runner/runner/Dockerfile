# Runner image — one container per cowork session. The cowork "remote" runtime
# drives this over HTTP and consumes events via SSE. Workspace is bind-mounted
# at runtime (no R2 in MVP).
#
# Build:
#   docker build -t rowads-agent-runner:latest -f runner/Dockerfile runner/
# Run:
#   docker run --rm \
#     -e RUNNER_TOKEN=$(openssl rand -hex 16) \
#     -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
#     -v ~/git/rowads-automation:/workspace \
#     -v ~/.rowads-agent/marco/home:/root \
#     -p 8080:8080 \
#     rowads-agent-runner:latest

FROM node:20-bookworm-slim

# Python (for the rowads CLI), git, tini for clean PID 1, ca-certs for HTTPS.
# build-essential + python (for node-pty native build during npm install).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
      git tini ca-certificates curl \
      build-essential \
 && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally — the Agent SDK spawns it as a
# subprocess via $pathToClaudeCodeExecutable; without it, query() exits 1.
RUN npm install -g --omit=optional --no-audit --no-fund @anthropic-ai/claude-code

WORKDIR /opt/runner
COPY package.json package.json
# No lockfile yet — install from package.json at build. SDK is the only dep.
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Non-root user is required: claude-code refuses to run with
# `--dangerously-skip-permissions` (what bypassPermissions translates to)
# under root. Same fixed UID/GID across hosts keeps bind-mounted files'
# ownership stable.
RUN groupadd --gid 1001 agent && useradd --uid 1001 --gid 1001 --home-dir /home/agent --create-home agent

ENV PORT=8080 \
    NODE_ENV=production \
    HOME=/home/agent \
    PYTHONUNBUFFERED=1

USER agent
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
