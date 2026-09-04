# Context economics

[costs.md](costs.md) is the operator page: what you pay for and how to measure
your own curve. This page is the argument that cost shaped the architecture,
and the four places where the intuitive decision is the wrong one.

Absolute figures are deliberately absent. Your model, your conversations and
your prices differ, and a number in a README is wrong the day either changes.
What transfers is the shape, and `data/spend.db` records the CLI's own reported
cost for every model call so you can derive your own.

## The one fact everything follows from

The prompt is rebuilt on every turn. Nothing in it is paid for once.

That sounds obvious and is routinely ignored, because the natural unit of
thought when adding a feature is the feature. The natural unit of cost is the
turn, and the two are related by a multiplier that depends entirely on which
layer you put something in.

| Layer | Paid on |
|---|---|
| System prompt, `SOUL.md` | Every turn of every conversation |
| Person file, operating principles | Every turn of one conversation |
| Domain notes, archives | Only the turns where recall surfaces them |
| Skills | Only the turns where the model reads one |

Measured across a real deployment, the top row costs on the order of fifty
times the second for the same token. So "where does this belong" is a pricing
question before it is an organisational one, and the default answer is the
narrowest layer that still works.

This is why `remember_about_self` caps a note at 500 characters while a person
file is allowed kilobytes, why standing subject knowledge goes into domain
notes that are reachable rather than resident, and why the archiver exists at
all.

## Wrong lever 1: raising the compaction threshold

The setup that makes this tempting: a deployment compacting at a fraction of
the model's context window. It looks like leaving most of the window unused for
no reason, and the obvious response is to raise the threshold.

Measure first. Median cost per turn rises steeply with context, and the gap
between the smallest and largest brackets is several times over, not a few
percent. Separately, the turn immediately after a compaction cost about two and
a half times a normal turn, because compaction rewrites the cached prompt
prefix and converts cheap cache reads into expensive cache writes.

Both facts push the same way, and it is not the way the intuition points.
Raising the threshold does not avoid a cost, it relocates every subsequent turn
into a more expensive bracket and holds it there for as long as the conversation
stays large. The one time cost of a compaction is smaller than the recurring
cost of never compacting. Compacting early looks absurd and is correct control.

The lever that does work is shrinking fixed overhead, which is the whole
content of the section above.

## Wrong lever 2: assuming prompt caching makes the prefix free

Prompt caching skips re-tokenizing. It does not skip re-uploading.

Every retained image content block rides in the HTTP body of every API round
trip of every turn for the life of the session. A conversation that has
received a few dozen voice notes, reference photos and screenshots accumulates
a session transcript where the base64 payload dominates, and the cost is paid
on every single turn afterwards, silently, with no error until the session
crosses the 32 MB request wall and every resume fails at once.

So there is a size sweep on the session transcript itself, separate from
context compaction. It replaces old image blocks with a short text placeholder,
oldest first, stopping as soon as the projected size is under target. The soft
limit sits far below the hard wall on purpose, because the point is not to
avoid the wall, it is to keep the per request payload small continuously.

Nothing is lost: the original file is still on disk in the conversation's
sandbox, and the model can read it again if the conversation returns to it. The
newest images, which are the ones a conversation is usually actually about, are
the last to go.

## Wrong lever 3: one set of numbers for two CLIs

The harness can drive Claude Code or Codex. They were originally sharing one
set of tuning values, which were correct for one of them. An effort setting
tuned for Opus was handed unchanged to a reasoning model that spends it very
differently, and a context window was passed explicitly to a CLI that knows its
own.

Two rules came out of that. Codex specific overrides fall back to the Claude
values, so a deployment that never sets a `gpt-*` model is unaffected by the
block existing. And an explicit context window is not passed at all: the CLI's
own metadata is right today and still right when the model changes, whereas a
hardcoded number is a maintenance obligation that will eventually be wrong
without telling you.

The general form is worth stating on its own. **A fix that requires a number to
be maintained will eventually be wrong.** Prefer deleting the constant to
correcting it.

## Wrong lever 4: paying a large model to decide whether to speak

Proactive outreach could reasonably be a timer and a model call. That design
pays for a judgment on every tick, including the overwhelming majority of ticks
where a deterministic rule already knows the answer is no.

So the proactive path is two stages. Six pure functions run first, cost nothing,
and short circuit on the first failure: enable, active hours, cooldown, weekly
cap, engagement decay, per topic cap. Only a tick that survives all six reaches
a model. Every gate failure is written to a decisions log with its reason, so a
quiet week is explicable without having spent anything to explain it.

The same instinct routes satellite work by what the work actually is. The
maintainer and the prescreen run on small models because extraction is
mechanical. Consolidation is judgment and wants a larger one. Getting this
backwards is easy and expensive in both directions: a large model doing
extraction wastes money, a small model doing consolidation produces principles
that are just observations reworded.

## The warm pool

Resident workers keep one process per active conversation, fed a turn at a time
on stdin. The reason is the cached prompt prefix: a cold start re-reads it, a
warm worker does not.

The pool has one property worth knowing about because it looks like a bug.
Worker binding is sticky and upgrade only, so a conversation that has been doing
browser work stays bound to a worker that carries that capability rather than
being handed a cheaper plain one. That is deliberate. The alternative churns
workers, and a churned worker costs a cold prefix read, which is more than the
capability was costing to carry.

## The ledger records, it never estimates

Every model invocation in the system writes one row to `data/spend.db`:
timestamp, conversation, subsystem, model, duration, context tokens, cost. A
daily rollup is written in the same transaction so dashboard queries never scan
the raw table.

The cost figure comes from the CLI's own result event. If the CLI does not
report one, the row records nothing rather than a guess. An estimated cost
column is worse than an empty one, because it will be trusted and it will be
used to make exactly the kind of decision this page is about.

Subsystems are an open set: `turn`, `cron`, `agent`, `ghost`,
`ghost-prescreen`, `maintainer`, `catch-up`, `research-planner`, and whatever a
new caller tags itself. That is what makes it possible to ask which part of the
system is actually spending the money, which is rarely the part you would
guess.

## Measuring your own

The query in [costs.md](costs.md) buckets turn cost by context size against
`data/spend.db`. Run it before changing anything about prompt composition, and
again afterwards. The first run is usually surprising.

Two habits behind everything on this page:

- **Measure before theorising, and again before acting.** Both wrong levers at
  the top of this page were confident, well reasoned recommendations that the
  numbers reversed.
- **Distinguish no evidence from evidence of absence.** A metric that goes
  quiet after a change is not proof the change did it. Check the sample size
  and the pre change baseline first.
