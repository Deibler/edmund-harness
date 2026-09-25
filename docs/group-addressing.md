# Answering group messages that forget his name

In a group chat the assistant speaks only when a message says his name. People
forget it. They ask a follow-up to something he just said, swipe-reply to his
message, or misspell "Edmund". Over 90 days to 2026-09-24, senders had to point
at an ignored message with a bare "Edmund^" 32 times, and 31 of those were
within five minutes of him speaking.

The missed-name check (`[group_addressing]`, off by default) lets a small
classifier wake him for those messages. The split of responsibility:

- **Code** picks the candidates and enforces the limits.
- **Jev** (`typesafe/jev-1.13`, through OpenRouter) judges whether each
  candidate is for him.
- **The assistant**, once woken, decides whether anything needs saying. The
  note he gets says he was not named and that `KEEP_QUIET` is his call.

This page is the approach and the measurements behind each number. The code is
`src/gating/address-check.ts`; the config keys are in
[configuration.md](configuration.md#group_addressing).

## Candidates

Only a group message the gate turned away for not naming him can be a
candidate. Messages from unregistered groups, DMs, and his own messages are
never sent to Jev. A candidate is one of:

| Reason | What code checks |
|---|---|
| `reply-to-assistant` | A swipe-reply whose parent is his message (`thread_originator_guid`) |
| `name-like` | A word within two edits of one of his names of five letters or more ("Edmudn", "edmun") |
| `after-assistant` | Arrived within `window_minutes` of his last message |

Both inbound paths run the check: the live watcher, and the boot catch-up.

## What Jev is told

Jev gets a small structured state, not a transcript:

- the assistant's name and the names he also answers to;
- the last eight messages, each with its sender, how long ago it was sent, and its text;
- the new message, and the parent message if it is a swipe-reply;
- the seconds since he last spoke.

Senders become "Person A", "Person B": handles never leave the Mac.

It then answers two yes/no questions, each with criteria and invented examples:

- `addressed`: is the message said to him?
- `wants_reply`: does the sender want him to reply or act?

**Short context on purpose.** Longer history made Jev worse. On the same 87
labels, the area under the curve fell from 0.907 with 6 lines to 0.862 with 20
lines, and adding the group's culture notes gave 0.866.

**One fact code adds: the message opens with someone else's name.** Because
senders are letters, Jev had no way to know that a message opening "Sam
who's playing Sunday?" was said to Sam, a member of the chat. On
2026-09-24, right after the sender had been talking to the assistant, it woke
him for exactly that message at 0.86.

Code now checks locally whether the first word is the first name of another
member, from the address book. It sends only
`latestMessage.opensWithNameOf: "someone else in this chat"`, never the name
or the member list. On the labelled set, that message dropped to 0.03 "said to
him" and 0.13 "wants a reply", with nothing else getting worse.

## The wake rule

Scores alone decide first:

| Candidate | Wakes when |
|---|---|
| `after-assistant` | `wants_reply` ≥ `reply_threshold` (0.7) **and** `addressed` ≥ `addressed_floor` (0.5) |
| `reply-to-assistant`, `name-like` | `wants_reply` ≥ `reply_threshold`, **or** `addressed` ≥ `addressed_threshold` (0.7) |

A swipe-reply or a misspelled name is already aimed at him, so "said to him"
is enough for those. Soon after he spoke, "wants a reply" is not: Jev reads it
as wanting a reply from anybody. All 29 wrong wakes under the first rule
(`wants_reply` ≥ 0.6 alone) were friends asking each other things right after
he had spoken: plans, and questions from one friend to another.

Measured over 840 labels:

| Rule | Real ones woken (yes and yes-ish) | Wrong wakes |
|---|---|---|
| `wants_reply` ≥ 0.6 alone (the first version) | 87 of 100 | 29 of 726 |
| ≥ 0.7, floor 0.5 (now) | 82 of 100 | 8 of 726 |
| ≥ 0.8, floor 0.5 | 73 of 100 | 1 of 726 |

The five real messages the current rule gives up are short asides that read
ambiguously even to a person: a two-word score update, a one-line joke.

## What Jev's numbers mean

OpenRouter's explainer says TypeSafe calibrated Jev so that "when it says 0.8
... Jev is right about that kind of answer about 80% of the time", averaged over
many answers. TypeSafe's own model page adds that jev-1.13's "score levels are
weak in numerical calibration". Both say to pick thresholds from your own
labelled data.

On this question the scores are not calibrated. They form a steep S-curve.
These are the after-assistant candidates with `addressed` ≥ 0.5, in the
`2026-09-24.2` wording:

| `wants_reply` | Really for him | Rate used, smoothed (yes + 1) / (n + 2) |
|---|---|---|
| 0.6-0.7 | 0 of 5 | 0.14 |
| 0.7-0.8 | 9 of 16 | 0.56 |
| 0.8-0.9 | 27 of 28 | 0.93 |
| 0.9-1.0 | 37 of 37 | 0.97 |

So a 0.75 is a coin flip, and a 0.85 is right about 19 times in 20. The code
never treats the raw score as a probability. It looks up the measured rate.

## Runaway misfires: the streak budget

A wake can feed itself. Each message he sends opens a new `after-assistant`
window, including one sent because Jev woke him. After a misfire, people react
to what he said, and those reactions really are said to him. With nothing else
in the way, a misfire can chain.

History cannot measure this. Before this check, he never answered an un-named
message, so no conversation ever reacted to a misfire. So the guard is
structural, not a score.

**The streak** is the run of `after-assistant` wakes in a chat since someone
last addressed him on purpose: said his name, or swipe-replied to one of his
messages.

**The budget.** Each wake in the streak costs 1 minus its measured rate, and
the sum is the number of wrong wakes to expect. A new wake is allowed only
while that sum stays within `streak_budget` (0.6).

| Run | Cost per wake | What happens |
|---|---|---|
| Confident (0.9+, rate 0.97) | about 0.03 | About twenty in a row fit. A real back-and-forth is barely slowed |
| Middling (0.7-0.8, rate 0.56) | about 0.44 | One is allowed and the second is not. Four "0.75" wakes in a row cannot happen |

The streak resets when someone says his name or swipe-replies to him. It never
resets with time, because in a real runaway the errors reinforce each other.

**Derived, not stored.** Each check reads the streak from the records:

- chat.db gives the last message that named him or swipe-replied to him;
- `data/addressing.jsonl` gives the wakes after it, with the rate each was
  judged at.

A restart loses nothing, and there is no counter to drift. Checks in one chat
run one at a time, so two messages arriving together cannot both spend the same
budget.

**He sees the streak too.** From the second wake in a run, his note says it is
the Nth message in a row he was woken for without his name, and that the
longer the run, the likelier one of them was never for him.

**What the budget does not catch** is a confident mistake. A message Jev scores
0.86 is in a band that is right 93% of the time, so it passes. The
`opensWithNameOf` fact fixed the one such case seen live; the next will need a
better input, not a lower budget.

## Tried and rejected

| Idea | Why not |
|---|---|
| A second Jev watching the first for runaways | No runaway exists to calibrate it against. It would read the same messages and likely share the same blind spot (untested). And "N wakes since anyone said his name" is a count, which code gets exactly right |
| A `choice` question, "who is this for?" (assistant / someone else / everyone) | It separated worse than `wants_reply` (0.926 against 0.947 area under the curve). As a second condition it left 16 wrong wakes where the `addressed` floor leaves 12 |
| `addressed` alone | A plain thanks scored 0.92 |
| `min(addressed, wants_reply)` | It dropped working-thread instructions that score low on "said to him" |
| More history, or the group's culture notes | The area under the curve fell, as measured above |

## Recalibrating

1. Label messages in `data/addressing/labels.json`, which is gitignored:
   `{"labels": [{"row": <chat.db ROWID>, "label": "yes" | "yes-ish" | "ambiguous" | "no"}]}`.
   Live decisions in `data/addressing.jsonl` carry the row id, so the messages
   people corrected him on make good labels.
2. Run `bun scripts/addressing-calibrate.ts`. It rebuilds each row as of its
   own moment, asks Jev exactly what production asks, prints the table for
   several thresholds, and writes
   `data/addressing/calibration-<version>.json`. That file includes the `rates`
   the daemon uses. It costs about $0.00005 per candidate.
3. Restart the daemon to load the new rates.

Any change to the questions, criteria or state shape must bump
`ADDRESS_QUESTIONS_VERSION`, because scores move with wording. Rewording the
setting text once shifted the mean `wants_reply` from 0.33 to 0.27 on the same
messages. A table measured on another wording is ignored. Until the new
wording is calibrated, the rate falls back to Jev's own probability and the
daemon logs that it has done so.

## What is recorded

For each decision, `data/addressing.jsonl` holds:

- the row id and chat;
- the mode and the question version;
- the scores, whether the message opens with another member's name, and the
  measured rate and its source;
- the streak, whether it went over budget, and whether he was actually woken.

It never holds the text: chat.db has that.

## What leaves the machine

In `shadow` or `on` mode, each candidate sends Jev (through OpenRouter) the text of
the new message and the eight before it, the assistant's names, and the
senders as letters. No handles are sent, and no member names beyond what the
texts already contain. A call costs about $0.00005, with a median of 0.2 s.
