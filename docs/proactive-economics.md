# The economics of speaking first

[proactive.md](proactive.md) is the operator page: how to turn outreach on,
what the settings do, where the logs are. This page is why it is built as a
budget system rather than a scheduler.

It is off by default, and the design assumes you are right to be suspicious of
it.

## The problem with a timer plus a model call

An assistant that reaches out first is easy to build and hard to build well.
The naive version is a periodic tick that asks a model whether there is
anything worth saying. It produces something charming for about two days and
noise thereafter, and the failure is invisible from inside: the model is asked
the same question every time, has no memory of how its last twelve attempts
landed, and every individual message it proposes is defensible on its own.

Two budgets are actually being spent, and only one of them is money. The other
is the person's patience, which does not refill on a schedule and which nothing
in the naive design is tracking.

So the system is built as gates plus a feedback loop, and the model is the last
step rather than the first.

## Six gates, none of which cost anything

`src/ghost/budget.ts` holds every pre-model decision as a pure function: no
database reads, no clock calls, no model. They are fed data and return
`{ ok: true }` or `{ ok: false, reason }`, which makes them trivially testable
and means a tick that is going to produce nothing costs nothing to find out.

They run in order and short circuit on the first failure.

1. **Enabled.** Global kill switch, then the per conversation setting. A person
   who has switched it off is off, and the reason they gave is carried.
2. **Active hours.** Timezone aware and weekday aware, in the conversation's
   timezone rather than the daemon's.
3. **Cooldown.** Minimum hours since the last outreach in this conversation.
4. **Weekly cap.** Outreach in the trailing seven days against the cap.
5. **Engagement decay.** A multiplier applied to the cooldown, derived from how
   recent messages actually landed. Described below.
6. **Focus topic cap.** A topic the person asked to be nudged about can be
   raised at most three times in a week.

Every failure writes its reason to `decisions.jsonl` in the conversation's
sandbox. This is the part that makes the system legible: a quiet week has an
explanation on disk, in order, and reading it does not require reproducing
anything.

## One knob, and it changes the prompt rather than a probability

Intensity is a single number from 1 to 10, and each person sets their own from
their portal rather than the operator setting it for them.

It maps to four effective parameters: cooldown hours, weekly cap, the randomised
sweep cadence, and an eagerness clause. The last one is the interesting one,
because it is dropped into the model's prompt verbatim rather than used to
weight a coin. Different levels make the model behave differently in kind, not
just less often.

At level 1 the clause reads, in part: only proceed on an unmistakable, time
sensitive hook where the person would visibly miss out, and if you would
describe your own rationale as "might be nice," return no. At level 3 it says to
lean toward silence and act only when the move would clearly land, naming a real
artifact or a real follow through on a stated promise as the bar.

For reference, level 1 is a 168 hour cooldown and a cap of one per week; the
scale runs continuously up from there. A person who wants to hear from it twice
a year and a person who wants a daily check in are both configured, not
special cased.

## Engagement decay closes the loop, or it did not for a month

The multiplier looks at the last five outreach attempts that actually reached
the person and counts the negative ones. Zero negatives with three or more
positives shortens the cooldown to 0.75x. One negative stretches it to 1.5x, two
to 2x, three to 3x, four or more to 4x. Ignoring it repeatedly makes it
progressively quieter without anyone having to intervene.

Vetoed and errored attempts are filtered out of that window before counting,
because they never reached the person and carry no information about them. Left
in, a run of vetoes would dilute the last real outcomes out of view, and the
system would read a technical problem as a social signal.

None of this worked at first, for a reason worth being explicit about. Decay
consumed outcomes, and nothing wrote them. Every attempt sat unresolved forever;
two production attempts from May were still unresolved a month later. The
governor was reading a column that was always empty, so it always returned 1.0,
and it looked like it was working.

Outcomes are now backfilled deterministically from observable behaviour:

- Any message from the person in the conversation within 12 hours of an
  outreach counts as **engaged**. They were drawn back into the conversation,
  which is the thing being optimised for.
- A tapback on one of the assistant's messages with no reply is **reacted**,
  carrying the glyph. It is the lightest feedback channel iMessage offers and it
  was previously invisible to the loop entirely. Positive and negative glyphs
  count on opposite sides.
- No reply after 36 hours is **ignored**.
- A text reply beats a tapback in the same window, because it is the stronger
  signal.

**Pushback is deliberately not inferred here.** Whether a person was annoyed is
a judgment call about tone, and the model already owns it: when it reads
pushback it calls the tool that disables outreach for that conversation, and the
handler stamps the pending attempt. Inferring displeasure from text with a
regular expression would be both unreliable and a worse version of something
that already exists.

## Which conversation gets looked at

The observer ticks one conversation at a time, chosen by a pure picker with a
fixed priority order. Higher reasons short circuit lower ones, so a conversation
whose window just opened and that has also been quiet for five hours is picked
for the window, not the quiet.

1. **window_start.** The active window opened recently and nothing has ticked
   since. This catches the morning of someone's active day.
2. **quiet_24h.** Their last message was 22 to 26 hours ago and no 24 hour tick
   has happened in this stretch. This catches "they would normally have replied
   by now."
3. **quiet_4h.** Last message 4 to 6 hours ago, same debounce. This catches
   "they may be done for the day, is there anything worth surfacing before it
   moves on."
4. **sweep.** Oldest tick wins. A round robin backstop so no conversation is
   starved when no trigger fires.

The picker takes `nowMs` as an argument and does no IO, so the whole schedule is
deterministic under test.

## What the model actually gets to do

A tick that survives the gates spawns a tool using agent rather than asking for
a one shot yes or no. It can search the web, read its own workspace, and stage
drafts. It runs asynchronously, so a tick that takes minutes does not block the
daemon.

It must finish by calling a `submit_decision` tool, which validates against a
schema and writes the decision to a file. If it never calls the tool, the
harness falls back to parsing JSON out of stdout with salvage defaults. Making
the exit path a validated tool call rather than trusting free text is the
difference between a decision you can act on and a string you have to hope
about.

The decision is appended to `decisions.jsonl` whether it was yes or no, along
with the reasoning. An outreach that was considered and declined is as much a
part of the record as one that was sent.

## What this buys

The property being purchased is that the system gets quieter on its own when it
is wrong, and that you can always find out why it did or did not speak. Neither
requires the operator to notice anything.

The property it does not buy is good judgment about what to say. That is the
model's, and it is why the eagerness clause is a prompt rather than a threshold.

## Where to read the code

| File | What it holds |
|---|---|
| `src/ghost/budget.ts` | All six gates and the decay multiplier, pure |
| `src/ghost/intensity.ts` | The 1 to 10 table and the eagerness clauses |
| `src/ghost/picker.ts` | Which conversation is ticked, pure |
| `src/ghost/outcomes.ts` | Outcome backfill and its classification |
| `src/ghost/think.ts` | The tick itself, prompt assembly, the agent spawn |
| `src/ghost/mcp-server.ts` | `submit_decision` and its schema |
| `src/proactive/` | The queue, semaphore and firing path |

The plan written before it was built is in
[design/brownnose-plan.md](design/brownnose-plan.md).
