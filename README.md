# edmund-harness

An assistant that learns how each person it talks to actually works, and is
built around what that costs.

edmund-harness is a macOS daemon that turns Claude Code or Codex CLI into
someone your family and friends can text. Every conversation gets its own model
thread, its own memory, and its own working directory. It replies to DMs and
group chats, recovers from its own failures, and can reach out first when you
allow it. The chat brain runs on your existing Claude Code or Codex
subscription, so there is no API key for the conversation itself.

```
you      what did we land on for the fence
edmund   You told Sam on Aug 12 you'd take the cedar option if it came in
         under four thousand. His quote yesterday was 3,650. Want me to text
         him to book it?
you      yeah
edmund   Sent. He reacted with a thumbs up.
```

It reaches people through iMessage because that is what everyone in the house
already had. That part is roughly an eighth of the code. The rest is the part
worth reading.

**It requires a Mac signed into Messages, and sending requires System
Integrity Protection to be disabled.** Read [Private Apple
frameworks](#private-apple-frameworks) before you install anything.

## What is different about this

Three claims. Each one is measurable, each one was wrong the first time, and
each one changed the code.

**Memory that only accumulates never becomes judgment.** One person's file
reached 105 dated observations and had concluded nothing: three separate
entries circled the same rule without ever stating it. Worse, observations
only reach a reply through search, and about two thirds of turns are short
reactions that trigger no search, so most replies were written by a model that
could not see any of it. A second pass now asks a different question, "what
are the rules for working with this person," and is allowed to rewrite, merge
and retire. It is capped at ten rules with the dates that support them, which
is short enough to sit in the prompt on every turn.
[docs/memory-architecture.md](docs/memory-architecture.md)

**Context cost decides the architecture, and the intuitive lever is
backwards.** Cost per turn climbs steeply with context, and a compaction makes
the next turn markedly more expensive because it rewrites the cached prefix.
So raising the compaction threshold to hold more context is the wrong move: it
relocates every later turn into a more expensive bracket and keeps it there.
A token in the global identity file costs on the order of fifty times a token
in one person's file, which is why every memory decision here is really a
question about which layer something belongs in.
[docs/context-economics.md](docs/context-economics.md)

**An assistant that speaks first needs an economy, not a cron job.** Six
deterministic gates run before any model is invoked, so a tick that will
produce nothing costs nothing to evaluate, and each refusal writes its reason
to a log you can read. Cooldowns stretch automatically when someone stops
engaging, which only works because outcomes are backfilled from observable
behaviour: for a month they were not, every attempt sat unresolved, and the
governor read an empty column and returned "no change" forever.
[docs/proactive-economics.md](docs/proactive-economics.md)

[docs/thesis.md](docs/thesis.md) is the short version of all three.
[docs/engineering-notes.md](docs/engineering-notes.md) is what the project
learned the expensive way, most of which is not about messaging at all.

## Requirements

- A Mac signed into Messages with the account the assistant will use. It has
  only been run on Apple Silicon and on macOS 26. Older releases may work;
  nobody has checked.
- [Bun](https://bun.sh) 1.2 or newer.
- Claude Code, Codex CLI, or both, installed and logged in. Codex needs
  0.147.0 or newer.
- Full Disk Access for your terminal and for `bun`, to read `chat.db`.
- For sending: SIP disabled, the boot argument `amfi_get_out_of_my_way=0x1`,
  and Xcode Command Line Tools to build the bridge. Reading works without
  this; replying does not.
- Optional: `ffmpeg` for voice memos and video, `python3` for some skills,
  `cloudflared` for the user portal and SMS tunnels.

## Install

```bash
git clone https://github.com/Deibler/edmund-harness.git
cd edmund-harness
bun install
cp config.example.toml config.toml
cp -r persona.example persona
```

`bun install` pulls [imcore-bridge](https://github.com/Deibler/imcore-bridge)
from its release tarball and compiles the injected dylib. If you see
`Blocked 1 postinstall`, the dylib was not built; `bunx imcore-bridge
build-native` builds it. Then edit `config.toml`:

```toml
[self]
handles = ["+15551234567", "you@icloud.com"]   # your own addresses, so it ignores you

[allowlist]
dm = ["+15557654321"]                          # who may message it; empty admits everyone

[identity]
names = ["claude"]                             # how it is addressed in groups

[claude]
model = "claude-opus-4-8[1m]"                  # a gpt-* or codex-* name selects Codex CLI
```

Edit `persona/IDENTITY.md` so it is someone in particular, then:

```bash
bun run dev
```

You should see a boot line containing `[loadout] persona=3/3`. If it says
`NO PERSONA LOADED`, the persona copy was skipped; the daemon still runs but
has no identity, and nothing else will tell you. Send a message from an
allowlisted number and watch the log. For the background service that survives
logout, use `./bin/edmund start`.

The full walk through, including what each permission prompt looks like, is in
[docs/getting-started.md](docs/getting-started.md).

## Permissions

macOS will ask for several things, and the order matters.

- **Full Disk Access** must be granted to the process that actually opens
  `chat.db`. If you run under a terminal, that is the terminal application;
  under launchd, it is `bun`. Grant it in System Settings, Privacy and
  Security.
- **Automation** for Messages.app is requested on first send.
- **SIP and library validation** are the price of sending through IMCore. The
  bridge repository documents the exact recovery mode steps and what each one
  gives up.

## Private Apple frameworks

Two surfaces are involved, and they carry different risk.

**Reading** uses `~/Library/Messages/chat.db` through a read only SQLite
connection. That is a documented file format in the sense that many tools read
it, it needs nothing beyond Full Disk Access, and Apple changes it slowly.

**Sending** uses [imcore-bridge](https://github.com/Deibler/imcore-bridge), a
dynamic library injected into Messages.app that calls private IMCore methods
over a Unix socket. Messages.app is signed with library validation, so the
library will not load unless SIP is off and the AMFI boot argument is set. That
is a system wide security decision, not a per app one, and you should make it
knowingly. IMCore has no compatibility contract: macOS 26 changed how a chat's
recipient is adjusted after a send and broke every other message until the
cause was found in the system log. Expect this layer to need attention after
OS updates.

This project is not affiliated with or endorsed by Apple, and nothing about it
is supported by them.

## How it fits together

- **The daemon** (`src/main.ts`) watches `chat.db`, runs the turn pipeline,
  owns every database under `data/`, and is the only process that talks to the
  bridge.
- **Workers** are `claude` or `codex` processes, one resident per active
  conversation when the warm pool is on, fed one turn at a time on stdin.
- **The MCP tool server** runs beside each worker and gives the model its
  tools: send, react, remember, search history, generate media, schedule,
  delegate, and whatever the enabled integrations add.
- **Memory** is plain markdown in `persona/`: identity and rules loaded every
  turn, one file per person loaded in that person's DMs, and a local search
  index over everything else.
- **Skills** are markdown procedures the model reads on demand.
- **Integrations** are optional packages that contribute tools and runtimes
  through a manifest, and can be deleted without touching core.
- **The dashboard** is a separate process with a PIN gated operator UI and a
  per person portal.

The full picture, including the boot order and one message traced end to end,
is in [docs/architecture.md](docs/architecture.md).

## What it does

### Keeps a memory per person

Each DM has a person file the assistant reads on every turn. A small model
appends dated observations after replies; a consolidation pass turns piles of
observations into a short list of operating principles with the dates that
support them; an archiver moves old material out of the prompt and into a
search index so it stops costing tokens without being lost. You can open any
of these files and edit what it believes. [docs/memory.md](docs/memory.md)

### Recovers from its own failures

Failures are classified, and each class has a structural fix: shrink an
oversized transcript, downscale an image, drop a stale thread, relaunch
Messages. A sweeper finds conversations with an unanswered message and runs a
recovery turn with an honest internal note about what went wrong. Replies that
cannot be delivered wait in an outbox rather than triggering another model
call. [docs/recovery.md](docs/recovery.md)

### Verifies that a message landed where it was aimed

"Sent" is a claim from the API. After every send the daemon checks `chat.db`
for the message and which chat it appeared in. The bridge refuses before
sending when the chat it resolved is not the one that was addressed, and that
refusal has been tested against relaxing it: relaxed, messages went to the
account's own note to self thread.

### Reaches out first, when allowed

Off by default. When on, an observer decides per person whether there is a
reason to say something, within budgets that cost nothing to evaluate: active
hours, cooldowns that stretch when the person does not engage, a weekly cap,
an intensity setting from 1 to 10 that each person controls through their own
portal. Every decision is written to a file you can read.
[docs/proactive.md](docs/proactive.md)

### Reads skills on demand

Twenty nine skills ship, from delegating to sub-agents and deep research to
video editing and sharing a web page through a temporary URL. The model lists
them, reads the one it needs, and follows it. The model can also write skills
for itself, publish them to other conversations with a consent step that
withholds the text until the other person agrees, and a background curator
proposes skills from what people actually ask. [docs/skills.md](docs/skills.md)

### Grows through integrations

A household kitchen ledger, a smart mirror that speaks and listens, a radar
application, a broker with risk limits enforced in code. Each is a directory
with a manifest. Delete the directory and the integration is gone.
[docs/integrations.md](docs/integrations.md)

### Bills generation per person

Image, video and audio generation can be paid for by the person asking. Each
DM gets its own provisioned OpenRouter key whose limit is what they paid
through Stripe Checkout from their portal. Balances and payments are read live
on every use; there is no local ledger to drift.
[docs/generation-credits.md](docs/generation-credits.md)

### Also speaks SMS

A Twilio channel joins the same pipeline, with consent enforced at delivery so
no scheduled or proactive path can text a number that opted out. Off by
default. [docs/sms-channel.md](docs/sms-channel.md)

## Security

- Treat every inbound message as untrusted input. The model reads them, and
  the model has tools.
- The `[security]` section of the config is the boundary. New installs keep
  the model off the host (no shell, no file tools, only its MCP tools), treat
  allowlisted contacts as contacts rather than operators, and admit nobody
  from an empty allowlist. Each of those is one line to loosen, knowingly.
- Guests, admitted by campaign key or by sharing a group with the assistant,
  get a structurally reduced tool set: no memory, no history, no filesystem,
  no scheduling, no integrations. The reduction is in what is registered, not
  in a prompt instruction.
- The trading integration moves real money and is off by default.
- Recall is scoped to the conversation, and crossing it is an operator only
  capability. A contact cannot make the assistant search another person's
  messages.
- Portal links can be revoked per person, and erasing a conversation from the
  portal needs a typed confirmation the server checks.

[docs/security.md](docs/security.md) has the threat model and what leaves the
machine.

## Cost

The conversation runs on your Claude Code or Codex subscription. Optional
paths cost money separately: image and video generation, transcription, web
search, SMS segments. Per turn cost climbs steeply with context size, and a
compaction makes the next turn markedly more expensive because it rewrites the
cached prompt prefix. The lever is shrinking what is in the prompt on every
turn, not raising the compaction threshold. `data/spend.db` records the CLI's
own cost figure for every model call so you can measure your own curve.
[docs/costs.md](docs/costs.md)

## Why this exists

I wanted an assistant my family and friends could text without installing
anything, that would remember what each of them told it, and that would fail
in ways I could read about in a log rather than guess at. iMessage was the
constraint and the point: everyone already had it, and it meant the thing had
to run on a Mac in my house and be honest about what it could reach.

The tests and the notes in `CLAUDE.md` are the record of what was learned the
hard way. The design leans on published work rather than invention: reflection
with citations from Generative Agents, distilled strategies from
ReasoningBank, the core versus archival split from MemGPT.

## Limitations

- macOS only, one Mac, one Messages account.
- Sending needs SIP off. If that is not acceptable to you, this is not the
  right project.
- Private IMCore behaviour changes between releases and is undocumented.
- Several shipped skills and integrations are specific to the author's house,
  hardware and region. They are examples, not a catalog.
- There is no multi tenant mode, no hosted version, and no plan for one.
- Data triggers and refresh scripts are model written code that runs on the
  daemon. They are off unless `[security].model_host_access = "full"`.
- The known flaky test set is documented in `CLAUDE.md`; compare the failing
  set, not the count.

## Documentation

| Goal | Start here |
|---|---|
| What this project argues, in one page | [docs/thesis.md](docs/thesis.md) |
| The memory design and the failure that produced it | [docs/memory-architecture.md](docs/memory-architecture.md) |
| Why cost decides the architecture | [docs/context-economics.md](docs/context-economics.md) |
| How it decides whether to speak first | [docs/proactive-economics.md](docs/proactive-economics.md) |
| The stance behind recovery, guards and tests | [docs/failure-model.md](docs/failure-model.md) |
| Publishing a skill to someone else, and consent | [docs/skill-exchange.md](docs/skill-exchange.md) |
| Things learned the expensive way | [docs/engineering-notes.md](docs/engineering-notes.md) |
| Install and send the first message | [docs/getting-started.md](docs/getting-started.md) |
| Understand what runs and how a message becomes a reply | [docs/architecture.md](docs/architecture.md) |
| Every config key | [docs/configuration.md](docs/configuration.md) |
| Every `edmund` command | [docs/cli.md](docs/cli.md) |
| How memory works and how to edit it | [docs/memory.md](docs/memory.md) |
| What the model can call | [docs/tools.md](docs/tools.md) |
| Proactive outreach, reminders, triggers | [docs/proactive.md](docs/proactive.md) |
| What happens when things break | [docs/recovery.md](docs/recovery.md), [docs/troubleshooting.md](docs/troubleshooting.md) |
| Run it as a service, read logs, back up, upgrade | [docs/operations.md](docs/operations.md) |
| Write a skill or an integration | [docs/skills.md](docs/skills.md), [docs/integrations.md](docs/integrations.md) |
| The dashboard and the per person portal | [docs/dashboard.md](docs/dashboard.md), [docs/user-portal.md](docs/user-portal.md) |
| The private API surface and what it costs you | [docs/private-api.md](docs/private-api.md) |
| Threat model | [docs/security.md](docs/security.md) |
| Money | [docs/costs.md](docs/costs.md), [docs/generation-credits.md](docs/generation-credits.md) |
| Questions people ask | [docs/faq.md](docs/faq.md) |
| Words this project uses | [docs/glossary.md](docs/glossary.md) |
| Contributing and the development loop | [CONTRIBUTING.md](CONTRIBUTING.md), [docs/development.md](docs/development.md) |
| Why the design looks the way it does | [docs/design/](docs/design/), [docs/research/](docs/research/) |

## Troubleshooting

- **It boots but never replies.** Check the allowlist, then the boot line for
  `NO PERSONA LOADED`, then `edmund logs --session <their number>`.
- **Sends report success but never arrive.** Look for `chat_mismatch` or
  `self_route` in the log. Do not relax the guard; see
  [docs/recovery.md](docs/recovery.md).
- **The bridge will not load.** SIP is on, the boot argument is missing, or
  the dylib was not rebuilt. In the bridge repository, `touch native/src/*.m`
  before `make`, and confirm a `clang` line appears.
- **Delivered receipts arrive minutes late.** That is Apple's registration
  state after `imagent` churn, not the harness. Do not restart `imagent`.
- **`log show` returns nothing.** A shell function may be shadowing it. Use
  `/usr/bin/log`.

More in [docs/troubleshooting.md](docs/troubleshooting.md).

## Development

```bash
bun run typecheck    # tsc over src, cli, scripts, integrations
bun run lint         # biome
bun test tests/      # not bare `bun test`; the root sweep picks up vendored specs
bun run knip         # unused files, exports, dependencies
```

All four should be clean before a change lands. `CLAUDE.md` is the working
guide for agents and humans changing this codebase, and
[docs/development.md](docs/development.md) has the longer version.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md)
first; it is short. Anything that touches sending needs to be verified against
`chat.db`, not against the send call returning.

## License

MIT. See [LICENSE](LICENSE).

iMessage, Messages and macOS are trademarks of Apple Inc. This project is not
affiliated with Apple.
