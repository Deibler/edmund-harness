# Proactive behaviour

Most turns start with a message. This page covers everything that wakes the
model without one, how each path is rate limited, and the one rule they all
share: the harness never decides on the model's behalf that a reply should be
dropped.

## The shared wake path

Every proactive mechanism reaches a session the same way. It inserts a
one-shot row into `cron.db` and pokes the scheduler, which resumes the
session under its lock with a framed envelope describing the event. There is
no private route into a session. That single path is what keeps recovery,
integrations, relays, triggers and reminders from stepping on each other.

## Reminders and cron

`src/cron/` runs one timer in one process, armed for the next due job.
Recurring jobs past their grace period are skipped rather than fired late in
a burst. Retryable failures retry three times at five minute intervals. A
reply that cannot be delivered goes to the outbox rather than being lost.

The model creates jobs with `schedule_reminder` and friends, and can `poke`
itself to continue a task in ten to three hundred seconds.

## Missions

A mission is a recurring cron job with a brief and a notes file at
`sandbox/<slug>/missions/<name>.md`. The routine checks are silent. The
model speaks only when the mission produces something worth saying.

## Data triggers

`src/triggers/` lets the model write a probe (a URL to fetch, a script to run,
a chat to watch for silence) and a predicate over its result. The daemon
evaluates the pair on a schedule with no model involved and fires a one-shot
cron only when the predicate flips. Failures back off exponentially to an
hour; five consecutive failures alert the operator and twenty four disarm the
trigger.

## Refresh scripts

`src/refresh/` runs model-authored deterministic scripts on a schedule and
applies their output directly, for example to a display. Zero model tokens
per run. The model is woken only when a script fails persistently.

## Ghost: reaching out first

The ghost is the observer that decides whether the assistant should message
someone without being messaged. Its configuration section is called
`[brown_nose]` and its per-person prompt is `persona/GHOST.md`. It is off by
default.

### How a tick happens

`GhostObserver` (`src/ghost/observer.ts`) ticks on a randomised sweep, one to
two minutes after each delivered reply, and at the start of a person's active
window. Per session there is a floor of 45 minutes between ticks and a daily
cap on ticks counted from the spend ledger.

A tick first passes pure budget gates that cost nothing: enabled for this
person, inside active hours, past the cooldown (with jitter and engagement
decay), under the weekly cap, no outstanding fire. Then an optional small
model pre-screen. Only then does a tool-using run on the ghost model decide,
and it must call `submit_decision`. Decisions are appended to
`sandbox/<slug>/brownnose/decisions.jsonl` so you can read why it did or did
not act.

### Intensity

One knob from 1 to 10 sets the cooldown (a week down to four hours), the
weekly cap (one to fourteen), the sweep cadence and how eager the prompt is.
Each person has their own setting, adjustable by them through the portal or by
the model through `set_brown_nose`.

### Firing

A decision to act becomes a jittered cron row at least 48 hours after the last
fire. When it fires, the budgets are re-checked, a global semaphore allows
three concurrent proactive turns with 90 seconds between starts, and the main
model runs with a proactive envelope. The reply is delivered unless the model
answers `KEEP_QUIET`. The outcome, whether the person engaged, reacted,
ignored, pushed back or vetoed, feeds back into the decay.

## Announcements

`src/announce/` tells regular users about capabilities they have not tried.
It never sends a message. When an eligible person (active on twelve or more
distinct days) writes in, a short block is added to that turn and the model
works it in only if there is a natural opening. Each person hears about a
given capability at most a configurable number of times. Delivery is
confirmed by the portal token appearing in the outbound text, not by the
block having been offered.

The threshold is worth setting from your own data: sort the people who wrote
in over the last thirty days by distinct active days and put the line in the
clear air between the regulars and the occasional texters. An unprompted pitch
to someone who barely texts reads as spam and cannot be taken back.

## Catch-up

At boot, before the live watcher starts, the daemon replays orphaned inbound
acks and answers the whole backlog since the saved cursor with one coalesced
turn per conversation. The reply reads as a single catch-up rather than a
burst of late answers.

## The rule

The harness never suppresses a model reply programmatically. The only two
ways a reply is dropped are the model's own `KEEP_QUIET` sentinel and a reply
that sanitises to nothing. Double replies are prevented with session locks,
the pending queue, draining the outbox before any new model call, and
cancelling retries once a turn covers a message. If you find yourself wanting
to add an `if` that stops the model from speaking, the fix belongs in
bookkeeping or context instead.
