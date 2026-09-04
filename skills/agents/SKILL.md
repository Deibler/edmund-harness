---
name: agents
description: Delegate long-running work (research, deep summaries, multi-step analysis) to detached sub-agents. Edmund orchestrates; the sub-agent does the task in the background. MANDATORY for any task >30s — spawning releases the session lock so new messages are processed immediately.
---

# agents

Edmund is the orchestrator. Sub-agents are the workers.

## The mandate

**Any task >30 seconds MUST use `spawn_agent`.** Never run long work inline.

Why: while a `claude -p` turn is running, the session lock is held. New messages queue and the user gets no response until the turn ends. Spawning an agent releases the lock immediately — Edmund ends its turn, and new messages flow through normally. The agent runs in the background; Edmund is woken up when it finishes.

## When to spawn

Spawn when:
- The task will take more than ~30 seconds (deep research, long article summarization, code analysis across many files, video generation pipeline, anything multi-step).
- You want to run two or three investigations in parallel.
- You want to reply to the user *now* and deliver the deeper answer once it's ready.

Don't spawn for:
- Simple one-shot lookups (a single web fetch, one tool call, a quick calculation). Those run fine inline.
- Something that requires the user's iMessage context (sub-agents don't share your persona or person-file memory).
- Media generation (`generate_image` / `generate_video` have their own paths — they're already non-blocking).

## The standard flow

```
user: "research the top iMessage bots and give me a comparison"
edmund: check_incoming()                        ← any follow-ups before starting?
        send_message("on it, give me a few")
        spawn_agent(task: "Research the 5 most popular iMessage bot frameworks...")
        → returns agent_20260420_xxx
        → turn ends immediately, session lock released
user (sends a new message while agent runs): "also how are you doing"
        → processed normally — no lock contention
agent finishes → Edmund gets a wake-up event automatically
edmund: read_agent_result(id) → reformat → send reply
```

Wake-up is automatic — when an agent finishes, a cron event fires in the parent session. You do NOT need to poll. The wake-up envelope looks like:

```
[Scheduled event]
A sub-agent you spawned has finished (status: done).
Agent id: agent_...   Task was: ...
Read the result with read_agent_result("agent_...") and relay it to the user.
```

When you see this, deliver immediately — read, reformat, send. The user is waiting.

## Mid-task preemption (handoff_current_work)

If you started inline work and then realized it's longer than expected, OR `check_incoming()` shows the user sent a follow-up, use `handoff_current_work`:

```
edmund: [already partway through long research inline]
        check_incoming() → "actually can you also order me a pizza lol"
        handoff_current_work(
          work_done: "Found 3 sources on X, drafted outline...",
          work_remaining: "Finish research, compile comparison table, write summary.",
          context: "User asked for top 5 iMessage bot frameworks comparison."
        )
        → spawns agent_20260420_yyy with full context
        send_message("haha on it — also handed the research off, I'll send it when done")
        → turn ends fast, Edmund handles pizza ask inline next turn
```

The agent picks up exactly where you stopped. Edmund wakes up when it finishes.

## Writing a good task

The sub-agent has **no memory of this conversation**. Everything it needs goes into the `task` string. Include:

1. The goal in one sentence.
2. The shape of the deliverable (number of items, bullet vs prose, with or without sources).
3. Any constraints (timeframe, sources to avoid, format).

Bad: `"research iMessage"`
Good: `"List 5 iMessage-compatible messaging frameworks. For each give: name, what it is in one line, the GitHub org, macOS version support, and one differentiator. Skip anything that's Android-first. Return as a numbered list."`

## Tools the sub-agent has

Full MCP palette (generation, history, skills, Bash, Read/Write, etc.) inside its own sandbox at `<parent-sandbox>/agents/<id>/`. It cannot:

- Send iMessage text (`send_message`) or attachments (`send_attachment`) — session key is `agent:<id>`, which doesn't resolve to a chat.
- Access Edmund's person-file or cross-conversation memory.

This is by design. The sub-agent is a focused worker. Edmund is the relay.

## Managing in-flight agents

- `list_agents()` — all agents from this conversation, newest first
- `list_agents(status: "running")` — just the active ones
- `check_agent(id)` — status + log tail; useful when the user asks "what's it doing?"
- `cancel_agent(id)` — when the task's obsolete
- `read_agent_result(id)` — only when status=done

## Reporting back to the user

When you read a result, **don't paste it raw**. The sub-agent's output is structured for you, not for iMessage. Reformat:

- Strip headers and markdown.
- Compress to the iMessage bubble-friendly shape from SOUL.md.
- Lead with the takeaway; follow with the supporting bullets.
- If the result is long, send the takeaway as text and attach the full `result.md` via `send_attachment`.

## Teams (multi-agent coordination)

For multi-stage pipelines or parallel investigation, use `spawn_team` instead of N individual `spawn_agent` calls:

- **`spawn_team(members)`** — one call spawns a coordinated group with a shared `team_id` and a shared scratch dir (`<parent-sandbox>/teams/<team_id>/shared/`). Members can drop files there for handoff.
- **`list_team(team_id)`** — progress across all members.
- **`read_team_results(team_id)`** — role-keyed map of all member results.
- **`cancel_team(team_id)`** — kill the whole group.

Team completion fires ONE wake-up event when all members settle (not one per member). Individual `spawn_agent` fires per-completion.

Pre-shaped team patterns live in `skills/teams/`:
- `research-trio` — scout + summarizer + verifier for researched answers.
- `compare-options` — one agent per named option, same criteria for all, for side-by-side comparisons.

`list_skills(query: "team")` to see what's there. Read the skill, tailor the task strings to the topic, call `spawn_team`.

## Proactive delivery

When an agent or team finishes, Edmund gets an automatic wake-up event in the parent conversation. The event envelope will read like:

```
[Scheduled event · <timestamp>]
A sub-agent you spawned has finished (status: done).
Agent id: agent_...
Task was: ...
Read the result with `read_agent_result("agent_...")` and relay it to the user.
```

When you see one of these, treat it as a prompt to deliver: read the result, reformat, send. The user is waiting on this — don't just acknowledge the event, finish the relay in this same turn.

## Anti-patterns

- Spawning an agent for a task you could do in one inline tool call. Wastes tokens and adds latency.
- Writing vague tasks ("research X") and expecting structured output. Pin down the shape.
- Calling `spawn_team` when one `spawn_agent` would do. Teams have overhead (N API calls, shared-dir bookkeeping); only use them when the work genuinely splits across roles.
- Pasting raw sub-agent output into iMessage. Reformat first.
- Ignoring the proactive delivery event. If the envelope says an agent finished, actually deliver.
