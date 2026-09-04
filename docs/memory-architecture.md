# Memory architecture

[memory.md](memory.md) is the operator page: where the files are and how to
edit them. This page is the design, why each layer exists, and what was
measured before it did.

## Five layers, distinguished by what they cost

The question that organises everything here is not "what should be remembered"
but "what is worth having in the prompt on every turn." Those are different
questions with different answers, and conflating them is how memory systems get
expensive and stop working at the same time.

| Layer | Scope | In the prompt | Written by |
|---|---|---|---|
| `SOUL.md` | Global | Every turn of every conversation | The model, through `remember_about_self` |
| Person file | One conversation | Every turn of that conversation | The maintainer, automatically |
| Operating principles | One conversation | Every turn of that conversation | The consolidator, automatically |
| Domain notes | Global | Only when recall surfaces one | The model, through `remember_about_subject` |
| Archives | None | Only when recall surfaces one | The archiver, automatically |

The first column is a cost multiplier. A token in `SOUL.md` is paid on every
turn of every conversation; a token in a person file is paid on every turn of
one conversation. Across an active deployment that ratio is roughly fifty to
one. Anything that can live in a lower layer should.

## The failure that produced the principles layer

Every learning path in this system was originally append only, and the
maintainer that drives it is good at its job: it reads a finished conversation
and appends dated, specific, well sourced observations.

The result, at four months, was a person file with 105 entries that had
concluded nothing. Three separate observations circled the same rule about how
that person handles feedback without ever stating it. Two noted independently
that he trains through medical restrictions, without either becoming "stop
prescribing prohibitions to this person." Extraction had worked perfectly and
had produced no judgment, because every code path the maintainer has adds a
row. A pass that can only append is a log, regardless of how well it writes.

There was a second, quieter failure underneath. Observations enter a reply only
through semantic recall, and recall fires only when the inbound message looks
like a retrieval query. About two thirds of turns are short reactions that
trigger nothing, so most replies were composed by a model that could not see
any of the 105 things it knew. The memory was real and was not load bearing.

## Consolidation: a second pass asking a different question

`src/persona/consolidate.ts` runs over the same file the maintainer writes and
asks what the rules are, not what is new. Because that is a different question,
the pass is allowed to do things the maintainer cannot: rewrite, merge, and
retire.

Four properties do the work.

**A cap of ten, enforced.** The point of the section is that it is short enough
to sit in the prompt permanently, which is what lets it shape one line replies
as well as long ones. The prompt says fewer is better and to return none if the
file does not support a real rule yet.

**A test for what counts.** If knowing it would not change anything the
assistant says or does, it is an observation and stays in the log. "Runs 25
miles a week" is a fact. "Base is his limiter rather than speed, so buy pace
with easy volume and stop prescribing intervals" is a rule.

**Rejections are wanted explicitly.** The prompt asks what the person
consistently does not take, what advice has been given more than once and not
followed, what framing makes them push back. A principles list containing only
what someone likes produces an agreeable, useless assistant. Someone who ignores
a restriction every time it is given does not need it given again; the rule is
to work around it.

**Evidence dates, so revision is possible.** Each principle cites the dates of
the observations behind it. The pass is given the current principles and asked,
for each, whether the file still supports it. A later observation that
contradicts a principle corrects or drops it, and the change is reported in a
one line `revised` field. Without the citations this degenerates into a second
append only list.

It runs after twelve new observations have accumulated, and the count it was
last derived at is stamped into the file itself rather than kept in a counter
that could drift from the thing it describes.

## The group variant is not the same prompt with the nouns changed

A group's register is contagious, and an assistant that follows it will drift.
The conversation that motivated this: the assistant misread a tapback aimed at
someone else as an attack, answered the wrong person sharply, escalated when
challenged, sulked, and when told it was being sassy replied that it was "the
one setting I don't have a slider for," disclaiming agency over its own
behaviour.

A consolidation pass that asked "what works in this room" would read that
transcript, conclude the room trades insults, and write it down as doctrine.
Distilling a drift makes it permanent and turns a bad afternoon into a
personality.

So the group prompt splits what the DM prompt can safely leave joined:

- **How the room works**, descriptive, about them. Who drives conversation,
  the running bits, which subjects land.
- **How I behave here**, prescriptive, about the assistant, and derived by
  comparing its own conduct against its own character rather than against the
  room's norms.

Matching a group's warmth is good. Matching its temperature is how an assistant
ends up hostile and calls it fitting in.

## Archiving, and a bug shape worth knowing

A person file is injected whole into the system prompt. That is the right
pattern, and a curated always in context core is the most validated memory
design in the field, but only while the file stays small. The largest one here
reached 96 KB, which is roughly 24,000 tokens on every turn of that
conversation.

The archiver moves the oldest dated bullets out of the history heavy sections
into `persona/people/archive/<handle>.md` until the live file is back under
target. Trigger is 8 KB, target 6 KB. Nothing is deleted: the archive is append
only, chunk indexed for recall, and readable by the model on demand.

It is deterministic code rather than a model pass, on purpose. Destructive
looking operations in memory maintenance must be mechanical and auditable,
because a write path that lets a model delete is how systems silently lose
facts.

The interesting part is the failure it kept having. Three times in one day the
same bug appeared in different places, and it always looked like a limit that
was set too high:

1. `Open Items` was 66% of the largest person files and was exempt from
   archiving, so the gate could never reach its target and pinned files seven
   to eight times above it.
2. In `SOUL.md`, the archiver's `^##\s+` heading regex could not match a `###`
   subsection. Every third level section was invisible to it, and one grew to
   roughly half the system prompt while the gate reported nothing to do.
3. `Our Dynamic` was exempt while being exactly the undistilled form of what
   the principles layer had just replaced, so the file paid twice for the same
   knowledge.

The shape is: **the limit cannot be reached because the dominant content is
exempt from it.** When you find one, look for its siblings. Section specific
recency floors are how it is handled now: `Open Items` keeps a deep tail of 40
bullets because nothing ever closes one and each may still be a live
commitment, `Our Dynamic` keeps 8 because its durable half is already a
principle by the time the section becomes archivable.

## The pipeline order is load bearing

```
append observations  ->  CONSOLIDATE  ->  archive
```

Consolidating after archiving derives a person's rules from a file the archiver
has already thinned, so the rules are distilled from a subset of the evidence
and quietly get worse. A test pins the order, because the failure is otherwise
silent: everything succeeds, and the output is merely weaker.

## Domain notes: what it knows about a subject

Person files made the assistant specific. Nothing made it expert. Endurance
training knowledge was whatever the base model had plus whatever got searched
that morning, and it did not compound. An excellent piece of reasoning about why
a psoas that flares with mileage is weak rather than tight taught it nothing it
would still have in November, and the next person asking started from scratch.
Sixty conversations produced sixty fresh starts instead of a practice.

Domain notes follow ReasoningBank: store distilled strategy rather than
transcripts, and mine failures as well as successes. An entry records what was
tried, whether it worked, and with whom. "Told a runner to drop lifting;
ignored every time" is worth more than a citation, because it is the thing an
article will never tell you.

It is deliberately a tool the model calls rather than a background pass. A note
is worth writing at the moment something is noticed, and only the model is in a
position to know that a piece of advice landed or was quietly discarded.

Domain notes are global but are not in the prompt. They arrive through recall,
which is the whole point: global scope at recall cost rather than at per turn
cost.

## Recall, and why it suggests at most one skill

`src/memory/auto-recall.ts` runs before every model invocation and injects
semantically similar past material into the envelope, so the common case needs
no tool call. Any failure is swallowed: recall is enrichment and must never
block a reply.

Live profile chunks are excluded from its results after search, because the
whole live file is already in the system prompt and re-injecting it would pay
for the same tokens twice. Only archived chunks add anything.

The skill suggestion inside it is a good example of how a measurement changed a
design. Over four months, skills were read on about 5% of conversational turns,
and 82% of those reads were the four skills the system prompt names by hand.
Nothing was discovering the rest. The obvious fix is a nudge, and the obvious
fix is worse than the gap: a suggestion on every turn trains the model to skip
the block, and a wrong suggestion sends it to read three thousand tokens of the
wrong playbook. So at most one skill is ever suggested, and only on a clear
match.

## Self memory has a character limit

`remember_about_self` writes to `SOUL.md`, the layer that is in every turn of
every conversation. A note is capped at 500 characters. That is not a storage
concern. It is the fifty to one multiplier made into an enforced rule at the
one place where a model can spend it.

## Where to read the code

| File | What it holds |
|---|---|
| `src/persona/maintainer.ts` | The append pass and its prompt |
| `src/persona/consolidate.ts` | Both consolidation prompts, DM and group |
| `src/persona/principles.ts` | The principles section, its cap and its render |
| `src/persona/archive.ts` | The size gate, section rules, recency floors |
| `src/persona/domains.ts` | Subject notes |
| `src/persona/self-memory.ts` | `SOUL.md` writes and the 500 character cap |
| `src/memory/auto-recall.ts` | Pre-turn recall injection |
| `src/memory/indexer.ts`, `vector-store.ts` | The local index everything else is searched through |

The literature review that preceded the design is in
[research/memory-architecture-2026-07-28.md](research/memory-architecture-2026-07-28.md).
