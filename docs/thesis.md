# What this project argues

Most of this repository is not about iMessage. Messaging is 7,600 of the
57,800 lines under `src`, and every one of those lines exists so the rest can
reach a person. If you are comparing projects by their transport, this one
looks like a dozen others and you can stop reading here.

What it is actually about is three claims, each of which changed the code in
ways you can go and read.

---

## 1. Memory that only accumulates never becomes judgment

The obvious way to give an assistant memory is to write things down and search
them later. Every path in this codebase started that way, and it fails in a
specific, measurable manner.

One person's file reached 105 dated observations. They were good observations:
specific, sourced, correctly extracted. Three separate entries circled the same
rule about how he handles feedback without ever stating it. Two noted that he
trains through medical restrictions without ever becoming "stop prescribing
prohibitions to this person." The file knew everything and had concluded
nothing.

The second failure is structural rather than editorial. Observations reach a
reply only through semantic recall, and recall only fires when the incoming
message looks like a retrieval query. Roughly two thirds of turns are short
reactions that trigger no recall at all, so the majority of replies were
written by a model that could not see any of the 105 things it had learned.
The memory existed and was not load bearing.

So there is a second pass over the same file that asks a different question.
Not "what is new here," which is what the append pass asks and which can only
ever add a row, but "what are the rules for working with this person." It may
rewrite, merge and retire. It is capped at ten principles, because the value of
the section is that it is short enough to sit in the prompt on every single
turn, including the one line replies. A weak eleventh entry costs more than it
returns.

Two details matter more than the idea:

**Rejections are principles.** The prompt explicitly asks what the person will
not take, what advice they have ignored more than once, what framing makes them
push back. A list containing only what someone likes produces an assistant that
is agreeable and useless. This is the structural opposite of a yes man, and it
is the part most often left out.

**Principles carry their evidence dates.** Each rule cites the observations it
was distilled from, so a later pass can audit it, and a conversation that
contradicts a rule can revise it rather than stacking a second rule beside it.

The shape follows published work rather than being invented here. Generative
Agents (Park et al. 2023) generates periodic reflections that synthesise
observations into higher level insights and cites the observations behind them;
ablating reflection collapsed the agents' behaviour. ReasoningBank stores
distilled strategy and deliberately mines failed episodes for pitfalls. MemGPT
supplies the core versus archival split. The contribution here is not the idea,
it is having run it against a real four month log and measured what the
append-only version was actually doing.

Full detail: [memory-architecture.md](memory-architecture.md).

---

## 2. Context cost is a design constraint, not an operations concern

The prompt is rebuilt on every turn, so anything in it is multiplied by every
turn of every conversation forever. That makes prompt composition an
engineering decision with a price attached, and the price is steep enough to
decide architecture.

Two consequences run through the whole codebase.

**Layer asymmetry.** A token in the global identity file is in every turn of
every conversation. A token in one person's file is in every turn of one
conversation. The ratio across an active deployment is on the order of fifty to
one. So "where does this belong" is a cost question before it is an
organisational one, and the answer is almost always the narrowest layer that
works. Standing knowledge that does not need to be present goes into domain
notes, which are reachable through recall and absent otherwise.

**Compaction is not free and the intuitive fix is backwards.** Compaction
rewrites the cached prompt prefix, which converts cheap cache reads into
expensive cache writes on the following turn. Measured, the turn after a
compaction cost roughly two and a half times a normal one. The obvious reaction
to "it compacts at a fraction of the model's window" is to raise the threshold.
That is the wrong lever: it moves every subsequent turn into a more expensive
context bracket and keeps it there for as long as the conversation stays large.
Compacting early looks absurd and is correct.

This is why the archiver exists, why person files have a byte gate, why
principles replace observations rather than joining them, and why there is a
warm worker pool at all. It is also why `data/spend.db` records the CLI's own
reported cost for every model call and never estimates one.

Full detail: [context-economics.md](context-economics.md).

---

## 3. An assistant that speaks first needs an economy, not a cron job

Proactive outreach is easy to build badly. A timer plus a model call produces
something that is charming for two days and then is noise, and the failure is
invisible to the system producing it.

The design here treats every unprompted message as a spend of two separate
budgets: money, and the person's patience. Both are enforced before any model
is invoked.

Six deterministic gates run first, in order, and none of them costs anything:
kill switch and per conversation enable, timezone and weekday aware active
hours, cooldown, weekly cap, an engagement derived multiplier on that cooldown,
and a per topic cap so one idea cannot be raised three times a week. Each gate
returns a reason string, and the reason is written to a decisions log whether or
not anything is sent. You can read why a quiet week was quiet.

Intensity is one operator facing number from 1 to 10, and each person sets
their own from their portal. It does not merely change probabilities, it
changes the prompt: level 1 tells the model that if it would describe its own
rationale as "might be nice," the answer is no.

The part that makes it a loop rather than a governor is outcome backfill.
Engagement decay adjusts cooldowns based on how past messages landed, but for a
month nothing ever wrote an outcome, so every fire sat unresolved and the
system could not learn. Outcomes are now derived from observable behaviour: a
reply within twelve hours is engagement, a tapback with no reply is its own
weaker signal, silence after thirty six hours is being ignored. Pushback is
deliberately not inferred, because tone is a judgment call and the model owns
it by calling a tool.

Full detail: [proactive-economics.md](proactive-economics.md).

---

## What follows from all three

The same instinct produced the parts of the system that are less headline
worthy and more useful in practice: a reply is never suppressed programmatically
because that hides a problem instead of fixing it, a send is verified against
`chat.db` rather than trusted because "sent" is a claim, failures are classified
into ten named classes each with a structural repair, and a guard that refuses
is treated as correct until proven otherwise.

Those are collected in [failure-model.md](failure-model.md) and
[engineering-notes.md](engineering-notes.md).
