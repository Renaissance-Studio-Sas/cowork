# Subscription → API auto-fallback

Status: **implemented + live-tested** (cloud runtime only). cloud-agent deployed
2026-06-09 (worker version 9a238480); fallback verified end-to-end against the
deployed worker via the `simulateQuota` test hook (switch→API, API answered,
switch-back→subscription). cowork is NOT yet configured with a key in prod — set
`ANTHROPIC_FALLBACK_API_KEY` to arm it.
Scope: `cloud` runtime (cloud-agent worker + container runner). The `remote`
(Docker controller) and `gemini` runtimes are untouched.

## The problem

A cloud session runs on the user's **Claude.ai subscription** (an OAuth blob
restored into the container at `~/.claude/.credentials.json`). When the
subscription hits its usage limit (the 5-hour or weekly window), the turn fails
and the session is dead in the water until the window resets — even though the
user may have an Anthropic **API key** that could keep the work going.

Goal: when the subscription is maxed out, seamlessly switch the *same session*
over to the API key; when the subscription has capacity again, switch back —
with no lost work and no manual intervention.

## The lever

Claude Code's credential precedence: if `ANTHROPIC_API_KEY` is set in the
environment, the CLI bills the API and ignores the OAuth credentials file;
absent, it uses the OAuth subscription. So "switch provider" = toggle that env
var. The catch is that the env is read when the CLI subprocess spawns, so a
switch only takes effect on a **fresh `query()`** — we restart the SDK query
(resuming the conversation by id) so the new subprocess picks up the change.

All the switching logic lives in the **runner** (`cloud-agent/image/src/server.mjs`),
which owns the SDK query lifecycle. cowork only passes the key/cap down and
renders the status notes; the cloud-agent worker + DO are pure plumbing.

## Behavior

**Detecting "maxed out"** (`detectQuotaError`): two shapes —
1. a `rate_limit_event` whose snapshot reports `status: "rejected"` (proactive),
2. a `result` event with `is_error` and either `api_error_status === 429` or a
   usage-limit-looking message (reactive).

**Switch to API** (in `pumpEvents`, on the `QuotaExceeded` sentinel): set
`ANTHROPIC_API_KEY`, `resume` the SDK conversation, and **replay the turn that
failed** so nothing is lost. Emits a `provider_switched` system event (rendered
as a chat note).

**Switch back** (in the `/input` handler, before the next turn): the reset time
comes from the last `rate_limit_event`. If that window has passed, flip back to
the subscription and restart. If the subscription is in fact still capped, the
quota detector immediately flips back to the key — self-correcting. Reset time
unknown → stay on the key (don't flap a failed turn every message).

**Spend cap** (optional): `apiSpendUsd` accumulates `result.total_cost_usd` for
turns billed to the key. Once it crosses `fallbackMaxUsd`, `fallbackCapped`
latches: the runner stops failing over and flips back to the subscription, so a
session can't keep billing the API unboundedly. Conservative — if the SDK ever
reports cumulative (not per-turn) cost it trips early, which is the safe
direction for a budget guard.

**Disabled by default**: with no key configured the whole path is gated off —
rate-limit events stream through and quota errors surface exactly as before.

## Config

cowork server env (`.env.local`):

| Var | Meaning |
|---|---|
| `ANTHROPIC_FALLBACK_API_KEY` | Key to fail over to. Unset = feature off. |
| `ANTHROPIC_FALLBACK_MAX_USD` | Optional per-session USD cap on the key. Unset = unlimited. |

These flow `cloud.ts → worker createSession → DO InitBody/StartParams → runner
POST /sessions`. The DO persists them in `StartParams`, so a hibernated session
re-launched into a fresh container keeps the fallback configured.

## Implementation notes / gotchas

- **One session per container.** The runner toggles `process.env`
  (process-global), which is safe because cloud-agent runs exactly one session
  per container (`RUNNER_SESSION_ID = "s"`).
- **Generation guard.** The switch-back restart can leave the previous (idle)
  query loop suspended on the old iterator while a new loop owns the session.
  `pumpEvents` captures `myQuery = entry.q` and only runs terminal handling
  (`finishEntry` / error emit) when it still owns the entry; `restartQuery`
  fire-and-forget `.return()`s the old query to release its subprocess.
- **Billing flips.** On the API key the user pays metered per-token instead of
  subscription quota. The chat note flags it; the spend cap bounds it.

## Testing

A `simulateQuota` flag on POST /sessions (test hook, like `dryRun`) makes the
runner synthesize a usage-limit hit on the first turn — exercises the switch
without a real limit. `/tmp/fallback_test.mjs` drives the deployed gateway with
it (create session → stream SSE → assert switch→API→switch-back). Disabled
unless a fallback key is also present, so it's inert in normal use.

## Open items

- Not armed in prod — set `ANTHROPIC_FALLBACK_API_KEY` on the cowork server.
- Env-var config, not a per-user settings UI (matches cowork's single-user
  model). A D1-backed per-user key + cap is the next increment if multi-user.
- `total_cost_usd` per-turn-vs-cumulative semantics assumed per-turn; verify
  against the SDK and adjust the accumulator if needed.
- Real-limit path: only the synthetic hit is tested; the live `detectQuotaError`
  patterns (429 / "usage limit" text / rejected rate_limit) are unverified
  against an actual subscription cap.
