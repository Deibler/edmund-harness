# Operations

Running it day to day: services, logs, spend, sessions, backup, upgrade.

## Services

Everything runs as user LaunchAgents, so it starts at login, runs as you, and
restarts on crash. `scripts/launchd/service.sh` renders the tracked plist
templates into `~/Library/LaunchAgents/`, substituting the repository and home
paths, and the `edmund` command wraps it.

| Label | Runs | Log |
|---|---|---|
| `com.edmund-harness` | the daemon, through `run-daemon.sh` which sources `.env` | `data/daemon.log` |
| `com.edmund-harness.dashboard` | operator dashboard and portal | `data/dashboard.log` |
| `com.edmund-harness.trading` | trading integration dashboard | `data/trading.launchd.out.log` |
| `com.edmund-harness.fishing` | a separate data platform | `data/fishing.launchd.out.log` |

Two things about the daemon plist. It launches `bun` through a bash wrapper
because launching bun directly as the program hung at startup. And it sets
`ProcessType Background`, which on Apple Silicon pins the process to
efficiency cores; if you run local speech models, expect them to be several
times slower under launchd than in a terminal until that is changed.

`edmund stop` sends SIGTERM and launchd restarts the job in about thirty
seconds. `edmund kill` removes the job. `edmund start --local --harness` runs
the daemon in the foreground for a debugging session after removing its
launchd job, and `edmund start` puts it back.

The daemon refuses to start if a foreign process holds its port, and kills
stray copies of itself first, so a foreground run and a launchd run do not
fight over the watcher.

## Logs

`data/daemon.log` is one append only file for the daemon, the MCP servers
(prefixed `mcp[<session>]`) and sub-agents (prefixed `agent[<id>]`). Each
line is a timestamp, a level, a scope tag, and key value pairs. Values whose
key looks like a secret are replaced with `***`.

Read it with `edmund logs`. The useful habit is `edmund logs --session
<handle>`, which pulls one conversation's turns, tool calls, sends,
verifications, cron fires and proactive activity into a single column.

Turn debug logging on with `EDMUND_LOG_LEVEL=debug` in `.env`, or
`scripts/launchd/service.sh debug on`, which edits the tracked plist template
and reinstalls; remember to turn it off before committing.

The boot banner is one line and tells you the cursor, provider, model, pool
state, watcher source and allowlist sizes. The line after it, `[loadout]`,
tells you whether the persona and skills were found.

For macOS itself, use `/usr/bin/log show --predicate 'process == "Messages"'
--last 10m`. The full path matters if a shell function is shadowing `log`,
and short windows matter because long queries hang.

## Spend

`data/spend.db` has one row per model invocation with the CLI's own cost
figure, the session, the subsystem (turn, cron, agent, ghost, maintainer,
catch-up and so on), duration and measured context. A daily rollup table sits
beside it. The dashboard Overview reads both. There is no estimation anywhere;
if the CLI did not report a cost, the row has none.

To see your own cost curve, group turns by context bucket and take the median
cost per bucket. The shape you will find, and what to do about it, is in
[costs.md](costs.md).

## Sessions

`edmund sessions list` shows every conversation with who, kind, last inbound
and outbound, the provider thread id, and the last failure class with heal
attempts. `edmund sessions pending` shows orphaned inbound acks, which is what
a message that never got a turn looks like.

State is in `data/state.db`. Do not edit it by hand while the daemon runs.

## Interventions

| Situation | Do |
|---|---|
| A conversation is stuck with an unanswered message | Read `edmund logs --session`, then `edmund sessions invoke <key>` |
| The provider thread is confused or too long | `edmund sessions reset <key>` for a cold start next turn |
| A worker is misbehaving | Dashboard, Daemon page, flush the pool; or restart the daemon |
| Sends are refused with `chat_mismatch` | Do not relax the guard. Restart Messages through the daemon (it will do so itself), and check `chat.db` for where earlier sends landed |
| Someone should stop hearing from it proactively | `edmund sessions brownnose disable <key>`, or they can do it in their portal |
| A person wants their data gone | Their portal has erase actions; or delete their person file and sandbox and `edmund sessions wipe <key>` |

## Alerts

`[alerts].operator_handle` receives iMessages that bypass the model: an outbox
stuck for ten minutes, a healer failing repeatedly, a data trigger failing five
times in a row, a lock held silently past its lease, the daily credits
liability check. They are deduplicated per signature within
`min_interval_minutes`. The dashboard Alerts page lists and mutes them.

## Backup

Nothing stateful is in git. Copy these directories:

- `config.toml` and `.env`
- `persona/` (the assistant's memory; treat it like a journal)
- `data/` (every database, the logs, the generated MCP configs)
- `sandbox/` (received and generated media, mission notes, agent results)
- `skills/instant-share/.config/` if you use that skill

The dashboard writes `config.toml.bak-<timestamp>` before every settings
change, and its writer drops inline TOML comments. Keep a hand edited copy if
you care about them.

`git revert` cannot undo a change to any of these. When a rollback of code
also needs a rollback of state, do both.

## Upgrade

1. `git pull` and `bun install`.
2. If the bridge changed: in its repository, `touch native/src/*.m && npm run
   build`, confirm a `clang` line, and expect it to take effect on the next
   Messages launch.
3. If `dashboard/web` or `dashboard/user-web` changed: `bun install` in that
   directory, then `bun run dashboard:build` or `bun run portal:build`.
4. Diff `config.example.toml` against your `config.toml` for new sections.
   Missing sections take their defaults; unknown keys are ignored.
5. `edmund restart`, or per target.
6. Watch the boot banner and the first few turns.

## Tunnels

Three optional Cloudflare tunnels: a named tunnel for the user portal
(`scripts/setup-portal-tunnel.sh <hostname>`), a named tunnel for the SMS
webhook, and an on demand quick tunnel for the full dashboard
(`scripts/dashboard-tunnel.sh up`, which expires). The portal and payment
routes are the only thing the public listener serves; the PIN gated dashboard
should not be exposed except on demand.
