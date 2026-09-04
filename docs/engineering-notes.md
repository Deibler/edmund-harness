# Engineering notes

Things this project learned the expensive way, written as rules rather than as
stories. Most of them cost days. None of them are specific to iMessage or to
assistants, which is why they are worth a page.

`CLAUDE.md` at the root is the working version of this for anyone, human or
model, changing the code. This page is the part that transfers.

---

## Measure before you theorise, then measure again before you act

Twice in one week a confident, well reasoned recommendation would have made
things materially worse, and only a measurement caught it.

The first was raising a compaction threshold. The system was compacting at a
fraction of the model's context window, which looks absurd. Pulling the actual
cost curve first showed that cost per turn climbs steeply with context and that
the top bracket costs several times the bottom. Raising the threshold would have
moved every long conversation into expensive territory permanently. The obvious
fix was the exact opposite of correct.

The second was relaxing a send guard that was refusing to deliver, on the theory
that it was a false positive, with a month of evidence that nothing had ever
misdelivered. Relaxing it and then checking where the messages actually landed:
two of the next three went to the wrong thread. The guard was right. The
evidence had been clean precisely because the guard was working.

Ask for numbers before accepting a story, including your own story.

## Verify that a test can fail

A test that cannot fail is worse than no test, because it manufactures
confidence.

One guard here checked `args.includes("chatGuid")`, which silently matched
`session.chatGuid` in an unrelated line. It passed for every broken call site.
It was caught only by deliberately removing the fix and noticing the test stayed
green.

After writing a guard, break the thing it guards and watch it go red, then
restore it and watch it go green. Both directions, every time. It costs a
minute, and it is the difference between a test and a decoration.

Two adjacent traps this repository has actually hit: a printed FAIL that
registered no test, so the suite passed while announcing a failure; and a top
level `process.exit` in one file that truncated an entire run, reporting zero
failures because most tests never executed. Watch the count as well as the
colour.

## Check where things landed, not what the API reported

Sent is a claim. A send can report success and arrive in the wrong place. A
compaction can report success and have been aborted. A build can report success
and not have recompiled.

Verify against the system of record: the database, the file on disk, the
rendered output. Not the return value of the thing you just called.

## A comment cannot hold an invariant, a test can

The message routing bug had already been found, understood and fixed once, in
one of six call sites, with an excellent comment explaining exactly why it
mattered. The other five kept the bug for weeks. The knowledge existed, was
correct, and was written down in prose. Prose does not run.

If you are writing "remember to always" in a comment, that is a test you have
not written yet.

## When stuck, diff a working case against a broken one

After three failed attempts at guessing which private call was wrong, the
breakthrough came from capturing system logs during a broken action and a
working one from an identical starting state, then diffing them. The answer was
in the difference, immediately and unambiguously.

Find the nearest thing that works. Make the two cases as identical as you can.
Diff everything you can capture. This beats reasoning about what should be
different, which is what the three failed guesses were.

Three failed guesses in a row means the approach is wrong, not the guess.

## Distinguish no evidence from evidence of absence

"Zero errors since the fix" sounded good until someone noticed there had been
exactly one send in that window. Four minutes and one message cannot distinguish
a fix from a quiet afternoon.

State sample sizes. Say plainly when something proves nothing yet. A premature
"fixed" is a lie that gets believed for a week.

Related: a metric that goes quiet right after your change is not evidence your
change did it. Pull the pre change baseline and the hour of day baseline first.

## Assume the tooling can lie

A build system was silently not recompiling changed source, so three "this fix
did not work" conclusions were about code that was never built. A shell function
was shadowing a system command, so a diagnostic returned empty and looked like
"nothing there."

When a result is surprising, verify the tool ran at all before concluding
anything about the thing it measured.

## Once you find a bug shape, look for it elsewhere

The same structural bug turned up three times in one day in different places: a
size limit that could never be reached because the dominant content was exempt
from it. Finding it once and not looking for siblings would have left two live.

When you fix something, ask what the shape of this bug is, and where else that
shape exists.

## Prefer the deletion to the constant

A misconfiguration passed a hardcoded context window that was wrong for the
model. The fix was not to pass the right number, it was to pass nothing and let
the tool use its own metadata. Right today and still right when the models
change.

A fix that requires a number to be maintained will eventually be wrong.

## Validate where the value is used

A careful producer and a trusting consumer is not a boundary. One endpoint
sanitised its input; a second endpoint fed the same queue and did not. The check
belongs where the value is used, not where you happened to be thinking about it.

The same idea in a different costume: a guard taken on one path is not a guard.
A lock that names its three callers in a comment and is acquired by one of them
is not a lock, and the symptoms will point at whatever runs last.

## Derive from the keyed source

Never compute a claim from prose that a model filled in. If a fact has a
structured origin, read the structured origin.

Two failures of this shape are worth naming because they read as different bugs.
An unknown key is not an absent value: a lookup miss rendered as a confident
"out of stock" over a full shelf, because a missing entry and a zero entry took
the same path. And null can mean two different things: "none left" from a person
and "quantity not recorded" from a recipe collapsed into the same null and were
read as the first. Disambiguate at the write, not at the read.

## A confirmation a model can satisfy alone is not a confirmation

If the system asks a person to approve something, the approval must be provable
against something the model does not control. Here that is a last inbound
timestamp from a database the consent path never writes. Without it a model can
serve itself the prompt and answer its own question inside one turn, and the
gate is theatre that looks exactly like a gate.

## An empty result deserves suspicion before it deserves an explanation

A structural reason why a query returned nothing is a comfortable way to stop
looking. Prove the pipeline works on a case you know should match, then report
none.

## Leave the system in a known state

Long sessions accumulate temporary diagnostics, disabled services, reverted
files and half applied experiments. One temporary diagnostic here crash looped
an application for several minutes because it was left loaded.

Before finishing: revert scratch changes, confirm the service is healthy,
confirm the tree is clean, and say plainly what is deployed and what is not.

Note that reverting does not reach ignored state. Gitignored config and local
databases survive a `git revert`, so a revert can leave the system in a mixed
state that looks clean.

---

## On the private framework work specifically

The macOS 26 send behaviour described in [failure-model.md](failure-model.md)
was found here independently and is not documented by Apple. It is worth saying
that the OpenClaw project's `imsg` helper reached the same conclusion
separately, and its source carries a comment describing the same failure and the
same choice of dispatch path. Two independent reverse engineering efforts
landing on the same answer is the strongest evidence available that the answer
is right, and it is a better citation than either project's own confidence.

If you are working in this area, read both.
