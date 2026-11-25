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
| `com.edmund-harness.fishing` | a separate data platform | `data/fishing.launchd.out.log` |

Two things about the daemon plist. It launches `bun` through a bash wrapper
because launching bun directly as the program hung at startup. And it sets
`ProcessType Interactive`. `Background` pins the daemon and everything it
spawns (model workers, MCP servers, Messages) to the efficiency cores with
throttled I/O, and `Adaptive` never leaves Background for this daemon. A test
pins the template, and the daemon logs `[boot] qos` when it finds itself
throttled anyway.

`edmund stop` sends SIGTERM and launchd restarts the job in about thirty
seconds. `edmund kill` removes the job. `edmund start --local --harness` runs
the daemon in the foreground for a debugging session after removing its
launchd job, and `edmund start` puts it back.

The daemon refuses to start if a foreign process holds its port, and kills
stray copies of itself first, so a foreground run and a launchd run do not
fight over the watcher.

## Logs

There are two kinds of log, written from the same events.

**The operational log**, `data/daemon.log`, is every line in the order it
happened: the daemon, the MCP servers (prefixed `mcp[<session>]`) and
sub-agents (prefixed `agent[<id>]`). Each line is a timestamp, a level, a
scope tag, and key value pairs. Read it with `edmund logs`, which shows who
each turn is for, one line per model step, subagents and wake-ups, with the
heartbeat noise hidden (`--all` for every line). The useful habit is
`edmund logs -f --session <name or handle>`, which follows one conversation.

Hidden with the noise is trouble the daemon is already handling: a trigger
check that failed and will be retried (it shows from the fifth failure in a
row, when the operator is alerted), a site asking for fewer requests, and a
memory restart held back until a running turn ends. What stays visible is
what did not resolve: the alert-level failure, the restart that happened,
recall that cannot run.

**The channels**, `data/logs/<channel>/<day>.jsonl`, hold the same events
filed by subject, one JSON record a line with its fields intact, plus the
things that are recorded and never printed. `edmund logs channels` lists them
with their sizes.

| Channel | What it holds |
|---|---|
| `model` | Model turns: workers, the pool, tool use as the model asked for it, usage, compaction |
| `tool` | Tool calls as the MCP servers ran them, including screen control |
| `message` | Messages in and out: the watcher, the bridge, sends and their verification, SMS |
| `cron` | Scheduled jobs: fires, skips, retries, wake-ups, refresh scripts, recovery sweeps |
| `trigger` | Data triggers: armed, evaluated, fired |
| `ghost` | Proactive work: the ghost's decisions and fires, ideation pages, announcements |
| `agent` | Sub-agents and background jobs |
| `memory` | Recall, the memory maintainers, archiving and consolidation, skill curation |
| `call` | FaceTime calls, the transcriber, the turn detector, speech |
| `integration` | Printer, mirror, radar, Grok, portal, dashboard, credits |
| `security` | Inbound gating, guest tiers and caps, addressing decisions, refused sends and actions, and every 401, 403 and 429 a server answered |
| `net-out` | Every HTTP request a harness process made: host, path, status, duration |
| `net-in` | Every HTTP request a harness server answered: server, method, path, status, duration, caller |
| `browse` | What the model opened on the web: pages, fetches, searches, addresses in shell commands |
| `proc` | Every child process (command, pid, exit code or signal, duration) and the process tree as the system reports it |
| `resource` | Memory, CPU, GPU, swap, disk and thermal state once a minute, with the largest processes |
| `system` | Start-up, shutdown, alerts, process exits, and the logger's own notices |
| `error` | A copy of every warning and error from every channel, and any exception that ended a process, with its stack |

`net-out`, `net-in`, `browse`, `proc` and `resource` are channel only: they
would bury the operational log, so they are not in it.

### When something goes wrong

Start from the error and widen:

```bash
edmund logs errors --since 2h          # every warning and error, from every process
edmund logs trace model_turn_ab12cd    # one turn, across every channel, in order
edmund logs trace sam --at 14:05       # one conversation, five minutes either side
edmund logs resource --since 30m       # what the machine looked like
edmund logs net-out --grep openrouter  # one upstream
```

Every record carries the conversation it belongs to and the turn (`turn
start` in the `model` channel names it; a scheduled job's turn is the job's
id). A trace gathers a turn's records from every channel: the message that
started it, the recall, each tool call, each outbound request it caused, what
it opened on the web, the send and its verification. It adds what belongs to
no conversation and still explains one: the resource samples, server requests
and errors in the same window. `--all` adds everything else in the window,
`--json` prints the records as they are stored.

### What is kept out

Request and response bodies and headers are never recorded, and neither is
the query string of a request in `net-out` or `net-in`. `browse` keeps a
page's query, because it is often the page, with the values of parameters
named like credentials hidden. A long opaque path segment (a share token, a signed id) is cut to six
characters. A command line keeps the program and its first four arguments,
each cut at 60 characters, with the value after a flag named like a
credential hidden. A field is replaced with `***` when it is named like a
credential and holds a string that is not a session key or a quantity.

In `net-in`, a successful GET the same caller repeats within a minute is
counted, not repeated: the first is recorded as it happens and the rest as
one line with their number and timing. An open dashboard tab would otherwise
write a quarter of a million identical lines a day. A request that changes
something, and one that is refused or fails, is always its own record.

### What they cannot see

Requests made by a child process: the model CLI talking to its API, the
browser, a script the model wrote. `model` and `browse` record those from
what the model reported doing. A child process shorter than the gap between
two samples appears as its exit record only when this process started it.

### Rotation and size

Days are UTC, like the timestamps. When the day changes `daemon.log` is moved
to `data/logs/daemon/<day>.log` and a new one started; `edmund logs` and the
dashboard follow the new file. `[logs]` in the config sets the rest: files
are compressed after `compress_after_days` (2), removed after
`retention_days` (30), and the whole of `data/logs` is held under
`max_total_mb` (2048) by dropping the oldest days. The daemon does this
hourly; `edmund logs tidy` does it now.

`data/logs/archive/` holds what predates rotation and what was copied out of
a log some other program appends to. Nothing removes it but you.

launchd keeps the daemon's raw output in `data/launchd.out.log` and
`data/launchd.err.log`. Under launchd the daemon no longer prints its log
lines there as well, so those files hold only what bypassed the logger: lines
from before logging started, a child's inherited output, and a runtime crash
report. One over `capture_max_mb` (20) is compressed into the archive and
emptied.

A line of one shape repeated more than 200 times in ten seconds is cut off
and counted (`[log] suppressed N more lines …`), and while it keeps coming
gets five lines per ten seconds. Three months of ordinary operation peak at
31. This exists because one scheduler bug wrote the same line 7.7 million
times in 28 minutes.

Turn debug logging on with `EDMUND_LOG_LEVEL=debug` in `.env`, or
`scripts/launchd/service.sh debug on`, which edits the tracked plist template
and reinstalls; remember to turn it off before committing.

## The data folder

`edmund data audit` lists what is at the top of `data/` against the declared
layout (`src/util/data-layout.ts`): what each entry is and what writes it,
what a removed feature left behind, what is a backup somebody made by hand,
what is stale (undeclared, and either empty for 30 days or a log untouched
for 90), and what nothing accounts for. `edmund data clean` shows what it
would move aside and `--apply` does it: retired and stale entries and backups
older than 30 days go to `data/.trash/<day>/` and are deleted 30 days later,
and old files in a declared cache are removed. An entry the layout does not know is listed and
never touched, and neither is a file a process still has open.

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
times in a row, the recall embedder failing for five minutes, a runtime crash
found at the next boot, a lock held silently past its lease, the daily credits
liability check. They are deduplicated per signature within
`min_interval_minutes`. The dashboard Alerts page lists and mutes them.

An expired Claude login alerts at once with the fix (`claude`, then `/login`),
and scheduled jobs that failed on it retry on a doubling schedule for about
eight hours. A Claude CLI update that fails the canary alerts too.

## Weekly review

`edmund review [--days 7] [--sample 40]` writes `data/reviews/<date>.md`: DM
reply times, DMs unanswered after a day, every correction people sent,
control words that reached a person, background failures from the log, and a
sample of real exchanges to mark pass or fail with the first thing that went
wrong. Reading it is the loop that keeps quality from drifting; the counts
alone prove nothing.

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
