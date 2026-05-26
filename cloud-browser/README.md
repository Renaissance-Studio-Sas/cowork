# cloud-browser

MCP server that gives Claude clients access to persistent-profile Chromium browsers running in Docker.

See [DESIGN.md](./DESIGN.md) for the full design.

## Prerequisites

- Docker Desktop running
- Node 20+
- (Optional) Cloudflare R2 bucket + credentials for cloud profile persistence

## Setup

```bash
npm install
npm run docker:build         # builds cloud-browser/chromium:latest (~500MB)
cp .env.example .env         # local backend works out-of-the-box; fill in R2 creds for cloud storage
```

## Profile persistence

Two backends; chosen automatically by env:

| Backend | When | Layout |
|---|---|---|
| **Local folder** (default) | `R2_BUCKET` unset (or `SKIP_R2=true`) | `~/.cloud-browser/store/<profile>/` — browsable userDataDir tree |
| **R2** | `R2_BUCKET` + creds set | `s3://<bucket>/<profile>/profile.tar.gz` |

On release, only login-relevant state persists: cookies (SQLite), Local Storage, IndexedDB, Login Data, Preferences, etc. Throwaway caches (`Cache/`, `Code Cache/`, `GPUCache/`, `ShaderCache/`, `Crashpad/`, Dawn*, Singleton*) are filtered out — same exclusion list for both backends.

Each session still gets its own ephemeral per-session `userDataDir` under `~/.cloud-browser/profiles/<profile>-<sessionId>/` (mounted into Chromium). The persistent baseline is copied in on acquire and saved back out on release.

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
