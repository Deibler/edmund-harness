# Memory

The harness keeps several kinds of memory, and the difference between them is
mostly about cost. Some text is in the prompt on every turn of every
conversation. Some is in the prompt only for one conversation. Some is never
in the prompt unless a search pulls it in. A token in the first category costs
roughly fifty times what it costs in the second, and that asymmetry drives
every design choice on this page.

## The layers

| Layer | Where | When the model sees it | Who writes it |
|---|---|---|---|
| Identity, character, home, venue rules | `persona/IDENTITY.md`, `SOUL.md`, `HOME.md`, `VENUE_*.md` | Every turn | You, and the model through `remember_about_self` |
| Operating rules | `persona/AGENTS.md` | Referenced every turn | You, and `update_self_memory` |
| Person file | `persona/people/<slug>.md` | Every DM turn with that person | Scaffolded on first contact; the maintainer appends; the model can edit |
| Group file | `persona/groups/<slug>.md` | Every turn in that group | Same as person files |
| Operating principles | A section inside each person or group file | Rides with the file | The consolidator only |
| Domain notes | `persona/domains/<slug>.md` | Only through recall | The model through `remember_about_subject` |
| Archives | `persona/people/archive/`, `persona/groups/archive/`, `persona/archive/SOUL.md` | Only through recall | The archiver |
| Orchestrator overrides | `persona/orchestrators/<name>/` | Turns for that orchestrator | You |
| Session transcripts | `persona/sessions/` | Resumed by the provider, not injected | Claude Code or Codex |

The whole directory is plain markdown. You can open any file, read what the
assistant believes, and change it. Edits apply on the next turn; the prompt
builder hashes the persona files and a changed hash forces a fresh worker
rather than a stale cached prompt.

## Person files

A person file is created the first time someone messages. It has a fixed set
of sections and the maintainer appends dated bullets to them, one line each,
in the form `- **2026-09-03** — what was learned`. Duplicates within a
section are dropped.

The whole file is injected into every DM turn with that person as an
`About <name>` block. Guests never get a person file, and group turns get the
group file instead.

### The maintainer

`src/persona/maintainer.ts` runs one to two minutes after a delivered reply,
no more often than every fifteen minutes per session, and only if something
came in since the last run. It makes a single call on a small model
(`people_maintainer.model`, Haiku by default) with the current file and the
last thirty messages, and gets back a list of notes to append. It is an
extraction pass: it asks what is worth adding.

### The consolidator

Appending forever produces a file that gets longer without getting wiser. One
person file reached 105 observations, three of which circled the same rule
without ever stating it. The consolidator (`src/persona/consolidate.ts`) runs
when twelve or more new bullets have accumulated since it last ran, and asks a
different question: what are the rules for this person, and which of them did
recent evidence contradict. It rewrites the `Operating Principles` section
wholesale, at most ten principles, each with the dates that support it.

For groups the prompt separates how the room behaves from how the assistant
should behave in it. A group's register is contagious, and the pass is written
to correct drift rather than ratify it.

### The archiver

`src/persona/archive.ts` is deterministic and runs at boot and after each
maintainer pass. When a file passes 8 KB it moves the oldest dated bullets out
of the learned, shared history and open items sections into
`archive/<same name>.md` until the file is under 6 KB, keeping the newest
fifteen per section and leaving a pointer line. Archived text is indexed for
recall, so nothing is lost, it just stops costing tokens on every turn.

The same pass runs over `SOUL.md`. A bug worth knowing about: the original
heading pattern matched `##` but not `###`, so every third level subsection
was invisible to the size gate and one grew to half the system prompt while
the gate reported nothing to do. The shape of that bug, a limit that cannot be
reached because the dominant content is exempt, appeared three times in one
day. When you fix one, look for siblings.

### Order matters

The pipeline is append, then consolidate, then archive. Consolidating after
archiving would derive a person's rules from a file the archiver had already
thinned. A test pins the order because the failure is otherwise silent.

## Self memory

`SOUL.md` is the assistant's own evolving account of who it is and what it
has learned about itself and its operator. `remember_about_self` appends a
dated bullet under one of five subsections and refuses notes over 500
characters. `update_self_memory` rewrites a file and keeps a `.bak`. Because
this file is in every turn of every conversation, it is the most expensive
place to put a sentence, and the archiver keeps it small.

## Domain notes

`remember_about_subject` writes a lesson about a subject rather than a person
into `persona/domains/<slug>.md`. Domain notes are never injected; they reach
a turn only through recall. That makes them the right place for things worth
knowing but not worth paying for on every message.

## Recall

Recall is a local search index over messages, persona files, archives,
sandbox artifacts and skill descriptions.

- **Store**: `data/recall.sqlite`. Vectors are stored as float32 blobs and
  compared in process; a full text index gives a BM25 leg; the two are fused,
  deduplicated, diversified and boosted for recency.
- **Embeddings**: the default provider runs `Xenova/bge-small-en-v1.5` in a
  worker thread with no network. OpenAI and Ollama providers are available.
- **Indexer**: every sixty seconds it walks new `chat.db` rows, person and
  group files by modification time, `SOUL.md` and its archive, sandbox
  artifacts and skills.
- **Auto-recall**: before each turn, if the message has a subject at all, the
  harness searches this chat's recent history outside the window already in
  the prompt, this chat's deep history older than thirty days, the sender's
  messages in other shared chats for groups, and at most one matching skill.
  Hits already shown since the last compaction are not shown again. Live
  person files are excluded because they are already in the prompt.

Recall is scoped to the conversation. The harness does not search one
person's messages to answer another person's question.

## Tools the model has

| Tool | Effect |
|---|---|
| `remember_about_person` | Append a dated note to the current person file |
| `read_person_file`, `write_person_file` | Read or rewrite the current person file |
| `remember_about_subject` | Write or extend a domain note |
| `remember_about_self` | Append a dated bullet to `SOUL.md` |
| `read_self_memory`, `update_self_memory` | Read or rewrite a persona file |
| `memory_search`, `semantic_search` | Query the recall index |
| `catch_me_up` | Summarise a thread; the summary is stored for recall |

## Working with the persona by hand

- Keep `IDENTITY.md` short. It is read on every turn and a page of character
  does more than five pages of instructions.
- Write rules as behaviour, not aspiration. "Lead with the answer" beats "be
  helpful."
- If you want the assistant to stop believing something, edit the file. It is
  the source of truth and the model will see the change on the next turn.
- Back up `persona/` like you would a journal. It is gitignored because it
  fills with details about real people.

The design here follows published work rather than invention: reflection with
citations from Generative Agents, distilled strategies that mine failures from
ReasoningBank, and the core versus archival split from MemGPT.
