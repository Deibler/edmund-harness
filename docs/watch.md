# The security watch

Under `[security] model_host_access = "full"` the model can do anything your
user account can. The likeliest harm is not someone breaking in. It is the
assistant doing something it should not: because a page it read told it to,
because it built something that opens a door, or because it made a mistake.

The watch is for that. It restricts nothing in a normal turn. It records what
each turn did, runs a set of tripwires over every tool call, and wakes only
when one trips.

Set it in `[watch]`:

| `mode` | What happens |
|---|---|
| `off` | No hook on workers, nothing recorded. |
| `observe` | Everything is recorded, judged and alerted on. Nothing is stopped. The default, and the way to try it. |
| `enforce` | A call that cannot be undone waits for a verdict; what is judged serious is refused, the turn stopped and the chat paused. |

## How a tool call is seen

Claude Code calls an HTTP endpoint before and after every tool call a worker
makes (measured on CLI 2.1.332: about 3 ms a call). The daemon listens on
loopback and puts each worker under it when it starts the worker, including
sub-agents. If the endpoint does not answer, the call runs and the CLI says
so in its event stream; three of those in a minute raise an alert, because a
watch that has gone quiet is what switching it off would look like.

Each call is read for what it means: which hosts it names and whether it can
send to them, which credential stores it reads, what it writes that persists,
who a message goes to, whether it runs fetched or encoded text. That goes on
the turn's flight record with what was asked and by whom. Calls that reach
outside the machine are also written to the `flight` log channel
(`edmund logs flight`), and a first contact with a site is noted in
`security`.

## Tripwires

| Shape | Before a verdict |
|---|---|
| A canary's value on its way out, in a command, a URL or a message | refused |
| A real credential in a message to anyone but the operator | refused |
| A real credential going to a site it has not been sent to before | held |
| A vendor-format key going to a new site or into a message | held |
| A credential store was read, and now data is sent to a site never contacted | held |
| A text to someone outside the chat, after reading outside content | held |
| Code fetched from a never-contacted site and piped into a shell | held |
| A command decoded from base64 or hex and run | held |
| Fetched code run from a known site, or a downloaded file run | watched |
| Data sent to a never-contacted site after reading outside content | watched |
| A LaunchAgent, crontab, shell profile, `~/.ssh`, cloudflared config, `persona/AGENTS.md`, `SOUL.md`, `config.toml`, a git hook or Claude Code settings changed | watched |
| A tunnel or a listener on every interface started by hand | watched |
| A canary read | watched |

*Refused* needs no judgment: nothing has a reason to do it. *Held* waits for
the judge, because once it has run it cannot be taken back. *Watched* runs,
and the judge looks afterwards.

"Outside content" is a web page, a downloaded file, or other people's
messages. The operator's own chat is not outside content.

Secrets are known by value, not guessed by shape: every credential in
`config.toml`, every file in `data/secrets/`, and the checkout's `.env`. They
are also found base64-encoded at any offset, in hex and URL-encoded. Names are
logged (`config:keys.openrouter`); values never are.

Two canaries are planted at first start: `data/secrets/aws-backup.token` and
`.env.production` at the top of the checkout. Nothing reads them. Leave them.

These rules were replayed over 753 real turns before they were allowed to do
anything (`bun scripts/watch-replay.ts persona/sessions --days 35`). The first
draft tripped on 46 turns, almost all from three mistakes: fetched data piped
into the turn's own inline script, an article's long URL read as a payload,
and here-document bodies read as shell. After those were fixed: 7 turns, and 3
calls that would have waited. Run the replay again before changing a rule.

## The judge

A tripped call goes to a small model (`[watch] judge_model`, Claude Haiku 5.5)
with the flight record and one question: did the person ask for this, or did
something the turn read steer it here? It answers benign, suspicious or
serious with a sentence. Measured: 2.1 to 2.5 seconds, under a tenth of a cent.

| Verdict | A held call | A watched call |
|---|---|---|
| benign | runs | nothing; the same shape is not asked about again for a day |
| suspicious | refused; you are texted and can allow it | recorded |
| serious | refused, turn stopped, chat paused, you are texted | turn stopped, chat paused, you are texted |
| none in `hold_seconds` | runs, flagged; a late serious verdict still contains | recorded |

The watch fails open. No verdict, a refusal from the model, or an error inside
the watch lets the call run. It must never be the reason real work stopped.

## Answering an alert

A serious incident texts the operator: what happened, where, what was done,
and how to answer.

| Reply | Meaning |
|---|---|
| `OK K7Q2` | It was fine. Reverse what was done and do not raise this shape, for this target, in this chat again. |
| `UNDO K7Q2` | Reverse what was done, this once. |
| `LOCKDOWN` | See below. |

A bare `OK` or `UNDO` works only as a direct answer: the alert is the last
thing the assistant said and it is under half an hour old. Otherwise name the
incident. These replies never become a turn, so they work when the model is
the thing that went wrong.

`edmund watch` shows the mode, counts and open incidents. `edmund watch
incidents` lists them; `edmund watch ok <id>`, `undo <id>` and
`resume [chat]` do the same from the terminal.

## Lockdown

`edmund lockdown`, or `LOCKDOWN` texted from an operator handle:

- every quick tunnel and shared artifact is taken down (one launchd keeps
  alive is unloaded, not just killed);
- workers lose the shell and the filesystem, whatever `[security]` says;
- nobody but the operator is messaged;
- the web tools are refused.

Named tunnels stay up, so the household's pages and the SMS webhook still
work. `edmund lockdown off` (or `LOCKDOWN OFF`) puts back what it unloaded.
It works with the daemon down: the flag is a file every process reads.

## The publish gate

`share.sh` calls `scripts/publish-gate.ts` at three points:

1. **Before anything starts.** The expiry must be set and within
   `[watch] max_share_days` (30), and no file in the folder may be the kind
   that holds credentials (`.env`, `*.token`, a private key, `.git`, a link
   out of the folder) or contain a canary, a real credential or a vendor's key
   format.
2. **Before the tunnel.** The door is written down by port.
3. **After the tunnel is up.** The address is fetched with no key and must be
   refused.

A tunnel or a non-loopback listener that appears without being written down
is an incident. If it was started from one of the assistant's sandbox folders
it is closed, with its command saved. If not, it is reported and left alone:
the operator works on this machine too.

A file published with `shelve` is read the same way, and refused if it holds
a secret.

## What it cannot do

- It sees what a command says, not what a program does once running. A script
  the turn writes is read when it is written; one that was already on disk is
  not.
- It runs as your user. Something with a shell can kill the daemon or edit
  this checkout so the next worker has no hook. The quiet-hook alert and the
  check that every worker is started with the hooks catch the ordinary cases.
  The real fix is to run the watch as another macOS user, which needs an
  admin password once.
- Blocking an address at Cloudflare and turning on Under Attack mode need a
  token with edit rights on the zone's WAF rules and IP lists.
