# Skills

A skill is a markdown document that teaches the model a procedure. It costs
nothing until the model reads it, it cannot run anything by itself, and adding
one needs no restart. Skills are how this project grows capability without
growing the system prompt.

## How a skill reaches the model

The model calls `list_skills` and gets one line per skill: the name and the
description from its frontmatter, grouped by where it came from. It calls
`read_skill` to get the full text of one. That is the whole mechanism. Nothing
about a skill is injected into the system prompt, with two exceptions the
prompt names explicitly: the weather skills for anything about weather, and
the video skill for anything involving ffmpeg.

The system prompt tells the model to list skills before any multi step task.
That instruction exists because of a measurement: skills were being read on
about five percent of turns, and eight of them had never been opened.

## Anatomy

A skill is a directory under `skills/` with a `SKILL.md` in it. The directory
name is the skill name. The loader reads exactly one field from the
frontmatter, a single line `description:`, and ignores everything else. Every
other field you see in shipped skills is there for humans.

```markdown
---
name: my-skill
description: One line that says what this does and when to reach for it.
---

# my-skill

Instructions the model can follow cold. Name the exact tools to call, the
output you expect, and the mistakes to avoid.
```

Anything else in the directory, such as `scripts/`, `templates/` or
`reference/`, is yours to organise. Scripts are run by the model through its
own shell tool exactly as the skill instructs, with the working directory set
to the session's sandbox. Nothing installs dependencies for you, so a script
that needs a Python package needs a sentence telling the model what to check.

A test, `tests/skill-drift.test.ts`, pins that every skill has frontmatter
with a description and that every `tool_name(` a skill tells the model to call
actually exists.

## Where skills come from

| Kind | Written by | Visible to | Governed by |
|---|---|---|---|
| Shipped | the repository | every session | nothing; they are part of the project |
| Self | the model, mid conversation, through `create_skill` | that chat, or everyone if shared | the chat that wrote it can update or publish it |
| Curated | the curator, in the background | every session | usage based retirement and periodic review |
| Public | a person, by publishing a self skill | every session, body withheld until consent | the publisher, and each reader's consent |
| Marketplace | `install_skill` from an allowlisted GitHub repository | every session | operator approval when scripts are present |

The record for anything other than a shipped skill lives in
`data/installed-skills.json`. A skill scoped to one chat answers "no such
skill" from any other chat, so its existence does not leak.

## Consent

When one person publishes a skill, other people's conversations can use it.
The body is withheld until each reader has said yes. The consent module's own
header puts the reasoning well: a prompt rule saying please ask first is a
comment, and a comment cannot hold an invariant. So `read_skill` returns the
question instead of the body, and `confirm_skill_use` refuses unless a human
message arrived after the question was asked. That check reads the session's
last inbound timestamp from the database, a source the consent path does not
control. The publisher never needs consent for their own skill, and a group
where the publisher is present does not either.

Consent is revoked wholesale when a published skill is edited, unpublished or
retired.

## Publishing and the leak scan

`publish_skill` works only on a self skill, only from a DM, and only by the
chat that wrote it. Before anything becomes public it passes a scan for
emails, phone numbers, handles, street addresses and every known contact
name, assembled from the config, the address book and the person files. An
earlier version of the scan checked one contact and passed everything; the
current one treats unknown capitalised words as names. The same scan runs on
announcement text.

## The curator

Once a day, if enabled, a background pass reads a sample of recent human
messages across conversations and may propose at most one new skill, with
citations to the messages that justify it. A proposal must cite at least three
messages from at least two different chats and pass the leak scan. Curated
skills are instructions only, never scripts. There is a hard ceiling on how
many can exist.

The same pass retires a curated skill nobody has read in thirty days and
reviews any that has been read three times, by looking at what people actually
asked in the half hour before each read. The curator's header states its
design goal: nothing here has to be kept current by hand, because the moment
it needs feeding it will stop being fed.

## Marketplace installs

`edmund skills install <name> <owner/repo>` fetches `marketplace.json` from an
allowlisted repository and walks the skill's directory through the GitHub API.
It refuses symlinks, submodules, files over a megabyte and directories over
two hundred files, and scans for a list of dangerous shell patterns. A skill
that ships scripts is installed but inert until `edmund skills approve`, and
`read_skill` prepends a banner telling the model not to run them until then.

## Shipped skills

Twenty nine skills ship in `skills/`. Roughly two thirds are general purpose:
delegating to agents and teams, deep research, generation and iterative
editing of images, video work, voice memos, GIF search, summarising links,
ghostwriting, troubleshooting a device from a description or a photo, sharing
a web artifact through a temporary public URL, iterative visual design, and
two design guideline references (one from Anthropic under Apache 2.0, one
that fetches Vercel's guidelines at runtime).

The rest are tied to particular hardware, services or places: a smart mirror,
a sky camera, a fishing data platform, a radar application, a household
kitchen ledger, a hiking brief generator and a trading loop. They ship as
examples of what a skill can carry. Expect to delete or rewrite them for your
own setup, and expect the ones that name a location to need a new one.

## Writing your first skill

1. `mkdir skills/my-skill` with a lowercase, hyphenated name.
2. Write `skills/my-skill/SKILL.md` with the frontmatter above. Keep the
   description to one line; it is the only text the model sees before deciding
   to read the skill.
3. Write the body as steps the model can follow with no other context. Name
   the tools. State the output format. List the failure modes you have seen.
4. Run `bun test tests/skill-drift.test.ts`.
5. Ask the assistant to do the thing. Watch the log for `read_skill`. If it did
   not read the skill, the description did not match how the request was
   phrased; fix the description before touching the body.

## Skills, tools, integrations

A **skill** is text the model reads. A **tool** is a typed function the model
calls, registered in `src/mcp/tools/` or an integration. An **integration** is
a package that can contribute tools, a daemon runtime and prompt instructions,
and can own skills so they disappear when it is turned off. A skill usually
tells the model which tools to call; the drift test keeps the two in
agreement.
