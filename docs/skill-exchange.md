# Skills as an exchange between people

[skills.md](skills.md) is the operator page: what a skill is, how to write one,
where they live. This page is about the part that is unusual, which is what
happens when one person's playbook is offered to someone else.

A skill starts as a note to self. The model can write one for itself while
working in a conversation, and most stay there. The interesting question begins
when one is published, because a published skill is instructions that will be
read on behalf of people who have never met its author, and dropped into a model
context that is about to act.

Three separate gates handle three separate questions, and keeping them separate
is most of the design.

| Question | Answered by | When |
|---|---|---|
| May this author publish this? | `publish.ts` | At publish time |
| Does the text carry someone else's business? | `privacy.ts` | At publish time |
| Does this reader want a stranger's instructions? | `consent.ts` | At first read, per conversation |

## Publishing: three mechanical rules

**Only the owner publishes.** Ownership is the conversation a skill was authored
in, not its current visibility. That distinction is the whole rule: a skill
shared with everyone has no scope, so checking scope rather than origin would
let anyone who could see it publish it.

**Nothing personal leaves.** The publisher may be named in their own skill.
Nobody else may be. That is the leak scan, below.

**It is reversible.** Unpublishing restores the original scope and revokes every
consent that was given. Editing a published skill also revokes consent, because
the yes people gave was to the text they were told about, not to whatever it
later becomes.

## The leak scan, and why it is biased toward false positives

The same check guards three outbound surfaces, and each is dangerous for a
different reason. Curated skills are distilled from many people's conversations
and published to everyone, and nobody in those conversations agreed to that.
Published skills carry an author who consented for themselves out of a
conversation full of people who did not. Announcements are written by hand at a
moment when the author is thinking about a feature rather than about privacy.

Two commitments make it work, and both were learned by watching it fail.

**The roster has to be the real one.** An earlier version iterated only the
contacts listed in `config.toml`, which in a real deployment was a single entry.
The scan therefore ran over one person, reported clean on text that plainly named
several others, and looked like it was working. Names now come from four sources
at once: config contacts, the macOS address book, every person file and every
group file. The person files matter most, because in this deployment the address
book holds 34 people while the harness knows 81. A scanner that iterates the
wrong collection passes everything.

**Every ambiguity resolves toward flagging.** A false positive costs the author
one reword; a false negative ships someone's name to strangers. So an
unrecognised word is treated as a name. The only tokens given a weaker rule are
ones that are demonstrably ordinary English, which match only when capitalised,
because "a hunter" and "the grace period" are not people while "Hunter" and
"Grace" probably are. That list being incomplete makes the scan stricter rather
than laxer, which is the correct direction for a list nobody will remember to
maintain.

The minimum name length is three characters rather than four. Four silently
exempted Jon, Ana, Ben, Amy, Joe and Kim. Two would collide with initials
everywhere.

Alongside names it looks for phone numbers in the shapes people actually type,
email addresses, social handles, and street addresses.

## Consent: two properties that make it a gate rather than a request

The first time a conversation would use a public skill, the assistant asks out
loud: there is a skill for this from Sam, want me to use it?

**The body is withheld, not the reminder.** Reading an unconsented public skill
returns the consent stub instead of the skill text. The instructions cannot
reach the model's context by the model forgetting to ask, because they are never
sent. A prompt rule saying "please ask first" is a comment, and a comment cannot
hold an invariant.

**Consent needs a human turn.** Recording a decision is refused unless the
conversation has received an inbound message since the stub was served. Without
that check, the model could serve itself the stub and answer its own question
inside a single turn, and the ask would be theatre. The proof is the last inbound
timestamp in `state.db`, a keyed source that the consent path does not write and
cannot influence.

That second property generalises past skills, and it is the more useful half of
this page. **A confirmation step that a model can satisfy on its own is not a
confirmation step.** If you are adding one, find a value that only the outside
world can change, and check that.

The group rule is different because the situation is. If the publisher is in the
room, their presence is the introduction and nothing is asked. The confirmation
exists for a room using someone's skill behind their back.

## Discovery, and the measurement that shaped it

Skills are only useful if they get read. Over four months, skills were read on
about 5% of conversational turns, and 82% of those reads were the four skills
the system prompt happens to name by hand. Everything else was effectively
invisible.

The obvious fix is to advertise. The obvious fix is worse than the problem: a
suggestion attached to every turn trains the model to skip the block, and a
wrong suggestion sends it off to read three thousand tokens of the wrong
playbook, which costs both money and a bad answer. Embedding similarity does not
rescue this either, because the thing being matched is an intent, and a skill
description is a title.

So recall suggests at most one skill, and only on a clear match. A curator
proposes new skills from what people actually ask for, on a cadence with a cap,
rather than the model being nudged toward the ones that already exist.

## Where to read the code

| File | What it holds |
|---|---|
| `src/skills/publish.ts` | The three publish rules |
| `src/skills/privacy.ts` | The leak scan, its roster and its bias |
| `src/skills/consent.ts` | Withheld bodies and the human turn proof |
| `src/skills/curator.ts` | Proposing skills from real requests |
| `src/skills/provenance.ts` | Who authored what |
| `src/skills/installer.ts` | The registry and install records |
