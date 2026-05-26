# cloud-browser

MCP server that gives Claude clients access to persistent-profile Chromium browsers running in Docker.

See [DESIGN.md](./DESIGN.md) for the full design.

## Prerequisites

- Docker Desktop running
- Node 20+
- (Optional) Cloudflare R2 bucket + credentials for profile persistence

## Setup

```bash
npm install
npm run docker:build         # builds cloud-browser/chromium:latest (~500MB)
cp .env.example .env         # fill in R2 creds, or set SKIP_R2=true for local-only
```

## Run

```bash
npm run dev                  # stdio MCP server, hot-reloaded via tsx
```

For Claude Desktop / Claude Code, wire it as a stdio MCP:

```json
{
  "mcpServers": {
    "cloud-browser": {
      "command": "node",
      "args": ["/absolute/path/to/cowork/cloud-browser/dist/index.js"],
      "env": {
        "R2_BUCKET": "browser-profiles-marco",
        "R2_ACCOUNT_ID": "...",
        "R2_ACCESS_KEY_ID": "...",
        "R2_SECRET_ACCESS_KEY": "..."
      }
    }
  }
}
```

## Tools (19)

See [DESIGN.md](./DESIGN.md) for the full surface.
