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
a mixed state: sweep `persona/` and `data/state.db` session bindings too.

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
the count.** `bun test` at the repo root also picks up a stray vendored Chrome
extension's specs; use `bun test tests/`.

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

## `[security]` is the trust policy; tests build partial configs
Host access, contact tier and the open-allowlist flags live in `[security]`
(`src/security/policy.ts`). The helpers fail closed when the section is
absent, because dozens of tests build `Config` objects by hand. A fixture
that relied on "empty allowlist admits everyone" now needs
`security.open_dm_allowlist: true`. The live config opts into the permissive
values explicitly; do not change those defaults to match it.

## stdout is sacred in MCP servers
`src/mcp/server.ts` speaks JSON-RPC over stdout. A stray `console.log` corrupts
the stream. `protectStdout()` redirects the console to stderr; don't remove it.
An unsupported zod type in a tool schema publishes an **empty** schema and the
model then guesses the call shape.

---

# PART 2 — Architecture worth knowing

**Two repos.** This one (TypeScript/bun) and `imcore-bridge` (an Objective-C
dylib injected into Messages.app plus a TypeScript client). During development
`node_modules/imcore-bridge` is a link to a sibling checkout, so a native
rebuild takes effect on the next Messages launch with no install step.

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
