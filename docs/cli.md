# The edmund command

`bin/edmund` is a small bash launcher that runs `cli/main.ts` with bun from
the repository root. Run `./bin/edmund install` once to symlink it onto your
PATH, after which every example below is just `edmund`.

Flags take `--flag value`, `--flag=value`, or `-f value`. An unknown command
exits 2, an error exits 1, and output drops colour when not on a TTY or when
`NO_COLOR` is set. `EDMUND_REPO` overrides the repository root.

## Services

Four launchd jobs can be managed. Pick one with a flag or omit the flag to act
on all of them.

| Flag | Job | Port |
|---|---|---|
| `--harness` | the daemon | none |
| `--dashboard` | operator dashboard and user portal | 4747, 4749 |
| `--trading` | trading integration dashboard | 4848 |
| `--fishing` | fishing data platform (a separate repository) | 8087 |

| Command | What it does |
|---|---|
| `edmund start [target] [--local]` | Install and start the launchd job, or kick it if it is loaded. `--local` runs one target in the foreground instead, after removing its launchd job. |
| `edmund stop [target]` | Send SIGTERM through launchd. The job respawns in about thirty seconds because it is KeepAlive; use `kill` to stop it for good. |
| `edmund restart [target]` | `launchctl kickstart -k`, installing first if needed. |
| `edmund status [target]` | launchd state, pid, uptime, who holds the port, URLs, config mtime, log size. |
| `edmund kill [target]` | Remove the launchd job and terminate any stray local process. |

The daemon is not a system daemon. It is a user LaunchAgent, so it starts at
login rather than at boot, and it runs as you.

## Logs

```
edmund logs [--follow] [--all] [--debug|--info|--warn|--error] [--session X] [--scope Y] [--grep RE] [-n 200]
edmund logs --dashboard | --trading | --fishing
```

Tails `data/daemon.log` as a story of what the model is doing and for whom:

```
20:23:46  INFO  message   Axolotl crew          ← Sam Rivera          2 msgs, 1 attachment
20:23:46  INFO  model     Axolotl crew          working               cold start
20:24:54  INFO  step      Axolotl crew          Bash                  Check v1 support usage
20:52:13  INFO  subagent  Axolotl crew          started               "Build a candidate sourcing list"
20:52:19  INFO  step      ↳ 2762f4 Axolotl crew web_search            "superintendent open to work"
20:48:46  INFO  model     Axolotl crew          done in 24m60s        43 steps · 202-char reply · $29.68 session
          ·     still working: Sean Conway 3m, 4 steps, last Bash
```

The who column names the person or group (from Contacts and Messages), and
`--session` matches a name as well as a handle (`--session sam`). Each
conversation has its own color, a bar down the left edge and its name in that
color, so one thread can be followed through a long, interleaved log; a
subagent's lines take the color of the conversation that spawned it.
`FORCE_COLOR=1` keeps the colors through a pipe (`| less -R`). Each model
step is one line saying what it does (a Bash step's description, the file it
read, the text it sent); the tool server's duplicate lines are hidden and
failures are kept. Subagents show when they start, what they do and when they
finish; scheduled wake-ups and background jobs show too. Heartbeat lines
(mirror reconnects, widget refreshes, recall progress, pool stats) are
hidden, and any line the view does not recognise is shown as it is. While
following, a line each minute names every turn still running. `--all` shows
every line in the raw columns (time, level, scope, session, event). Level
flags are additive. Continuation lines inherit the parent's verdict, so a
stack trace stays with its error.

## Sessions

```
edmund sessions list
edmund sessions reset <key>      # drop the provider thread id; next turn starts cold
edmund sessions compact <key>    # compact the Claude transcript's images
edmund sessions heal <key>       # run the healer for the last failure class
edmund sessions invoke <key>     # heal, then run a recovery turn over unanswered messages
edmund sessions rerun <key>      # same, ignoring the recovery cooldown
edmund sessions wipe <key>       # delete the session row and its transcript
edmund sessions pending          # orphaned inbound acks
```

`invoke` and `rerun` make the model send a message to the person. Use them
when a conversation is stuck and you have read the log.

### Proactive settings per session

```
edmund sessions brownnose list
edmund sessions brownnose show <key>
edmund sessions brownnose enable <key>
edmund sessions brownnose disable <key> [--reason "..."]
edmund sessions brownnose reset <key>
edmund sessions brownnose invoke <key> [--force] [--fire-now] [--dry-run] [--brief "..."]
```

`invoke` runs a real ghost tick outside active hours. `--force` bypasses the
budgets, `--dry-run` decides without queuing, and `--brief` skips the ghost
and queues an operator-authored proactive message.

## Scheduling and agents

```
edmund cron list [--session K]
edmund cron delete <id>
edmund cron cancel-pokes <session>

edmund agents list [--status pending|running|done|failed|canceled] [--session K]
edmund agents cancel <id>
```

## Skills

```
edmund skills list
edmund skills search [query]
edmund skills install <name> <owner/repo>
edmund skills uninstall <name>
edmund skills approve <name>       # a marketplace skill that ships scripts is inert until approved
edmund skills disable|enable <name>
edmund skills curated              # what the curator wrote and how often it was read
edmund skills curate-now           # force a curator and lifecycle pass
edmund skills consent              # decisions people made about published skills
```

Marketplace installs are limited to `[skills_marketplace].allowed_sources`.

## Announcements

```
edmund announce add --title T --body B [--link tab] [--min-active-days N] [--starts ISO] [--expires ISO]
edmund announce list | status [id] | retire <id> | who
```

Announcements never send a message. `who` shows who would currently be
offered one. The body is scanned for anything that looks like a person's
name or handle and refused if it finds one.

## Credits

```
edmund credits list
edmund credits show <handle>
edmund credits mode <handle> wallet|house
edmund credits grant <handle> <usd>
edmund credits sync <handle>
edmund credits pause|resume <handle>
edmund credits liability
```

Balances come from OpenRouter and payments from Stripe, read live. There is
no local ledger to get out of sync.

## Portal links

```
edmund portal link <handle>      # the person's current portal link
edmund portal revoke <handle>    # invalidate every link issued so far; prints the new one
```

A portal link is a bearer credential scoped to one conversation. Revoke it
when a phone is lost or a screenshot went somewhere it should not have. The
next proactive message, or the next `get_portal_link`, carries the new link.

## Everything else

| Command | What it does |
|---|---|
| `edmund dashboard [--pin <4-8 digits>] [--logs [-f]]` | Show dashboard state, set the PIN, or tail its log |
| `edmund config show [section]` | Print the loaded config with secrets masked to their last four characters |
| `edmund config path` | Where the config file is |
| `edmund config tidy` | Lay `config.toml` out by how often each part changes (backup kept; refuses if a value would change) |
| `edmund recovery logs [--follow] [--err]` | Tail the log of the optional watchdog daemon, if you run one |
| `edmund install` | Symlink `bin/edmund` into `/opt/homebrew/bin` or `/usr/local/bin` |
| `edmund help` | Top level help |

There is deliberately no `config set`. Validated writes go through the
dashboard's Settings pages, which back up the file before every change.
