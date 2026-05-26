# cloud-browser

MCP server that gives Claude clients access to Chromium browsers running in
Cloudflare. The daemon stays on the developer machine and proxies tools onto
remote containers via the platform gateway at `/api/browser/*`.

See [DESIGN.md](./DESIGN.md) for the full design.

## Prerequisites

- Node 20+
- `rw auth login` — the daemon authenticates with the gateway via the
  session cookie in `~/.rw/credentials.json`

No local Docker, no local Chrome image — the container lives in Cloudflare.

## Setup

```bash
npm install
cp .env.example .env  # all defaults are usually fine
```

## Run

```bash
npm run dev    # HTTP MCP server on 127.0.0.1:7400, hot-reloaded via tsx
npm start      # HTTP MCP server, compiled (node dist/index.js)
curl http://127.0.0.1:7400/health
```

The server is a **shared daemon**: one instance per machine. If a second
instance is started while one is already running, it exits silently
(port-bind detection + PID file). The daemon survives cowork/parent restarts
— acquired sessions don't drop when a parent process restarts.

Wire it into Claude Desktop / Claude Code as an HTTP MCP:

```json
{
  "mcpServers": {
    "cloud-browser": {
      "type": "http",
      "url": "http://127.0.0.1:7400/mcp"
    }
  }
}
```

## Lifecycle

1. `browser_use_profile("foo")` → POST `/api/browser/sessions` → a fresh
   Chrome container spins up in Cloudflare. The daemon attaches Playwright
   over CDP (WSS through the gateway) and tracks the session by profile name.
2. Subsequent tool calls (`browser_navigate`, `browser_screenshot`, …) drive
   the same container via Playwright.
3. `browser_release("foo")` → DELETE `/api/browser/sessions/<id>` → container
   is destroyed. The local idle reaper does the same after `IDLE_TIMEOUT_MS`
   (default 30 min). The remote also has its own 15-min idle timeout — both
   are belt-and-braces against runaway containers.

## Profile persistence

**Not yet wired.** Each acquire spins up a fresh container — cookies, login
state, and `Default/` profile data don't survive `release`. The next pass
will snapshot `/profile` to R2 on container stop and seed it back on next
acquire; until then, "profile" is just a session label in this MCP, not a
durable identity.

## Tools (19)

See [DESIGN.md](./DESIGN.md) for the full surface.
