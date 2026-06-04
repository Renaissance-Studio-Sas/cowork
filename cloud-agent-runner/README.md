# cloud-agent-runner

Local controller + container image for running Claude Code agents off the
laptop. Design lives in `../workspaces/Cowork App/Cloud Agent Runner/design.html`.

MVP layout — no R2 yet. The container bind-mounts the laptop's repo at
`/workspace` and forwards Anthropic OAuth via `CLAUDE_CODE_OAUTH_TOKEN`.

> **Auth on macOS hosts:** Claude Code stores OAuth in the macOS
> Keychain, not in `~/.claude/.credentials.json` — bind-mounting
> `~/.claude` alone won't authenticate the in-container CLI. The
> controller forwards `CLAUDE_CODE_OAUTH_TOKEN` into every runner
> container, so extract the token from Keychain once and export it
> when starting the controller:
>
> ```bash
> export CLAUDE_CODE_OAUTH_TOKEN=$(
>   security find-generic-password -s "Claude Code-credentials" -w \
>   | python3 -c "import sys,json;print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])"
> )
> ```

```
cloud-agent-runner/
├── runner/        # Node session manager — runs inside each container
└── controller/    # Local daemon — `docker run`s the runner per session
```

## Setup

1. **Build the runner image:**
   ```bash
   cd cloud-agent-runner/runner
   docker build -t rowads-agent-runner:latest .
   ```

2. **Start the controller:**
   ```bash
   cd cloud-agent-runner/controller
   AGENT_CONTROLLER_TOKEN=$(openssl rand -hex 16) node src/server.mjs
   ```
   The controller listens on `127.0.0.1:8090`. Save the token you picked —
   cowork must send it as `Authorization: Bearer ...`.

3. **Point cowork at the controller** by adding these to cowork's
   `.env.local`:
   ```
   AGENT_CONTROLLER_URL=http://127.0.0.1:8090
   AGENT_CONTROLLER_TOKEN=<the hex you copied>
   ```

4. **Restart cowork's dev server** so it picks up the env vars.

5. **Create a remote session** — in cowork's "New session" form pick
   *Remote (Docker)* as the runtime.

## How the pieces talk to each other

```
cowork (Next.js)
  │
  │  POST /v1/sessions  (Bearer AGENT_CONTROLLER_TOKEN)
  ▼
controller (Node, :8090)
  │
  │  docker run rowads-agent-runner:latest
  ▼
runner container (Node, :8080 → dynamic host port)
  │
  ▲  SSE /sessions/{id}/stream  + POST /sessions/{id}/input
  │  (Bearer RUNNER_TOKEN, generated per session)
  │
cowork remote runtime
```

The controller is on the cowork→runner critical path only during session
creation. Once cowork has `runner_url` + `runner_token`, it talks to the
runner directly — the controller is off the hot path for streaming.

## MVP scope / caveats

- **No R2.** Workspace and Anthropic OAuth are bind-mounted from the host.
  Writes the agent makes to `/workspace` land in the host repo immediately.
- **Workbench tools proxy back to cowork** over a reverse-call channel.
  When the SDK invokes a workbench tool (comments, AskUserQuestion,
  set_session_title, planning, …) the runner emits a `workbench_tool_call`
  SSE event with a UUID; cowork dispatches the real handler locally and
  POSTs the result back to `/sessions/{id}/tool-result`. Parallel calls
  are supported — each pending call is keyed by id on the runner.
- **`canUseTool` always auto-allows in remote mode.** ExitPlanMode and
  similar permission flows don't gate inside a remote session.
- **Chrome-bridge MCP** is not forwarded — `chrome_connect` etc. won't
  work remotely. Sessions that need it should use Claude (local).
- **No multi-session per container.** Each session = one container; when
  the session ends the container exits and is removed.
- **No resume.** Stopped remote sessions can't be re-driven — start a new
  one. The Claude SDK transcript is in `~/.claude` inside the container
  and is lost on exit. R2 + persistent OAuth fixes this in v2.

## Controller env vars

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8090` | Cowork-facing port |
| `DOCKER_IMAGE` | `rowads-agent-runner:latest` | Image tag to run |
| `WORKSPACE_DIR` | `$HOME/git/rowads-automation` | Bind-mounted at `/workspace` |
| `RUNNER_HOME_DIR` | `$HOME/.rowads-agent/runner-home` | Per-user persistent home, bind-mounted at `/home/agent` |
| `RUNNER_CLAUDE_DIR` | `$HOME/.claude` | Bind-mounted at `/home/agent/.claude` (skills + history) |
| `AGENT_CONTROLLER_TOKEN` | unset | Required Bearer token (or set `CONTROLLER_TOKEN`) |
| `ANTHROPIC_API_KEY` | unset | Forwarded into each runner container if set |
| `CLAUDE_CODE_OAUTH_TOKEN` | unset | Forwarded too — macOS hosts need it, see auth note above |
| `IDLE_TIMEOUT_MS` | `900000` | Runner exits when idle this long (15 min) |

## Troubleshooting

- **`controller /v1/sessions 500: runner health-check timed out`** — the
  container started but its HTTP server didn't come up. Run
  `docker logs <container_id>` (controller logs the ID on failure) to see
  why; usually a `pip install` or `node` syntax error in the runner.
- **`401 unauthorized`** — cowork's `AGENT_CONTROLLER_TOKEN` doesn't match
  the controller's. Restart cowork after copying the token.
- **Agent says "I don't have access to that file"** — the bind mount
  works, but `WORKSPACE_HOST` may point at the wrong directory. Confirm
  with `docker inspect <container_id> | grep -A3 Mounts`.
