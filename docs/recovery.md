# Recovery and safety

A turn can fail in a dozen ways: the provider rejects an oversized request, a
resumed thread no longer exists, Messages.app relabels a chat, a worker hangs.
This page covers how failures are classified, what fixes them, and the guards
that refuse to act rather than act wrongly.

## Classification and healers

`src/recovery/classify.ts` maps an error to a failure class:
`request_too_large`, `image_dim_exceeded`, `stale_session_id`,
`session_in_use`, `bad_tool_ids`, `invalid_tool_schema`,
`empty_content_block`, `transient_api`, `send_failed`, or `unknown`.

`src/recovery/healers.ts` has one structural fix per class: compact the
session transcript's images down to a size the provider accepts, downscale an
image over 2000 pixels, drop a stale thread id so the next turn starts cold,
rewrite bad tool ids and evict the warm worker, or relaunch Messages.app
through the supervisor. The runner applies the healer in band and retries
exactly once. The sweeper applies the same healers out of band.

## The sweeper

Every sixty seconds `src/recovery/sweeper.ts` looks for sessions whose last
inbound is newer than their last outbound by more than ninety seconds, that
are not currently active, that are outside a thirty minute cooldown, that are
under a day old, and that this daemon owns. For each it runs the healer and
then a recovery turn: a real model invocation over the unanswered messages
with an honest internal note about what went wrong. The person sees a normal
reply.

A fallback notice ("still on it") goes out at most once per burst, after ten
minutes, and only if recovery already had a chance and nothing is in flight.

## The outbox

A reply that could not be delivered goes into `pending_outbox`, one per
session. The drainer retries every ten seconds with backoff to five minutes,
requests a registry heal once per episode after two minutes, and alerts the
operator after ten. Before any new model call for a session, the turn first
drains that session's outbox, so the model is never invoked again on a wedged
send. If the drainer gives up, an undelivered alert re-checks `chat.db` five
minutes later and stays quiet if the message turned out to land.

## Guards that refuse

### chat_mismatch

Before sending, the bridge resolves the chat it is about to use and compares
it to the one that was addressed. If they differ it refuses. This is a true
positive: relaxing the guard to test the theory that it was a false alarm sent
two of three messages to the account's own note-to-self thread. If it fires,
the fix is in resolution, never in the guard.

### Send verification

"Sent" is a claim from the API, not an outcome. After every send the harness
polls `chat.db` for the message GUID and checks which chat it landed in. A
message meant for someone else that landed in one of the bot's own handles is
a misdelivery, and it is treated exactly like a refusal.

### Registry heal

On macOS 26, IMCore can relabel a chat's identifier, participants and
recipient with the account's own address while `chat.db` stays correct. The
heal is to relaunch Messages.app so the registry rebuilds from disk. It is
debounced to once per five minutes and it never touches `imagent`, because
bouncing that daemon causes registration churn and delayed receipts for
everyone.

### Path safety

The MCP server refuses any path under `~/.ssh`, the keychains, `state.db`,
`config.toml`, or outside the session's sandbox and the data directory. A
Claude Code hook (`scripts/guard-path.ts`) applies the same rule to the
worker's own file tools.

### Guests

A guest session is structurally reduced. No memory or history tools, no
person file, no scheduling, no agents, no skills, no filesystem tools, no
integration servers. The reduction is in which tools are registered and which
MCP config is used, not in a prompt instruction.

## Compaction

Long conversations eventually exceed the model's useful context. The harness
measures the context of every call from the provider's own token counts and,
when a threshold is crossed, defers a compaction until after the reply is
delivered. On Claude Code the compaction is injected into the warm worker as
a `/compact` command once the session lock is free. On Codex the thread id is
dropped and the next turn re-anchors from persona, recall and history.

The threshold is cost control, not a memory limit. Per turn cost climbs
steeply with context, and a compaction makes the following turn markedly
more expensive because it rewrites the cached prompt prefix. Raising the
threshold to "keep more context" is the wrong lever. Shrinking fixed prompt
overhead is the right one.

## Stdout

`src/mcp/server.ts` speaks JSON-RPC on stdout. A single stray `console.log`
corrupts the stream and the model loses its tools. `protectStdout()` redirects
the console to stderr before anything else loads, and a test pins that it
stays in place.

## Sandboxing

Each session runs in `sandbox/<slug>/`, which is the worker's working
directory and its only writable tree. Sub-agents run detached from
`scripts/agent-runner.ts` under `sandbox/<slug>/agents/<id>/` and report
through a result file. A long agent that writes nothing incrementally will be
reaped as stuck, so agents are expected to write as they go.

## What the operator hears about

`OperatorAlert` sends an iMessage to `alerts.operator_handle`, bypassing the
model, deduplicated per signature within a configurable interval. Sources
include a repeated ghost spawn failure, an outbox stuck for ten minutes, a
data trigger failing five times in a row, a session lock held silently past
its lease, and the daily credits liability check.
