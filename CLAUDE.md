# edmund-harness — working notes for agents

Read this before changing anything. Everything here was verified in the repo or
measured from a live deployment, not recalled. Dates are absolute. Deployment
specific numbers (spend, usage, named people) live in the gitignored
`CLAUDE.local.md`, which Claude Code reads alongside this file.

---

# PART 1 — Landmines

## `log` may be shadowed by a shell function
On some Macs `log show` silently returns **nothing** because a zsh function
shadows it. Use `/usr/bin/log`. Keep windows narrow (`--last 10m`); multi-hour
queries hang. The macOS unified log held the answer to a months-old delivery
bug that nobody had looked for because the command appeared to work.

## `make -C native` in imcore-bridge does not always recompile
It sometimes only re-signs, so source changes never reach the dylib. **Always
`touch native/src/*.m` first**, and confirm a `clang` line appears in the
output. Three "this fix didn't work" conclusions in one session were about code
that was never built.

## `config.toml` and `persona/` are gitignored
Changes to either are local to the machine and are not recoverable from the
remote. `config.example.toml` *is* tracked; document new config there.
Gitignored state also escapes `git revert`, so a revert can leave the system in
a mixed state: sweep `persona/` and `data/db/state.db` session bindings too.

**Never paste a real key into `config.example.toml`.** It is tracked and
pushed. It has happened by hand and was caught only by reading the diff. Check
`git diff config.example.toml` for anything that is not a placeholder before
every push.

## Outbound message text is not in `message.text`
It is in `attributedBody` (typedstream). Parser: find
`NSString\x01\x94\x84\x01+`, read one length byte (or `0x81` + uint16 LE), then
that many UTF-8 bytes. Without this, every query of the bot's own messages
returns empty and the conversation looks one-sided. An ad-hoc parser that
returns empty on rich-text bodies makes a delivered message look unsent; check
`is_delivered` instead.

## The known-flaky test set: do not chase it
`SpeechSidecar` (3) fails on a clean baseline. `evaluateTrigger`,
`DataTriggerWatcher`, `runRefreshScriptSource`, `RefreshWatcher`,
`protectStdout` flap under parallel load and pass in isolation. The baseline
itself varies run to run with unchanged code. **Compare the failing set, never
the count.** Run `bun test ./tests/`, with the `./`. Without it bun reads the
argument as a name filter over the whole checkout: it also runs the stale
copies in the `sandbox/*/wt/` worktrees and vendored specs, and holds about
14,000 file descriptors open, which leaves child processes' piped output empty
(the ffprobe round-trip then fails). Measured 2026-09-23: 30 descriptors by
path against 14,290 by filter.

## `sandbox/` and `persona/sessions/` may be symlinks to another disk
Keeping the old paths as symlinks keeps every absolute path in cron jobs,
venvs, worktrees and the databases valid. Two things depend on it.

First, Claude Code names a transcript folder after the cwd it sees, which is
the *resolved* path (`-Volumes-<disk>-sandbox-…`, measured 2026-10-25). The
harness reads the logical name. `ensureSessionLink` links both names to one
folder; without that, every resume finds nothing and the conversation starts
over.

Second, the daemon refuses to boot when either link dangles
(`src/boot/storage.ts`).

When copying a sandbox, remember that Edmund mounts disk images *inside*
sandbox folders. `rsync -a` walks into those mounts, so detach them first.

## The CLI will not write through a linked session folder
Claude Code saves what is too long to show inline (a tool result over its
token limit, a hook's output over 10,000 characters) to `tool-results/` under
the session's folder in `~/.claude/projects/`, and refuses when any folder on
the way is a link: `tool-results path refused: … is a link or not a
directory` (CLI 2.1.332 checks each one with `lstat`). Every conversation's
folder there is a link into `persona/sessions/`, so here that save always
fails. Measured 2026-11-25 over the transcripts kept: 17 of 42 outputs of the
post-compaction hook were cut at 10,000 characters, and 6 tool results over
the limit came back as an error with nothing in it (all in September, from
`web_fetch`, `read_team_results` and an outside MCP server).

Making the folder real would not have saved the hook. A saved output is
replaced inline by a short preview and a path, and that hook exists to put
the conversation's words back in sight. It listed the thread oldest first, so
what the cut took was the newest messages. Whatever the harness adds through
a hook fits `HOOK_CONTEXT_LIMIT_CHARS` (`src/channels/history.ts`) and gives
way from the old end. A tool whose result can be very long has no fallback
either and must bound it itself. Background Bash output is not affected: the
shell writes those files and follows the link.

## The model calls a tool the way it was told to
The tool list in the system prompt is written by hand, and so are skills and
wake-up notes. Each drifted from the schemas: `react(target_msg_guid,
reaction)` for a tool whose field is `target_guid`, `message_contact(handle,
text)`, a mid-turn note saying to reply to "the id above" when `reply_to`
took only words. A misnamed required argument fails and is retried. A
misnamed optional one was dropped by zod without a word and the tool did
something else: 10 of 20 `react` calls in a month lost the id they gave and
went to the newest message. Usually that was the one meant; on 2026-11-25 it
was not, and every one of them answered "reacted".
`tests/prompt-tool-signatures.test.ts` holds every backticked signature in
the source and the tracked skills to the tool's schema, and `callTool`
(`src/mcp/server.ts`) refuses a call that names an argument the tool does not
have before the tool runs. When a tool's answer is "done", have it say what
it was done to.

## The security watch sees a worker through a hook, and fails open
`src/watch/` puts every tool call a worker makes through tripwires
(`src/security/watch/`), using Claude Code's HTTP hooks. Measured on CLI
2.1.332 (2026-11-25): a `type: "http"` hook in `--settings` runs in `-p` mode
with `--setting-sources ""`; `PreToolUse` carries `tool_name`, `tool_input`
and `tool_use_id`, `PostToolUse` adds `tool_response`; an answer of
`permissionDecision: "deny"` stops the call and the model is shown the
reason; a call costs about 3 ms. When nothing answers, the call runs and the
stream carries `system` / `informational` with `tag: "hook_no_verdict"`,
which the worker reports and the watch counts.

Four things that are easy to get wrong:

- **A worker started without the hooks is a worker nothing is watching.**
  Settings for anything that runs tools come from `workerSettings`
  (`src/model/direct-env.ts`); a test fails for a spawn site that builds
  them another way.
- **Replay before changing a rule.** `bun scripts/watch-replay.ts
  persona/sessions --days 35` runs the tripwires over real transcripts. The
  first draft tripped on 46 of 753 turns from three mistakes (fetched data
  piped into the turn's own inline script, a long article URL, here-document
  bodies read as shell); the fixed rules trip on 7. A rule that fires on
  ordinary work teaches everyone to ignore it.
- **A model will not run an exfiltration for a test.** Asked to `cat` a
  secrets file and `curl` it somewhere, the worker model refused before the
  hook was consulted. A drill has to use commands that trip a rule and look
  harmless: a marker string that happens to be a canary's value, a profile
  file in the working directory.
- **`example.com` is a real host.** Only names ending `.example`, `.invalid`
  or `.test` never leave the machine. And a site is known as a whole
  (`siteOf`), so in a test each role needs a second-level name of its own.

It runs as the same user as the model. It catches mistakes and injections,
not something that already owns the account.

## Never relax the send-resolution guard
`chat_mismatch` is a **true positive**. Tested by relaxing it: sends went to the
note-to-self thread. It refuses because acting would reach the wrong person. If
it fires, fix the resolution, never the guard.

## chat.db is ground truth; IMCore's registry lies
The registry can hold a chat object whose identifier, participants and
recipient have all been relabelled with the account's own address while chat.db
is perfectly correct. Verify sends against chat.db, not against "sent".

## Don't `killall Messages` casually
The supervisor relaunches it, which masks crashes and makes attribution hard.
A temporary diagnostic that runs on every `resolveChat` will crash-loop the app
roughly every 30 seconds. `objc_copyClassList` + `class_getInstanceMethod`
across the runtime triggers `+initialize` on classes that can't tolerate it;
use `class_copyMethodList` on named classes instead.

## A turn worker must not outlive its daemon
Turn workers are spawned detached so the daemon can stop a worker's whole
tree, and a detached worker survives the daemon. It then finishes its turn and
sends it while the next daemon replays the same messages: on 2026-11-24 a
daemon that died 44 times in 26 minutes sent one person 17 messages for 2
requests. `src/model/turn-workers.ts` writes each worker down with its
daemon; a watchdog stops them when the daemon is gone and boot stops any that
are left. A new place that spawns a model process to run a turn calls
`trackTurnWorker`, and a test fails if it does not. Sub-agents and background
jobs are left out on purpose: they are meant to survive a restart.

Two things measured while building it. The CLI runs each Bash tool call in
its own process group, so a signal to the worker's group does not reach it;
the CLI stops its tool calls itself on SIGTERM, within about 50 ms. And once
the daemon is dead the CLI does not exit on SIGTERM alone, so the SIGKILL
that follows is what ends it.

## `process.ppid` does not notice a dead parent under bun
Bun keeps the value it first read (1.3.9, measured 2026-11-25), so a child
that reads `process.ppid` goes on naming a parent that has died. Ask the
system: `process.kill(pid, 0)` throws `ESRCH` once the pid is gone. The
watchdog was first written on `process.ppid` and never fired; the test that
caught it lets the watchdog run a while before killing the daemon, because a
first read made after the parent died does return the new parent.

## A Worker thread must not load a package
On Bun 1.3.9, what a worker thread adds to the runtime's process-wide module
cache dies once workers are created and terminated. The recall embedder was a
worker that loaded `@huggingface/transformers` and was let go after a minute
idle: the next one's import answered "Cannot find module" until the daemon
restarted (four outages, 364 turns without recall, 2026-10-30 to 2026-11-16)
or segfaulted the daemon (8 of the 13 crash reports in
`logs/services/launchd.err.log`). The package was on disk the whole time. Reproduced
outside the daemon on 2026-11-25: 5 of 30 processes. Bun 1.4.5 did not
reproduce it; 1.3.14 instead dies when a worker holding an ONNX model is
terminated, so "a newer Bun" is not one thing.

The embedder is a child process now (`src/memory/transformers-embed-child.ts`).
Anything that needs a package or a native addon off the main thread goes in a
process too; `tests/worker-thread-imports.test.ts` fails if a worker thread
loads one. `scripts/bun-worker-churn/check.ts` tests a Bun before the daemon
moves to it. The daemon moved to 1.4.5 on 2026-11-25; CI is pinned to match.

A Homebrew upgrade moves the binary to a new path. That does not cost the
daemon its privacy grants (Full Disk Access for `chat.db`, Accessibility,
Automation): launchd starts it through `/bin/bash`, which holds them, and a
1.4.5 binary at a path nothing had ever granted read `chat.db` under launchd
(measured 2026-11-25). Grants made to the `bun` path itself are keyed to the
versioned Cellar path and do not follow an upgrade, which matters only for a
`bun` started outside launchd and outside a terminal that has its own.

Two things about runtime crashes. The report is in `logs/services/launchd.err.log`,
not `daemon.log`; the boot after one now logs `[boot] the previous run ended
in a runtime crash`. And a report decodes without the vendor's site: the
`bun-darwin-aarch64-profile` release has the symbols, and the addresses in the
`bun.report` link are VLQs relative to `0x100000000` for `atos`.

## `[security]` is the trust policy; tests build partial configs
Host access, contact tier and the open-allowlist flags live in `[security]`
(`src/security/policy.ts`). The helpers fail closed when the section is
absent, because dozens of tests build `Config` objects by hand. A fixture
that relied on "empty allowlist admits everyone" now needs
`security.open_dm_allowlist: true`. The live config opts into the permissive
values explicitly; do not change those defaults to match it.

## Sandbox scripts import this checkout's source by path
The assistant writes scripts in its sandboxes, and some import harness source
by absolute path. Measured 2026-11-25 by searching every sandbox: 50 scripts
importing 54 names from 38 modules. Nothing in the repository can see them.
Knip reported `listPath` as unused while a sandbox script imported it, and
`integrations/kitchen/src/notesync.ts` was deleted with two scripts still
importing it. `tests/sandbox-api.test.ts` pins every module and name they
use, and is what tells knip those exports are used. Before moving a file or
dropping an export, check that list. Run the search again before changing it.

## A file that finds things from its own location breaks when it moves
About 25 files build a path from `import.meta.url`: the repo root, a sibling
worker, a script under `scripts/`. The compiler does not read path strings,
so a move to another depth compiles and then starts nothing. The two scripts
the daemon starts this way are checked in `tests/architecture.test.ts`; any
other needs reading by hand when its file moves.

## A loop that ends when someone else's answer changes
Found twice in one month from the log alone. The scheduler's drain asked the
store for the next due job until there was none, and at the autumn clock
change the next-fire arithmetic answered with a time already past: one hourly
job was launched 7.7 million times, the daemon answered nobody for 28 minutes,
and the log grew by 1.9 GB (2026-11-01). The printer link started a retry
loop on every drop report, and a failed attempt reported a drop: the loops
doubled each round, to 4,290 attempts a minute (2026-11-17). Both are fixed
at the cause and bounded at the loop. When a loop's exit depends on another
function moving something forward, bound the loop as well.

Cron arithmetic stays in absolute time. `setSeconds`, `setMinutes` and
`setHours` go through local fields, and in the repeated hour local fields
name the earlier of two instants.

## Logs: one line, two places, and hooks that are process-wide
`log.info(tag, …)` writes the line to `logs/daemon.log` and a record to the
tag's channel under `logs/` (`src/util/log-channels.ts`). A new tag
needs a channel there or `tests/log-channels.test.ts` fails. Outbound
requests, child processes and fatal exceptions are recorded by hooks installed
with the log sink (`src/util/log-instrument.ts`): `node:child_process` runs
on `Bun.spawn` and `Bun.spawnSync` (measured on Bun 1.4.5), so wrapping those
two sees every spawn, and `tests/log-instrument.test.ts` fails if a later Bun
changes that. The fetch wrapper returns a promise that rejects exactly as the
original does; a version that swallowed the rejection would keep a process
alive that used to exit.

Never record a header or a body, and never a request's query string: paths
go through `safePath` and command lines through `describeCommand`. The one
place a query is kept is `browse`, where it is often the page; it goes
through `loggableUrl`, which hides the values of credential-like parameters.

A path built under the data folder needs an entry in
`src/util/data-layout.ts` (`tests/data-layout.test.ts`), and nothing goes
loose at the top of it: databases in `db/`, files rewritten at every start
in `run/`, tokens in `secrets/`, small durable files in `state/`, a feature's
own files in a folder named for it. Logs are not in `data/` at all; they are
in `logs/` at the top of the checkout. A service refuses to start on a data
folder still in the old flat layout (`edmund data migrate`): opening
`db/state.db` beside an unmoved `state.db` would be two copies of the state.

## stdout is sacred in MCP servers
`src/mcp/server.ts` speaks JSON-RPC over stdout. A stray `console.log` corrupts
the stream. `protectStdout()` redirects the console to stderr; don't remove it.
An unsupported zod type in a tool schema publishes an **empty** schema and the
model then guesses the call shape.

---

# PART 2 — Architecture worth knowing

**Two repos.** This one (TypeScript/bun) and `imcore-bridge` (an Objective-C
dylib injected into Messages.app plus a TypeScript client). The harness pins
the bridge's GitHub release tarball, so an ordinary `bun install` needs only
this checkout.

**Working on the bridge itself** needs the sibling checkout back in the loop,
because the pinned tarball is a fixed version. Point the two files that matter
at it and a native rebuild again takes effect on the next Messages launch with
no install step:

```bash
ln -sfn ~/imcore-bridge/native/build/imcore-bridge.dylib \
        node_modules/imcore-bridge/native/build/imcore-bridge.dylib
ln -sfn ~/imcore-bridge/dist node_modules/imcore-bridge/dist   # only for client changes
```

`bun install` overwrites both, so redo them after one. Ship bridge changes by
cutting a bridge release and bumping the URL here; a local symlink is not a
state anything else can see.

**Modules are layered, and a test holds the layering.** A folder under `src/`
imports at runtime only from itself or from a lower layer
(`tests/architecture.test.ts`, list in `docs/architecture.md`). `model/`,
`claude/` and `codex/` are one module: the contract and dispatcher, and the
two backends. `cron/` is the job store everything writes to; `scheduler/`
runs a job when it fires. Until 2026-11-25, 20 of the 48 modules formed one
dependency knot while the files held only two import cycles: the files were
sound and 26 of them were in the wrong folder.

**Prompt composition, roughly per turn:**
- system prompt in the low tens of thousands of tokens (it was almost double
  that until SOUL.md was archived on 2026-08-28)
- person file for that conversation (several thousand tokens for an active one)
- recall injections, conversation history

**Person files are per-conversation. SOUL.md is EVERY turn of EVERY
conversation.** A token in SOUL costs roughly fifty times a token in one person
file. That asymmetry is the single most important budgeting fact in the repo.

**Memory layers (as of 2026-08-28):**
| layer | scope | in prompt? | written by |
|---|---|---|---|
| SOUL.md | global | every turn | `remember_about_self` |
| person file | one chat | that chat's turns | maintainer (auto) |
| operating principles | one chat | that chat's turns | consolidator (auto) |
| domain notes | global | via recall only | `remember_about_subject` |
| archives | none | via recall only | archiver (auto) |

**The maintenance pipeline order is load-bearing:**
`append observations → CONSOLIDATE → archive`. Consolidating after archiving
derives a person's rules from a file the archiver already thinned. A test pins
the order; the failure is silent otherwise.

---

# PART 3 — Cost shape

Measured across four months of daemon logs: **cost per turn climbs steeply with
context size**, and the top bracket costs several times the bottom one. A
compaction roughly **doubles the cost of the next turn**, because it rewrites
the prompt prefix and turns cheap cache reads into expensive cache writes.

Therefore: never "just raise the compaction threshold." The lever is shrinking
fixed overhead, not carrying more context. Compaction at a fraction of the
model's window looks absurd and is actually correct cost control. The actual
figures are in `CLAUDE.local.md`.

---

# PART 4 — The three big fixes, and the bug shapes behind them

## A. Sends were misrouting (root cause found 2026-08-28)

`[IMChat sendMessage:]` wraps `_sendMessage:adjustingSender:shouldQueue:` with
**adjustingSender:YES**. On macOS 26 that makes Messages rewrite the chat's own
recipient after the send: `__kIMChatRecipientDidChangeNotification` fires and
the chat's identity becomes the account owner's address. The message that
triggered it arrives fine; the **next** one misroutes. Hence every-other-message
failure, and the sidebar showing the owner's own name on someone else's thread.

Fix: dispatch through `IMChatRegistry _chat:sendMessage:`. Not
`adjustingSender:NO` directly: independent reverse engineering (openclaw/imsg)
found that path "may silently drop items in some macOS 26 states", and a
dropped message is worse than a relabelled chat the guard catches.

**How it was found:** diffing `/usr/bin/log show --predicate 'process ==
"Messages"'` between a bridge send and the same message typed by hand in the
UI, from an identical starting state. Three attempts at guessing selectors
failed first. This is undocumented anywhere online.

## B. The recurring bug shape: a size gate that can never reach its target

Found **three times** in one day:
1. Person files: `Open Items` was 66% of the file and exempt from archiving
2. SOUL.md: the archiver's `^##\s+` regex cannot match a `###` heading. Every
   `###` subsection was invisible, and one grew to half the system prompt while
   the gate reported nothing to do
3. Person files again: `Our Dynamic` was exempt while being exactly what the
   new principles layer replaces

**Shape: "the limit can't be reached because the dominant content is exempt."**
When you fix one, search for siblings.

## C. Memory accumulated but never became judgment

Every learning path was append-only. Files got longer, never wiser: one had 105
observations, three of which separately circled the same rule without ever
becoming it. An observation reaches a reply only through semantic recall, so
the majority of turns that use no tools get none of them and read generically.

Fix: a consolidation pass asking a different question ("what are the RULES, and
which did today contradict") that may rewrite, merge and retire. Ten rules from
105 observations, in about twenty seconds. It is net token-negative once
coupled with archiving the section it replaces. Grounded in prior art:
Generative Agents (reflection with citations), ReasoningBank (distilled
strategy), MemGPT (core vs archival memory).

---

# PART 5 — Design principles this codebase already holds

These are in the memory files and the code comments. They were earned:

- **Model-driven features, not automation.** Improvements should be things the
  model wields, not background housekeeping.
- **Never suppress a reply programmatically.** Fix double-replies with
  bookkeeping and context, never by blocking the model from speaking.
- **No emojis in any UI.** Text labels or CSS icons.
- **Lapsing is the design constraint.** Tools die when staying current becomes
  work. Never require input to stay true.
- **Derive from the keyed source**, never from prose a model filled in.
- **Careful producer, trusting consumer is not a boundary.** Validate where the
  value is used.
- **A guard taken on one path is not a guard.**
- **Verify against the system of record.** "Sent" is a claim; chat.db is the
  outcome. A test that cannot fail is a decoration: break the thing it guards
  and watch it go red before trusting it.

---

# PART 6 — Publishing hygiene

- Real handles, names, addresses and coordinates never go in tests, skills,
  docs or example config. Use `+1555…` numbers, `example.com` addresses and
  `bot@example.com` for the bot's own account.
- Deployment specific docs go in `docs/private/` (gitignored). Guest campaign
  briefs go in `campaigns/` and only `campaigns/example.md` is tracked.
- Before a push: `git diff config.example.toml`, and `git status` for anything
  under `docs/private/`, `campaigns/`, or a root-level image.
