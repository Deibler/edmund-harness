# The failure model

[recovery.md](recovery.md) is the operator page: what happens when something
breaks and what you will see. This page is the stance behind it, which comes
down to one sentence.

**A successful call is a claim, not an outcome.**

That applies to sending a message, to compacting a session, to a build, and to
a test. Almost every hard bug in this project's history has been a place where
something reported success and had not happened, and the fixes are mostly the
same move applied in different places: check the system of record instead of the
return value.

## Sending: verify against chat.db

The send path returns success from a private Apple framework. What that means
is that the call was accepted, and it is entirely compatible with the message
landing in the wrong conversation.

That is not hypothetical. On macOS 26, `[IMChat sendMessage:]` wraps a private
method with a flag that makes Messages rewrite the chat's own recipient after
the send. A notification fires, and the chat's identity becomes the account
owner's address. The message that triggered it arrives correctly; the **next**
one misroutes. The symptom is every other message failing, and the sidebar
showing your own name on someone else's thread.

Three things follow, and all three are load bearing.

**Every send is verified against `chat.db`.** After the send the daemon looks
for the message and checks which chat it actually appeared in. The registry the
send went through can hold a chat object whose identifier, participants and
recipient have all been relabelled while `chat.db` is perfectly correct, so the
database is ground truth and the API is not.

**A refusal is treated as correct until disproven.** The bridge refuses to send
when the chat it resolved is not the one that was addressed. That guard looked
for a month like a false positive, because nothing had misdelivered while it was
running. Relaxing it as an experiment sent two of the next three messages to the
account's own note to self thread. The evidence of "nothing misdelivered" existed
precisely because the guard was working. If it fires, fix the resolution.

**A timeout is not a rejection.** A send that times out can still flush later,
so retrying on timeout produces duplicates. Check `chat.db` before retrying,
not the error.

How the root cause was found is worth repeating as a technique, because three
attempts at guessing the wrong selector came first. The answer came from
capturing the system log during a send from the bridge and during the same
message typed by hand in the UI, from an identical starting state, and diffing
them. When stuck, find the nearest thing that works, make the two cases as
identical as possible, and diff everything you can capture. That beats reasoning
about what should be different, which is what the three failed guesses were.

## Failures are classified, and each class has a structural repair

`src/recovery/classify.ts` turns a raw error string into one of ten named
classes. It is pure, table driven, and ordered so that specific patterns match
before generic ones. The patterns are loosely anchored on purpose, so they
survive whatever framing the selected CLI wraps the underlying error in.

Adding a failure mode is one row in the classifier table and one row in the
descriptions table, and the tests are table driven so a regression in either is
loud.

Each class maps to a healer in `src/recovery/healers.ts` that applies a
structural fix before anything is re-invoked:

| Class | Repair |
|---|---|
| `request_too_large` | Shrink the session transcript |
| `image_dim_exceeded` | Downscale the offending image |
| `stale_session_id` | Drop the provider thread id and start clean |
| `bad_tool_ids` | Repair the persisted tool ids the API rejects on resume |
| `session_in_use` | Nothing. The session lock backoff already resolves it |

That last row matters as much as the others. A class whose correct handling is
"do nothing, something else owns this" is written down as `null` rather than
left out, so the absence is a decision on the record rather than a gap.

Healers never spawn a model. They mutate state idempotently and report whether
anything actually changed. The "re-invoke afterwards" step belongs to the layer
above, which keeps the repair testable in isolation.

## The sweeper and the honest internal note

A sweep looks for conversations where a person sent something and never got a
reply, past a staleness threshold, with nothing in flight, outside cooldown, and
not too old to be worth answering.

It heals first, then runs a recovery turn: the model is invoked with an envelope
containing the failure class, how long has elapsed, and the full batch of
unanswered messages. That context is internal and is never shown to the person.

The design choice here is that the model is told the truth about what went wrong
and then decides what to do about it, including saying nothing. The alternative,
a canned apology, is both worse to receive and unable to handle the case where
the right move is to just answer the question that was asked forty minutes ago.

## Delivery is not a conversational event

A reply that fails to send goes to an outbox. The original bug was that the
outbox only drained when a turn ran for that conversation, which meant a reply
the assistant had already written sat undelivered until the person wrote again,
and then arrived stacked on top of the new message, reading as an answer to it.

The drainer now runs on its own clock. A reply blocked by a transient routing
failure goes out seconds later, on its own, in its own turn's place, and the
next inbound finds an empty queue.

A queued reply also never triggers another model call. Re-invoking on a delivery
failure spends money to regenerate something that already exists and is fine.

## Never suppress a reply programmatically

Two messages arriving back to back, or one arriving mid turn, is a real problem
with an obviously wrong solution: drop one.

The rule here is that a reply is never blocked by code. Double replies are fixed
with bookkeeping and context, by coalescing the messages into one turn and
telling the model what it is looking at, so the model decides what to say. A
programmatic suppression hides the situation from the one component that can
actually judge it, and the failure mode is silence, which is the worst possible
output because nothing reports it.

The related rule: an empty reply means silence. There is no such thing as a
status note addressed to nobody. "No message needed, but for the record" ships
to someone's phone.

## Barge-in is deliberately conservative

A message parked behind a turn that is already running may be asking to stop or
redirect it. When it is, the turn is aborted and the parked message is
re-enqueued as its own fresh turn, so a cancellation is answered in seconds
rather than after minutes of doomed work.

The detection is narrow on purpose, and the asymmetry is the reason. A false
positive kills a healthy turn and its warm worker, costing a cold respawn and
whatever tool work was in flight. A miss costs nothing beyond parking the
message, which is what would have happened anyway.

So only two shapes qualify. Either the entire message is a recognised cancel
word, or it opens with a redirect word and contains an explicit cancel or
replace verb shortly after. "Wait, don't send that" matches. "Actually can you
also" does not.

## A test that cannot fail is a decoration

One guard here checked `args.includes("chatGuid")`, which silently matched an
unrelated line containing `session.chatGuid`. It passed for every broken call
site. It was caught only by deliberately removing the fix and noticing the test
stayed green.

The routine that follows: after writing a guard, break the thing it guards and
watch it go red, then restore it and watch it go green. Both directions, every
time. It costs a minute.

Two related traps this repository has actually hit. A printed FAIL that never
registered a test, so the suite passed while announcing a failure. And a top
level `process.exit` in one file that truncated an entire run, reporting zero
failures because most tests never ran.

## A comment cannot hold an invariant

The misrouting bug had already been found, understood and fixed once, in one of
six call sites, with an excellent comment explaining exactly why it mattered.
The other five kept the bug for weeks. The knowledge existed, was correct, and
was written down in prose, and prose does not run.

If you find yourself writing "remember to always" in a comment, that is a test
you have not written yet.

## Where to read the code

| File | What it holds |
|---|---|
| `src/recovery/classify.ts` | The ten classes and their patterns |
| `src/recovery/healers.ts` | One structural repair per class |
| `src/recovery/sweeper.ts` | Finding stuck conversations |
| `src/recovery/turn.ts` | The recovery envelope and replay bookkeeping |
| `src/recovery/outbox-drainer.ts` | Delivery on its own clock |
| `src/channels/barge-in.ts` | Cancel and redirect detection |
| `src/imessage/actions/verify.ts` | Post send verification against `chat.db` |

More of these in [engineering-notes.md](engineering-notes.md).
