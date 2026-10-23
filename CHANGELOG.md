# Changelog

## 0.3.10

### Patch Changes

- ed3c185: Sub-agents are stopped when they go quiet, not when they turn fifteen minutes old, keep what they found when stopped, and report to their parent once.
  
  - **The reaper judges output, not age.** It stopped every agent 15 minutes after spawn. Of the 35 it reaped, the 33 with logs had all written output within the last 151 seconds (29 within the last minute), so it was killing work in progress. The runner now stamps a heartbeat on each line its CLI prints, and the reaper stops an agent after 15 minutes without output or at a 90-minute cap. Finished agents ran at most 18.3 minutes and went at most 482 seconds without output. The in-runner team sweep no longer fails teammates that are still working.
  - **A stopped agent keeps its partial result.** The runner died on SIGTERM without writing anything. It now writes its last output with the reason it stopped, and the parent is told that reason.
  - **One report per agent, one per team.** The runner's exit, its SIGTERM handler, the reaper, a spawn failure and cancel could each settle the same agent and wake the parent. The row is now claimed atomically and only the claimant reports; a team's team-done is claimed the same way. A runner whose row was settled before it started does not start the model.
  - **Cancel stops the CLI too.** `cancel_agent`, `cancel_team` and `edmund agents cancel` signalled the runner's pid only; they now stop its process group.
  - **Completions that land together wake the parent once.** 85 of 234 completion wake-ups since May arrived within two minutes of another for the same chat, up to 19 in a row, each a full turn. A completion now waits 20 seconds for others (at most 90 seconds after the first) and they arrive as one event. Replayed over those 234: 49 fewer turns.
  - **A sub-agent's background job runs inline.** Its wake-up went to an `agent:` session that does not exist (262 times, all skipped) and the agent polled `check_bg_job` instead. Every such job finished within 62 seconds.
  - **A bad `agent_model` is named as such.** Ten agents failed at start on a model the CLI could not use, one of them the misspelled `claude-sonnet-5.5`. A malformed id is refused before anything spawns, and an unavailable one is reported as the configuration problem it is, not as a failed task.
- ed3c185: Follow-ups to the sub-agent lifecycle change.
  
  - **Dashboard cancel works again.** It still called a store method the lifecycle change removed, so cancelling from the dashboard returned an error and left a pending agent running. It now takes the same path as `cancel_agent`, and the overview counts stuck agents by the reaper's own limits.
  - **A follow-on the daemon spawns gets the configured agent settings.** When the reaper settled a team's last member, the deep-research synthesizer it spawned ran on the default model, without plugins and under the wrong host-access policy, because the daemon's environment lacks the settings only MCP children get. The daemon now starts it from the same environment an MCP child of that conversation would have.
  - **A stopped agent's result always says it was stopped.** When the CLI's exit reached the runner before its own SIGTERM, the result was written without the note, and the parent heard "stopped" while reading what looked like a complete result.
  - **A team's synthesizer is always reported.** Two members settling at once could both see the team finished; one spawned the synthesizer while the other sent team-done before the synthesizer existed, and the synthesizer's result was then never reported. The follow-on and team-done decision is now taken under one lock.
  - **Stopping kills the right process.** The reaper and cancel stopped the pid they had read before settling, which could be empty for an agent that had just started; they now stop the process the settle found, and the reaper's "never started" no longer lands on an agent that has started.
  - **A long tool call does not look like a hang.** A sub-agent prints nothing while a tool runs, and its background tools now run inline (a video render polls for up to ten minutes), so the reaper could have stopped a healthy agent for silence. The agent's heartbeat is kept while its tool call runs.
- c1d5e08: A conversation that Claude's safeguards refuse now moves to a fresh thread and gets answered, instead of failing every turn, and a failed `/compact` is reported as failed.
  
  - **A refused Claude thread is dropped.** The CLI already retries a flagged turn once and then falls back to the previous Opus. When the fallback's safeguards flag it too ("Opus 4.8's safeguards flagged this message"), the judgment is about the thread's whole history, so resuming it fails the same way. That error used to classify as `unknown`, so recovery retried the same thread; one DM failed four turns running. It now classifies as `thread_refused`, the class the Codex safety refusal already used. `runModel` forgets a refused thread for both CLIs, shuts down the warm worker still holding it, and keeps the caller from restoring the id. Recovery then answers on a fresh thread with the recent chat.
  - **No retry on the refused thread.** The Claude runner's in-band heal no longer drops the thread and then resumes that same id. The `thread_refused` healer also evicts the warm worker, because the pool reuses a session's worker whatever id the next spawn asks for.
  - **A failed `/compact` is a failure.** The CLI ends a failed compaction with a success result whose text is `Error during compaction: ...`, so the pool logged `/compact ok` and auto-compact logged "applied". Seven compactions of one DM failed that way while its context grew from 209k to 259k. The worker now reports that text as a failure, and a refused compaction re-anchors the thread instead of retrying it every turn.
- b6d3ad1: Messages of about 42 bytes decode exactly, and group chatter Edmund was never asked about no longer counts as a reply he owes.
  
  - **The decoder no longer reads the type tag as a length.** macOS writes the visible string as `NSString 01 94 84 01 2B <len> <utf8>`. The decoder scans offsets after the marker and keeps the longest valid slice, and the `+` (0x2B) tag is itself a valid one-byte length of 43. Read that way it yields the length byte plus the first 42 bytes of text, which ties a 43-byte message and beats a 42-byte one, and also beats any longer message that trims below 43 characters. The fallback notice read back as "+hit a snag getting back to you, still on i". Candidates whose prefix follows the tag are now preferred; payloads without it keep the old rule. Run over the 50,531 rows of a live chat.db, 842 decode differently, all corrections: 802 had a framing character glued to the front, and 40 short messages ("? ") had been replaced by the attribute token "iI". No row decodes worse.
  - **A group row with no routing record is nobody's.** `ownsRow` treated an unrecorded row as owned by the main session, a default meant for old DM rows. In a group, every accepted row is recorded (live path, catch-up, address check), so an unrecorded one is the group talking among themselves. It was fed to recovery turns and counted toward the fallback notice, which sent "hit a snag" into a group nobody had asked anything. Group sessions now require the record; DMs are unchanged.
- ed3c185: A resumed conversation sees today's memory, recall no longer stalls the daemon, and the docs stop describing a write guard that never ran.
  
  - **Resumes render the current prompt.** Since about CLI 2.1.287 a conversation recorded its system prompt on the first request and resent that record on every resume until it compacted, ignoring the prompt the harness passed. The person file and SOUL.md are in that prompt, so over 7 days (2,330 turns) the median turn ran on memory 1.7 h old, the 75th percentile 13.6 h, and 13% of turns on memory over a day old. Workers now pass `--system-prompt-snapshot off`; an unchanged prompt still reads from cache, and a persona edit reaches a cold resume on its next turn again.
  - **The daemon keeps its recall cache.** It was evicted after 10 idle minutes and reloaded in one synchronous block, up to 31 s from a cold disk: 19% of turns over 14 days waited more than 5 s, every other chat with them. The daemon now keeps it and loads it at boot in slices (longest block 0.9 s on the live index). The cache no longer holds row text, which only the returned hits need: 0.6 GB instead of 1.4–1.6 GB, and searches run in 21–109 ms instead of 80–323 ms.
  - **No phantom guard.** `.claude/settings.json` declared a write guard and a media-delivery hook. Workers read project settings only from their own sandbox, so neither ever ran, while the docs, comments and the prompt ("A path guard rejects Write/Edit/Bash mutations outside the sandbox") said it did. Enabling it would have blocked about 1,200 of 20,000 worker writes a month, much of it ordinary work in `/tmp`, and the delivery hook would have double-sent media the model already sends. Both are removed and the text describes the real boundary: `disallowedBuiltinTools` and the MCP server's path checks.
  - **Ghost outcomes read every chat of a person.** The outcome sweep looked for a reply only in the chat row the session recorded, so a reply from a person's other address scored the fire as ignored.
  - **A bad `agent_model` shows at boot.** The startup self-check validated only the main model; a malformed sub-agent model surfaced as one failed `spawn_agent` after another.
- ed3c185: The ghost looks at chats once a conversation has settled, spreads its sweeps across every enabled chat, and its pre-screen judges with the ghost's own calibration.
  
  - **Settled ticks instead of post-reply ticks.** A reply used to schedule a ghost tick 60-120 seconds later. Over 2026-10-09..23, 288 of 394 ticks landed within 2.5 minutes of Edmund's own message, and the pre-screen declined nearly all of them as mid-conversation. The tick now waits until the chat has been quiet for 30 minutes (the gap that splits conversation episodes), re-arming while it isn't.
  - **Sweeps reach every chat.** The observer kept tick history in memory, so each restart (16 in those two weeks) made every chat look never-ticked and the sweep fell back to list order. 30 of 58 enabled chats got no sweep in that window. Each decision now records what triggered it, and the observer rebuilds its history from the decision logs at start.
  - **The pre-screen judges like the ghost.** It decided 371 of 381 verdicts on four generic lines, so the intensity setting never reached it. It now reads GHOST.md with the operator's intensity clause, minus the sections about tools, workspace and scheduling and any rule that names `submit_decision`. It no longer receives the full tick's `submit_decision` directive and workspace paths: given them, it called ToolSearch 70 times and edited the ghost's notes. A pre-screen with no usable verdict still lets the tick run, but it is logged and stamped on the decision (`prescreen: "failed-open"`). GHOST.md without the `{{eagernessClause}}` placeholder (the shipped template) now gets the intensity clause appended.
  - **The full tick names its tools:** ToolSearch (19 of 20 ticks needed it to load `submit_decision`), Read, Write, Edit, Glob, Grep, WebSearch and WebFetch. No Bash.
  - **The ghost sees the right end of long files.** Person files were cut to their first 4000 bytes, which dropped Open Items in 14 of the 15 files over that size. The excerpt (7000 chars) now keeps every section and names the file's path. Open Items keeps every undated item and then the newest dated ones. Ghost notes keep their standing sections (what it is watching, what it leaves to others, its plan) and then their dated entries newest first, wherever they sit in the file. Across the live files: 35 of 35 undated open items, 27 of 27 standing note sections and every newest dated entry are kept.
  - **Pacing reads as a status.** The prompt printed the effective cooldown hours even after the cooldown had cleared, and 42 of 393 decisions declined on "the 108h cooldown applies". It now says the cooldown is clear and how much of the weekly cap is used.
  - **Only messages that reached the person pace the next one.** Vetoed fires, errored fires and fires interrupted before delivery no longer start a cooldown, count toward the weekly cap or the 48-hour spacing, or hold the one-open-thread gate. An interrupted fire had held one chat's gate since 2026-07-28. Those labels come from what the send path reported, so a fire is excluded only when chat.db (or the SMS store) shows nothing Edmund sent in that chat within 30 minutes of it; when the chat can't be read, it counts. When Edmund wrote first in that window, the fire is saved as delivered and pending, so the one-open-thread gate holds and the outcome sweep scores it (one live fire from 2026-07-30, labelled vetoed, had in fact sent its message 8 minutes in). The send-time recheck of a queued brief reads the same evidence.
  - **A group counts as settled from its own messages.** The settled tick measures quiet from the chat's newest message, so unaddressed group chatter keeps it waiting.
- ed3c185: Edmund's model calls no longer read the operator's own Claude Code setup, and DM sessions the relay created carry their real chat guid.
  
  - **No operator instructions in Edmund's prompt.** Every Claude Code process the harness starts ran inside this checkout and read the CLAUDE.md files found walking up from its cwd (the repo's developer notes and `CLAUDE.local.md`), `~/.claude/CLAUDE.md`, the auto-memory index and the user-scope plugins. Measured 2026-10-23: about 25k tokens of that reached every cold turn, in DMs and groups. Turns, sub-agents and one-shots now pass `--setting-sources ""` and state what they need in `--settings` (auto-memory off, thinking on as before).
  - **One-shots run without tools they never needed.** The ghost, pre-screen, maintainer, consolidator, curator, catch-up, planner and eval calls read text other people wrote, with `bypassPermissions`, every built-in tool and the operator's MCP servers and claude.ai connectors (Google Drive and Stripe among them). They now load only the MCP servers they name and no built-in tools unless they name them (catch-up keeps `Read` for attachments; the ghost tick, which has its own MCP config, is unchanged). Their transcripts are no longer written into the operator's project history.
  - **DM sessions the relay created are visible again.** The relay stored a bare handle as the chat guid when it pre-created a DM session, and nothing corrected it. Seven sessions (six active) were invisible to the person-file maintainer, the ghost's outcome scoring and the recovery sweeper. The relay now stores the chat.db guid, an upsert replaces a bare handle with the real guid, and boot repairs existing rows from chat.db.
- ed3c185: Operating principles keep being re-derived, person files get back toward their size target, rewrites lose nothing, and the skill curator can revise what it wrote and tells people apart.
  
  - **Consolidation is no longer pinned by the archiver.** The trigger counted the live file's observations, and once a file is over the size gate every pass archives about as many old bullets as it adds, so "12 new since the last pass" never arrived. On 2026-10-23, 6 of 9 chats with principles were stuck; the operator's DM archived 1-5 bullets on nearly every pass and had not consolidated since 10-02. The trigger and the stamp now count live plus archived observations. On a copy of the live files, 11 of 22 files with principles are due on their next pass. The pass is shown the observations archived since the last one, a principle whose evidence was archived is not retired for that, and a pass that finds no rules keeps the standing ones and stamps instead of rerunning on every maintainer pass.
  - **The size gate can reach what it protects.** Its recency floors were bullet counts set for the maintainer's 140-character notes; notes now run 235-625 bytes, so the protected tail alone was about five times the target and live files sat at 20-54 KB. The history sections now keep that many notes' worth of bytes (never fewer than the newest three bullets). Open Items is protected by age instead: an item stays while it is under 14 days old, up to 40, because nothing marks one closed and size is no reason to drop a commitment. Group Open Items joins the archivable sections, as it did for person files: it was the largest section of the biggest group files (87 items, 8 of them under 14 days old). On a copy of the live files: 573 KB to 435 KB across 99 files; the operator's DM 40 KB to 33 KB (all 40 open items are under 14 days old and stay); the largest group file 34 KB to 18 KB.
  - **A full rewrite loses nothing.** The maintainer's rewrite kept the old file only as `.bak`, which the next rewrite overwrites; two rewrites on 10-22 dropped 45 and 41 observations that were then nowhere else. The file is re-read just before the write, notes the live turn appended during the model call are merged in, dropped dated bullets go to the archive first, and a file edited in any other way meanwhile is left alone and retried. A model-requested `write_person_file` is unchanged, because it may be removing something a person asked to forget.
  - **Consolidation has its own model knob.** `[people_maintainer] consolidation_model`, empty by default (the append pass's model, so no cost change).
  - **The curator can apply a revision.** The edit path accepted only self-authored skills, so every "revise" verdict was rejected. The review may now rewrite a curated skill when the asks behind the verdict clear that same bar, and after the same leak scan a new curated skill passes; a conversation still cannot edit one.
  - **The curator waits a full interval at its ceiling.** A pass stopped by the 12-skill ceiling did not stamp the clock, so the whole pass reran every hour from 10-22.
  - **The curator counts people as well as chats.** One person asking in five chats passed as five; that is how one family's project became a global skill on 10-16 (7 refs, 5 chats, 1 sender). Evidence must now come from two people who, as far as chat.db shows, do not share a room: neither asked in a chat the other is in, counting silent group members. Two members of one family group plus one member's own DM no longer pass. A person is resolved through the operator's saved contact names as well as `[[contacts]]`, sampling is capped per person, and the prompt tells people apart by opaque ids. Ten of the 12 live curated skills clear the bar; the family skill from 10-16 does not.
- ed3c185: What a turn shows the model is accurate again: recall is on-topic, group turns see what was said, and times, attachments and tools are described as they are.
  
  - **Recall without keyword noise.** Unprompted recall let a keyword match in under the 0.7 similarity floor. Replaying 128 real inbound messages: 15 hits a turn, 86% of them under the floor (median 0.57), matched on a shared word. Recall now holds every hit to the floor and uses the keyword ranking only to order them: 3.3 hits a turn, none under the floor, a fifth of the characters. `semantic_search`, which the model calls and reads scores from, keeps the rescue.
  - **Group turns see the room.** "You haven't replied in this thread yet" sat above Edmund's own reply in 39% of group turns, because the send was stamped after chat.db dated it; it is now read from the thread's rows. A message folded into a running turn is labelled with its own writer, not the turn's first sender. Recall in a group picks up where the shown thread starts, so earlier same-day chatter is no longer in neither. A scheduled or proactive wake-up into a warm group carries what members said since the last turn (32 of 66 fires had missed it); every successful turn now records when it started, so a scheduled reply sent as plain text counts as a turn. A session Edmund posted in recently is no longer reset as idle because nobody wrote to him for three days.
  - **Times read the same everywhere.** Scheduled events state their times in Eastern instead of UTC, history lines older than six days carry their date, and `schedule_reminder` takes a bare ISO timestamp (32 of 47 logged failures), reading one without an offset as Eastern.
  - **No false promises.** The prompt no longer promises `chrome-devtools` on every turn (43 of 101 lookups failed): it says they load with a turn that carries a link or asks to browse, how to get them for a task, and guest and trading sessions are told there is no browser. The text is the same on every spawn, so moving between workers with and without the browser does not rewrite the cached prompt. An attachment that never finished downloading is described as not coming, instead of promising a follow-up turn that never ran.
  - **One-shots keep their effort.** Background model calls took their effort from the operator's own settings file; with that file out of the picture they now take `[claude] effort`.

## 0.3.9

### Patch Changes

- d6f53a4: SMS conversations stop looking empty to the history tools and proactive outreach, scheduled reminders into a group say who is in it, and people without a contact entry can be named.
  
  - **History tools read the SMS transcript.** `get_thread_context`, `search_history`, `get_message` and `catch_me_up` asked chat.db, which has no rows for a Twilio conversation, so an SMS group holding dozens of messages answered "no earlier messages in this chat". They now read the SMS store for `sms:` sessions. `list_attachments` says SMS media is not downloaded instead of reporting none.
  - **Proactive outreach reads it too.** The ghost judged an SMS group a "fresh session with zero message history"; it now gets the transcript, and an SMS DM no longer borrows that person's iMessage reactions and attachments.
  - **A cold wake-up into a group carries the roster.** Scheduled, proactive and recovery wake-ups had the recent thread but not the `Participants:` line an inbound turn gets, so a reminder could address someone who had only been talked about. Inbound turns and wake-ups now share one roster helper.
  - **`name_person`** records what someone goes by when no contact entry names their number. Rosters and transcripts then show `Pat (+1…)` instead of a bare number. A learned name is display-only: it never answers `displayName`, which decides SMS admission. It cannot reuse a contact's name or name Edmund's own addresses, and it is vetted to letters, spaces and basic punctuation.

## 0.3.8

### Patch Changes

- 1bf4358: Offer a kitchen on the first food question, explain it at setup, and follow up through the first week.
  
  - **The offer is actually made now.** A chat with no kitchen used to get an error from every kitchen tool, carrying an offer gated on "the second or third time" somebody asked. Between 2026-08-17 and 2026-10-20 that error came back 43 times across about 30 food questions from 7 chats, and the offer was made twice. Now the tools answer normally: answer the question in full first, then offer in the same message, with what it is, what they get and what it takes.
  - **Never hold the answer back for setup.** The old text said not to answer "from nothing", and the one time it was followed somebody waited 46 minutes for a bake time.
  - **Asked at most twice, and a no is final.** `data/kitchen/prospects.json` records food questions, offers and a no (`kitchen_onboard action:"decline"`). An unanswered offer is made once more after a week, then never. An offer that chat.db shows never reached the chat does not count.
  - **Small groups.** A group of two or three is offered a kitchen only when Edmund judges they share one, such as a couple; a bigger group never is. `start` in a group also links each member's own chat, unless they already belong to a kitchen.
  - **How it works, at setup.** When the link goes out, Edmund explains the one habit (a photo of the receipt), that they can just ask what to cook, and that there is nothing to keep up.
  - **First-week check-ins.** `start` queues three wake-ups in the chat where setup happened: day 1 a dinner from their shelves, day 4 a receipt nudge, day 7 a short recap with an offer of dinner texts. Each reads the ledger when it fires (`kitchen_onboard action:"checkin"`) and stays quiet when it is no longer needed.
- 1bf4358: Security updates for three advisories at high: `@modelcontextprotocol/sdk` 1.32.1 (experimental tasks were not tied to the session that created them; one request within the default size limit could exhaust server memory during validation), and `launch-editor` 2.14.2 via override, reached only through `@changesets/cli` (an existence check bypassable on Windows). The main, computer-use and ghost MCP servers publish byte-identical tool lists under the new SDK.

## 0.3.7

### Patch Changes

- 0539756: Pin imcore-bridge 0.2.4, so a fresh install gets message edits that land on macOS 26. The daemon declares an edit's compatibility text as `NSAttributedString` and silently dropped edits that sent an `NSString`; the bridge now passes the class the daemon declares.

## 0.3.6

### Patch Changes

- 5aeffc2: Recover from a thread the provider refuses, stop overlapping recovery sweeps, and load Claude Code plugins into workers.
  
  - **A refused thread is dropped, not retried.** "This request was blocked by our safety systems" now classifies as `thread_refused`. The Codex runner forgets the thread the moment a turn is refused, and a healer drops one that was stored anyway, so the next turn starts fresh instead of failing the same way on every resume.
  - **A cold recovery turn carries the recent chat**, the way scheduled wake-ups do, so a turn whose thread was dropped knows what was being discussed.
  - **One recovery per session at a time.** A sweep that started during another's recovery turn used to answer the same messages again once the lock freed.
  - **Recovered messages lose their inbound acks**, so a restart inside the ack window cannot replay them as "you were offline".
  - **`[claude] plugin_dirs`** loads Claude Code plugins into every Claude worker and sub-agent that has a shell. Sandboxed and guest workers get none. A directory without `.claude-plugin/plugin.json` fails the boot.
  - **Security updates** for four advisories at high or critical: `@modelcontextprotocol/sdk` 1.31 (OAuth client could send credentials to a server-chosen authorization server), `proxy-addr` 2.0.8 (IP spoofing through IPv4-mapped IPv6), `sharp` 0.35.5 (librsvg CVE), and `shell-quote` 1.12 via `concurrently` 10.0.6 (command injection in `quote()`). Every MCP server publishes byte-identical tool schemas under the new SDK.

## 0.3.5

### Patch Changes

- e4773eb: MCP servers can be added to the assistant's workers from config, and the sky camera now uses one.
  
  - **`[mcp_servers.<name>]` in `config.toml`.** Workers run with `--strict-mcp-config`, so a server added with `claude mcp add` never reached them.
    - A configured server supports `http`, `sse` or `stdio`, and headers for a bearer token.
    - It goes to operator sessions by default. Add `tiers = ["operator", "contact"]` to reach contacts too.
    - Guests never get one, and names the harness uses itself are refused.
    - The Claude and Codex runners choose the loadout through one function.
    - The generated `data/mcp*.json` files are now mode 0600, since they can hold tokens.
  - **The `skycam` skill uses the openskycam MCP.** The sky camera's recordings now live on openskycam (SkyVision). The rewritten skill covers:
    - a photo of now from the newest recording, one to three minutes behind;
    - photos of past moments, footage, detections, and workflow runs.
  
    It downloads a frame and sends the file rather than pasting a signed link. The old `skystream` skill and the `snap.sh` / `sky.sh` scripts are removed.

## 0.3.4

### Patch Changes

- 83e95c9: The group missed-name check now wakes the assistant less often by mistake, and a string of misfires can't feed itself.
  
  - **Messages that open with another member's first name.** Jev is told when a message starts with another member's first name. It gets only that fact, never the name. Senders reach Jev as letters, so it had no way to know "Sam, who's playing Sunday?" was said to Sam.
  - **Right after he has spoken, both scores must be high enough.** "Wants a reply" must reach 0.7 (it was 0.6), and "said to him" must now also reach 0.5. Over 840 labels, wrong wakes fell from 29 to 8, and real messages caught went from 87 to 82 of 100.
  - **A budget per run of un-named wakes.** Each wake right after he has spoken costs 1 minus how often a message with that score was really for him. The rate comes from a measured table: Jev's scores are not calibrated on this question, and a 0.75 was right about half the time. A run stops once it reaches `streak_budget`, 0.6 expected wrong wakes. A confident back-and-forth barely spends it. The budget resets when someone says his name or swipe-replies to him. The streak is read back from chat.db and the decision log, so a restart loses nothing.
  - **He sees the run.** His note says how many times in a row he has been woken without his name.
  - **Calibration.** `scripts/addressing-calibrate.ts` writes the measured table for the current question wording.
  
  New config keys: `addressed_floor` and `streak_budget`. The approach is in `docs/group-addressing.md`.

## 0.3.3

### Patch Changes

- 76c7713: After a restart, live messages are answered while the boot catch-up is still running. Before, the watcher started only after every catch-up turn had finished. On 2026-09-24 two long turns in one DM kept every other chat unanswered for 87 minutes.
  
  Catch-up now:
  - reads the backlog and writes a durable ack for each row;
  - hands the watcher its cursor at once, and runs the turns in the background;
  - merges each chat's orphans and backlog into one turn;
  - adds a live message to its chat's catch-up turn if that turn hasn't started, so the chat is answered once, oldest first.
  
  The recovery loops still start only once catch-up has drained.
- 76c7713: Scheduled fires for one chat no longer hold up other chats. Before, the scheduler waited for each fire, a whole model turn, before starting the next. On 2026-09-25 a 38-minute background-job turn in one DM delayed the mirror's severe-weather check by 34 minutes, so it was skipped as stale. Each session's fires still run one at a time, in order.
- 96fa970: Experimental `[group_addressing]`, off by default. It lets a group message through when it's meant for the assistant but doesn't say his name. Code picks the candidates: a swipe-reply to one of his messages, a word within two letters of one of his names, or a message soon after he spoke. Jev (`typesafe/jev-1.13` on OpenRouter) decides whether each one is for him. A message it lets through reaches his turn marked as un-named, and he still decides whether to answer. `"shadow"` mode only records decisions, to `data/addressing.jsonl`.
  
  On the hand labels, a 0.6 threshold caught 37 of 49 missed messages and woke him wrongly for 17 of 708 other messages. `scripts/addressing-calibrate.ts` reruns that measurement after the wording or model changes.
  
  Swipe replies now carry their parent. iMessage stores the parent in `thread_originator_guid`, which the watcher never read, so every inline reply arrived with no parent: 91 of 91 in 90 days.
- 76c7713: The `remember_about_subject` `outcome` field now says it takes one word: worked, rejected, mixed or untested. The story goes in `learned`. The `remember_about_person` `section` field now lists its five sections and says preferences go in `what-ive-learned`. Edmund had been writing a sentence as the outcome (8 times since 2026-09-19) and naming a "preferences" section that doesn't exist.
- 76c7713: The recall index's keyword (FTS) table is repaired only by the daemon, and the repair runs as one transaction. Before, every process that opened the store, including each MCP server and each generated image, rebuilt the table whenever the counts disagreed. Those rebuilds ran without a lock timeout and outside a transaction, and they interleaved with the daemon's writes. On 2026-09-24 the rowid map held 933 entries for 104,658 rows, so updates added duplicate entries and each `semantic_search` took 5–34 s.
  
  What changed:
  - The store opens through `openDb`, which sets `busy_timeout`.
  - The boot check also catches a same-sized map that points at the wrong documents.
  - The indexer skips `pending.json`, which the kitchen drain rewrites every pass, so it no longer re-embeds three files a minute.
- 76c7713: A turn is no longer ended by a result that belongs to a turn the CLI started itself. When a session is resumed after its last process was killed with a background shell running, the CLI first delivers a "stopped" notification as its own turn and prints a result with `num_turns` 0. That happens before it reads our message. On 2026-09-25 that result ended a turn after 1 second. The model kept working untracked, and the memory governor evicted the "idle" worker in the middle of a render.
  
  Workers now:
  - pass `--replay-user-messages`;
  - stamp each message with a uuid;
  - skip a result with `num_turns` 0 that arrives before that message's echo.
  
  This applies to both the resident worker and the per-turn process.
- 96fa970: The spend ledger now books each turn's actual cost. The Claude CLI's `total_cost_usd` is the running total for the whole model session, carried across process restarts. Turns, cron fires and proactive fires resume a conversation, and they were booking that total as each turn's cost. One DM logged $99.03 for a turn that cost $0.11, and the ledger summed to 4-11x the real spend.
  
  Those callers now pass the total as `sessionTotalUsd`, along with the model session id, and the ledger books the rise since that session's last total. When that can't be known, the cost is recorded as unknown (null):
  - the total dropped, because a killed process restored an older total;
  - or a resumed session has no earlier total in the ledger.
  
  The log field is now `session_total` instead of `cost`. `scripts/spend-ledger-repair.ts` repairs rows booked before the fix; it dry-runs by default, and `--apply` backs up `spend.db` first.

## 0.3.2

### Patch Changes

- 078c0e4: Run the SOUL.md size gate, and send know-how to subject notes instead of SOUL.md.
  
  The gate for SOUL.md was written on 2026-08-28 and never called by the daemon, so the file grew from 31 KB back to 43 KB of every system prompt. It now runs in the boot sweep and after every self-note. `remember_about_self` requires a section and is limited to character and facts about Edmund's life; recipes, tool quirks and mistakes go to `remember_about_subject`, which is now in the tool catalog. The output contract states once that everything in the final text ships and that `KEEP_QUIET` is the only way to send nothing.
- e2d7027: A standing dinner text asks for a written recipe page on the day's first send again. The check read "any stored receipt" as a retry, and stored receipts still hold the last day it fired, so the page was requested once (2026-08-17) while the text promised it on 17 more days.
- b07d6ed: Scheduled and proactive wake-ups that start without the session's model conversation now carry the recent thread, as inbound cold starts do. The runner's persona-edit log says what happens (the session resumes and picks up the new prompt when its worker next starts) instead of announcing a fresh start that never happened.

## 0.3.1

### Patch Changes

- 229a464: Fixes from a review of the computer-use server. A contact's screenshot now blacks out the whole Notes window when another household's note is open and its body cannot be located, instead of covering nothing. Turning computer use off, taking an app off a list or switching the check from shadow to enforce now reaches sessions that are already running: the policy and the check's mode are read again from config.toml before every action (parsed only when the file changes), grants and grant flags the policy no longer allows are taken back, and a config that cannot be read refuses the action instead of falling back to the startup list. Before this, list_granted could show no approved apps next to two live grants that still clicked. The fixed refusals now cover their other paths: any key that would enter text in a password field is refused, not only Paste, and clicking Quit Messages, the Apple menu's Log Out, Restart, Shut Down, Sleep, Lock Screen or Force Quit, Finder's Empty Trash, or the Dock's Quit is refused like the shortcut for it. Where the element under a click in Messages or the Dock cannot be read, the click is refused. The screen lock takes, refreshes, releases and clears its file under a kernel lock, so two servers that both find a dead holder's lock can no longer both end up holding the screen, and the daemon no longer deletes a lock another server took after the daemon last read it. Delete descriptions count characters rather than UTF-16 units, so twelve forward-deletes over an emoji line no longer leave out the last line break. In Notes, after Select All (or with a selection that spans the whole note), pasting, typing, deleting or cutting is refused until a click or an arrow key moves the caret, so a whole note can no longer be replaced by paste. A scheduled note-sync turn keeps its scheduler context when a household member texts during it: the daemon now records which cron job started each turn, and the check reads that record instead of comparing the job's fire time with the latest message. The turn that message starts next still gets no scheduler context.
- 5a38db9: The computer-use safety check reuses a verdict when a check's state is exactly the same as an earlier one's within 30 minutes, instead of asking again. In one 68-minute Silhouette turn, 757 of 1,355 checks repeated an earlier one exactly (3.5 of 6.8 minutes of checking), and none got a different verdict. Errors are never reused, and any change to the action, the explanation or what the person said asks again. Delete, forward-delete and Cut with focus in a never-saved document Edmund created during the session no longer refuse on the destructive answer alone; every other harm still refuses. The harness decides whose document it is: an untitled window in an app the session launched, or one its app did not have when the session could first act there. Rewording the classifier's question was tried and rejected, because it lowered the destructive score of every Silhouette Delete, including one in a saved file (0.49 to 0.28).
- 530807d: The kitchen's "Assumed to be low/out:" section now follows the same rules as the rest of the shopping list. It used to be built before any of the household's answers were read, so "I do not buy this" and "not this trip" did nothing to an assumed line, and one-off purchases landed on it. Saying "we still have it" about a low item left it low and moved it to the confirmed "running low" section, and the site's "I already have this" reported that the ledger already agreed. Ticking an assumed line on the site and pressing Finished shopping recorded a purchase: it counted as a shopping trip, used up "not this trip" skips on other items, and could turn a one-off into a staple. A tick there now means what the list says, that they still have it: the item goes back in the kitchen with no purchase and no trip, through the same path as "I already have this" and the chat verdict. Whether a run-out was assumed is now read from the write that decided the item's state, so a rename or a price backfill cannot turn a guess into a fact. The avoid list is applied where dishes are suggested or ranked (the home page, dinner texts, the tray's buying ideas, explore, photos) and no longer where a dish is only looked up, so recipes written for the house are filtered too, and confirming a cooked avoided dish records its leftovers again. Saving a written recipe that uses an avoided food warns instead of refusing, since somebody asked for it. Avoid terms forgive singular and plural ("mushroom" catches cremini mushrooms, "mushrooms" catches mushroom) without catching an attribute ("olives" never catches olive oil). Ideas seasoned with salt and pepper are cookable instead of short two, and are no longer deleted by the next morning's prune; a basic the household does track is judged by its tracked level. An undone "we made it" or "we didn't make it" no longer counts in an item's history, and the leftover sweep's undo button, its put-back tap and its two-week exemption now ignore a put-back that was itself undone.
- 7a1fedf: Kitchen sites now live at one permanent address. A new launchd service, the kitchen host (`scripts/launchd/service.sh kitchen-host install`), keeps a share server running for each household on a fixed port, routes each request to its household by the `?key=` the page already sends, and runs a named Cloudflare tunnel to it. It checks every site through its public address each minute. Quick-tunnel links died with every reboot and every few days besides, and nothing noticed: the daily pass printed "could not reach" and then "health: nothing broken", and the health check called a dead site `ok` because a URL was recorded. `kitchen_site` now publishes the page and returns the link only once the page has answered through it. A site counts as working in the health check and the onboarding checklist only on a recent check through the host, and an unreachable one counts as broken in the daily pass. Onboarding fills in a member's missing name from the contact book and treats the people step as done only when everybody who eats there has a name. `service.sh` gains a sidecar installer that renders launchd templates; the SMS tunnel's plist had been symlinked to its template, so launchd exited 78 on every start.
- 3bdad15: The computer-use Messages scope now closes four gaps a review found. Keys and typing are judged by the window that holds the keyboard focus, and are refused when Messages cannot say which window that is. Before, they were judged by the window with the sidebar, so with another conversation open in a window of its own, a key could be sent there while the safety check was told it was the requester's. Notes works the same way now, and a window title the helper clips at 80 characters still finds its window. A title another conversation in chat.db could also have no longer identifies either one: two unnamed groups with an Alex and a Sam are both "Alex & Sam". A sidebar row counts as the requester's only when that is the one way to read it, so a DM contact named "Sam" no longer matches the group row "Sam, Alex & Jordan, see you at 6". When chat.db cannot be read, no conversation is identified and Messages stays closed. In the Messages search field, only editing the search skips the conversation check. Any other chord, cmd+delete included, goes through the check. Return, Enter and the up and down arrows open a result nobody can check first, so they are refused there. A contact's screenshot now reads the sidebar again after the capture, and retakes the image, up to three times, if a row moved into a slot left clear. After that every list is blacked out whole, and if even that does not hold, Messages and Notes are left out of the image.
- 1a3a2fd: The kitchen now records which lines of a household's Apple Note Edmund wrote, and only those can be deleted. Before, a line counted as his by where it sat: a scheduled note sync was told to delete anything above the sentinel that was not on the list, and the screen check was told to allow it, so an item somebody typed between two list lines was deleted and never reached the list, and a reworded line was overwritten. Now `kitchen_shopping noteWritten:true` takes the `noteVersion` printed with the lines Edmund worked from, records those lines, and later wakes name only his own lines that have left the list. Any other line is treated as the household's and goes onto the list. The screen check allows a scheduled deletion only for lines listed under that heading. A household with no record yet starts from the old sync's `notes.json`, and with no record at all nothing above the sentinel is deleted.
  
  A confirmation now records the version Edmund was shown, so a list that changed while he was editing stays behind and is woken for again, where before the change was marked as written. The watch pass does not spend a note wake while the Mac is locked: it waits and wakes once it can. A tap on the site's Apple Notes button now gets a new wake even after the list's three attempts ran out, and it makes the note due once, so later list changes wait the usual two minutes. `canEditNotes` uses the screen server's own app matching, so an entry like "Notes.app" counts.
- 3081db1: Fix a scheduled note sync that could not remove a stale line. Key presses in Notes and Messages now go to the window that holds the focused element. With several checklist lines selected, Notes puts a small untitled window in front of the note, and every key was refused with "did not say which note is open". A Delete or forward-delete is now described to the safety check by the text it removes, read from the accessibility tree, and typing over a selection by what it replaces. The destructive question now says that deleting a line a scheduled event's list no longer has is the requested edit. The scheduled event is passed to the check whole (up to 4,000 characters instead of 800). Replayed against the refused forward-delete, the check allows it: destructive 0.29 to 0.38, down from 0.74.
- 82c3fdc: A household's note title is pinned the first time Edmund confirms the note (`kitchen_shopping noteWritten:true`). Before, a household with no `note_list` derived its title from the people's names every time, so naming somebody later pointed the kitchen and the screen scope at a note that did not exist. The note sync then refused to open the real one, and could never succeed. `service.sh` now removes an installed LaunchAgent before rendering its template. If the agent was a symlink to the template, rendering wrote through the link and emptied the tracked file.
- c67d7d9: The screen's safety check no longer hears a reminder the model scheduled as Edmund's own scheduler. Since the turn-trigger context was added, any cron job that started a turn reached the check as "Edmund's own scheduler started this turn", with carrying it out counted as requested, deletes above a note's sentinel allowed, and the on-screen-instructions question waived. `schedule_reminder` and `update_reminder` store the model's text word for word, and data-trigger fires carry the model's brief and fetched data, so a model could write itself that permission a minute ahead. Cron jobs now record whether harness code wrote their text (`harness_written`, default 0, older rows 0). Only kitchen wakes and their retries set it, and rewriting a job's text clears it. The check gets the scheduler framing only for those jobs.
- 9e20d6b: A computer-use `wait` right after an action in a batch now ends once the screen has shown the action's effect and held still for 300 ms, instead of sleeping in full. The helper remembers the screen just before the input (the same apps a capture would show, below the menu bar, at half resolution) and compares frames exactly. A wait with no visible effect, one longer than 10 seconds, or one whose watch fails still sleeps the whole time. One 68-minute turn on 2026-09-23 spent 599 s in 560 waits, 532 of them a flat second. On the live screen, a change that appears at once returns in about 0.45 s, one that starts 800 ms late is not cut short, and a still or constantly animating screen waits the full time.

## 0.3.0

### Minor Changes

- 338ad51: Add a computer-use MCP server (`src/mcp/computer-use`) that lets Edmund see and drive native Mac apps. It has the same 24 tools and parameters as Claude Code's built-in computer-use server, which only runs in interactive sessions, plus a required `explanation` of at least 100 characters on every tool.
  
  Only iMessage and SMS conversations get it, each with its own app list in the new `[computer_use]` section. The owner is recognised by handle (`[security] operator_handles`, else `[alerts] operator_handle`), never by `contact_tier`, which grants host access and would otherwise hand every contact the owner's screen. Every other DM and group gets `contact_apps`, and only while the safety check enforces. Guests, the mirror and sub-agents get nothing.
  
  Before any action runs, the harness checks it in its own code first and then asks Jev (`typesafe/jev-1.13`, through OpenRouter). Jev receives the action in words, who asked and from which conversation, their latest messages from chat.db, and the model's explanation. The action is refused if the check cannot run. In `shadow` mode verdicts are only recorded, without holding up the action; each verdict records its request attempts.
  
  Some things are always refused, without asking Jev: shortcuts that end the session, quitting Messages, and typing into password fields. Messages actions are limited to the conversation the request came from, and Notes edits to the requester's household list, which the kitchen integration supplies through `screenScope`. Contacts' screenshots show only granted apps, with every other conversation and list blacked out.
  
  One conversation drives the screen at a time: another waits up to two minutes, then is told the screen is busy. When a turn ends the daemon signals that conversation's server, which quits the apps its turn launched (by process, never Messages, never an app that was already running) and releases the screen. The feature is off by default.
- 2e655fd: The kitchen now reasons about what is really in the house instead of trusting fixed shelf-life clocks. Each item carries evidence (purchases, meals cooked or suggested with it, the last time anyone saw it, and how long it keeps where it is stored), a morning review hands the uncertain items to the household's main session for a verdict, and suspected run-outs wait for a short yes/no follow-up the day after a meal. Unanswered suspicions are assumed and listed under "Assumed to be low/out:". The shopping list only restocks items bought on two or more trips, Make requests from the site become a conversation in the tapper's own chat, and meal picks honour the household's avoid list and no longer build dinners around deli meat or other lunch food.
- 58d3e06: The kitchen no longer writes Apple Notes itself. The background sync that drove a signed-in Chrome on icloud.com to rewrite each household's note, and the invites it sent the same way, are gone. Edmund now keeps each household's shared note up to date on screen, in the Notes app, with the computer-use tools: changing only the lines that differ and leaving ticks alone. When a household's list changes and then holds still for two minutes, the watch pass wakes that household's session to do it, with the lines the note should have. It only wakes a chat that the computer-use policy gives Notes, and each list wakes at most three times. `kitchen_shopping` loses `notes`, `share` and `shareWith`, and gains `noteWritten`, which Edmund sets once the note matches.

### Patch Changes

- a0d643a: Fix contacts' screenshots showing other people's conversations. On macOS 26 a capture that includes only some apps covered just the box around their windows, stretched to fill the image, so the black-outs (placed at the windows' real positions) missed: a test capture as a contact showed every other conversation in the Messages sidebar. The capture now always covers the whole display. A live test (`EDMUND_LIVE_SCREEN=1`) compares a contact's capture with the owner's and fails if the window moves.
- 4fbbd43: `KEEP_QUIET` on the first or last line of a reply now vetoes the whole reply, so narration beside the sentinel is dropped instead of shipped. `edit_message` and `unsend_message` confirm the outcome against chat.db and report a request Messages accepted but never applied as an error instead of success.
- 2e71565: Kitchen meal ideas, explore suggestions, shopping decisions, shelf-photo reads, onboarding reads, and spoken cooking answers now run in the household's main session instead of direct OpenRouter text calls. Deterministic inventory work remains local, and generated card photography and speech synthesis remain presentation-only media calls.

## 0.2.0

### Minor Changes

- c8007e1: Install from one checkout. `imcore-bridge` now comes from its GitHub release
  tarball rather than a sibling directory, so `git clone && bun install` is the
  whole setup and the dylib is compiled during install.
- 5bad254: Add design documentation covering what is novel in the project, and lead the
  README with it rather than with the messaging transport. New pages: thesis,
  memory architecture, context economics, proactive economics, failure model,
  skill exchange, engineering notes.

### Patch Changes

- b1ae4c4: Pin imcore-bridge v0.2.3, which is the first release published by the bridge's
  own automated pipeline.

## 0.1.0

### Minor Changes

- 8f941cd: First public release: the documentation set, the `[security]` trust policy
  with safe defaults, dashboard and daemon hardening, revocable portal links,
  and a tree scrubbed of real identifiers.

### Patch Changes

- cc54099: Take the dependency updates that pass the gates: TypeScript 7, cloudflare 7
  (its snapshot response fields are optional now, so a partial render is
  reported rather than written out as an empty file), concurrently 10,
  changesets 3, hookform resolvers 5, and the GitHub Actions majors. Clear
  every high-severity advisory by pinning patched versions of six transitive
  packages. CI now typechecks and builds both front ends, which is where three
  type errors had been hiding, and the audit gate retries instead of failing
  the build when the advisory registry does not answer.
- 9cdf62c: Move the user portal to Vite 8 with the matching React plugin major. The
  plugin was declined last time because it would not build against Vite 6; it
  builds against Vite 8, so the two move together.
- 28adac8: Move the operator dashboard to Vite 8 with the matching React plugin, and
  take zod 4 there (it is a dependency the app's own source never imports).

Notable changes, newest first. Dates are absolute.

## Unreleased

- Scrubbed the tree of real identifiers: phone numbers, the bot's Apple ID,
  the home coordinates and address, the Pi credentials and the operator's
  name now come from `.env`, `[owner].name` or synthetic fixtures. A
  personal newsletter playbook and a scraped camera dataset left the tree.
- A `[security]` config section holding the trust decisions: model host
  access (sandboxed by default), a contact tier for allowlisted people who
  are not the operator, and explicit flags before an empty allowlist admits
  everyone. Existing deployments write their previous choices into the
  section to keep behaviour.
- Dashboard hardening: loopback bind by default, login throttling, Strict
  cookies with Secure over TLS, an origin check on mutations, body limits
  before authentication, no exception text in responses, real path checks
  on served files, security headers, longer PINs.
- Structural masking of every credential shaped config value in the
  dashboard API, and of credential shaped tool arguments in the daemon log.
- The SSRF guard now checks every redirect hop, and the data trigger probe
  goes through it.
- Trading: the risk check refuses model supplied account numbers unless a
  code level broker fetches them or the operator opts in; the trading
  dashboard escapes everything it renders.
- Portal links can be revoked per conversation, and the erase action needs a
  server checked confirmation.
- Background job lookups are scoped to the session that started them.
- Private umask and a permission sweep of data, persona, sandbox and config
  at boot.

- Prepared the repository for public release: rewrote the README and the
  documentation set, added CONTRIBUTING and SECURITY, moved deployment
  specific documents and campaign briefs out of the tracked tree, and replaced
  real identifiers in the example config and tests with placeholders.

## 2026-09-02

- Per person generation credits: each DM gets a provisioned OpenRouter key
  whose limit tracks Stripe payments. No local ledger.
- The per person portal rebuilt as a React application.
- An SMS channel over Twilio on the shared pipeline, off by default.

## 2026-08-28

- Root cause and fix for sends misrouting on macOS 26: dispatch through the
  chat registry rather than the adjusting send method.
- Operating principles layer: a consolidation pass that turns observations
  into rules.
- Domain notes, archiving of the global self file with recall indexing,
  tapback attribution in history, Apple Maps cards for addresses.

## Earlier

The design records in `docs/design/` describe each subsystem as it was
planned, and the git history describes it as it was built.
