---
"edmund-harness": minor
---

Add a computer-use MCP server (`src/mcp/computer-use`) that lets Edmund see and drive native Mac apps. It has the same 24 tools and parameters as Claude Code's built-in computer-use server, which only runs in interactive sessions, plus a required `explanation` of at least 100 characters on every tool.

Only iMessage and SMS conversations get it, each with its own app list in the new `[computer_use]` section. The owner is recognised by handle (`[security] operator_handles`, else `[alerts] operator_handle`), never by `contact_tier`, which grants host access and would otherwise hand every contact the owner's screen. Every other DM and group gets `contact_apps`, and only while the safety check enforces. Guests, the mirror and sub-agents get nothing.

Before any action runs, the harness checks it in its own code first and then asks Jev (`typesafe/jev-1.13`, through OpenRouter). Jev receives the action in words, who asked and from which conversation, their latest messages from chat.db, and the model's explanation. The action is refused if the check cannot run. In `shadow` mode verdicts are only recorded, without holding up the action; each verdict records its request attempts.

Some things are always refused, without asking Jev: shortcuts that end the session, quitting Messages, and typing into password fields. Messages actions are limited to the conversation the request came from, and Notes edits to the requester's household list, which the kitchen integration supplies through `screenScope`. Contacts' screenshots show only granted apps, with every other conversation and list blacked out.

One conversation drives the screen at a time: another waits up to two minutes, then is told the screen is busy. When a turn ends the daemon signals that conversation's server, which quits the apps its turn launched (by process, never Messages, never an app that was already running) and releases the screen. The feature is off by default.
