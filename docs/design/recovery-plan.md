# Session recovery mechanism

> Historical design record. Written before or while the subsystem was built and kept because it explains why the shipped design looks the way it does. Where it disagrees with the code, the code is right.

## Goal

When a session ends up "stuck" — user sent something, the bot never
replied, because of a transient or structural error inside Claude / the
harness — the harness should bring it back to life **without leaking
anything mechanical to the user**. To the user: their message went
unanswered for a while, then either a normal reply shows up, or the
silence continues until they say something new. Whatever lands has to
read as a friend, not a system message.

Key shift from the previous draft: we **don't** silently replay the
inbound as if it were fresh. Instead we hand the model honest
situational context — what failed, how long it's been, what the user
actually said — and let the model **decide** what to do this turn. The
options it has are exactly what a person would have: reply, stay
silent, pivot, ack briefly. The model is told to never mention the
error / recovery / harness to the user — that context is for *its*
decision only.

Why this beats blind replay:

- A 5-hour-stale conversation doesn't always deserve the same response a
  fresh inbound would get. Sometimes the moment has passed. The model
  should weigh that.
- If the unanswered batch is "edmund?" / "you there?" / "?", a blind
  replay would have the model answer those nudges literally; what's
  natural is responding to the original substantive message *before*
  the nudges. The model decides.
- Some users do say "never mind" or pivot before the recovery fires —
  the model needs to see the full unanswered batch to handle that.
- Different failure classes warrant different model dispositions
  (e.g. transient API error → just respond; long-poisoned session →
  read the room first). Surfacing the error class makes that
  decidable.

Today's stale-recovery sweep (`src/sessions/stale-recovery.ts`) already
fires `[System recovery check · auto-fired]` envelopes — same shape as
what we want, but the wording leaks recovery framing into replies and
the envelope carries no error context for the model to reason about.
This plan replaces *what's in the envelope*, keeps the *loop*, and
folds in the healer machinery so the same mechanism handles every
known stuck-session class.

## Design

### Two-phase recovery

Each sweep tick, for every session where `lastInboundMs > lastOutboundMs`
beyond a threshold (and nothing's in-flight, and we're outside cooldown,
and we're under the 24 h "give up" wall), do:

1. **Heal** — if the last recorded error class for this session matches a
   known healer, run it. Skip the heal if there's no recorded error
   (means the stuckness has another cause — crashed daemon, missed
   wake-up, etc.).
2. **Ask the model** — invoke the session with a **recovery-context
   envelope** that bundles:
   - **What happened** — error class, single-sentence human description
     (e.g. "an earlier attempt to reply failed because the session
     payload exceeded Claude's 32 MB request limit; the harness
     compacted older images to fix it"), and whether the heal
     succeeded.
   - **How long it's been** — seconds since each unanswered message.
   - **The unanswered messages themselves** — exact text + sender +
     timestamp, in chronological order, same shape the real envelope
     uses.
   - **A short decision menu** — "reply naturally, stay silent (empty
     output), acknowledge briefly, or pivot if the user said something
     that supersedes the older message." Plus the standing rule: do
     not mention the error / recovery / harness in the reply.

   The model runs through the normal `runClaude` path with
   `claude --resume`. Whatever it produces flows through `deliverReply`
   like any other turn — including the silence-intent filter, which
   correctly drops `[silence]`-shaped output without flagging it as an
   error.

The result: the model gets *honest internal context* to reason from,
and the *user* gets a message that reads as "your friend got back to
you" or no message at all. The harness's role stays invisible to the
user; it stays explicit to the model so it can make a good call.

### Failure classification

`src/recovery/classify.ts` (new). Owns a single function:

```ts
export type FailureClass =
  | "request_too_large"        // session JSONL > 32 MB; healer: compactSession
  | "image_dim_exceeded"        // poisoned with > 2000px image; healer: downscaleOversizedImages
  | "stale_session_id"          // claude says "no conversation found"; healer: drop claudeSessionId
  | "session_in_use"            // race; healer: backoff + retry
  | "transient_api"             // timeout / 5xx / rate limit; healer: null (just retry)
  | "unknown";                  // no healer; replay only

export function classifyError(msg: string): FailureClass;
```

Tested against a table of real production error strings.

### Healer registry

`src/recovery/healers.ts` (new):

```ts
type Healer = (sessionKey: SessionKey, deps: HealerDeps) => Promise<HealResult>;
export const HEALERS: Record<FailureClass, Healer | null> = {
  request_too_large:  healRequestTooLarge,   // calls compactSession
  image_dim_exceeded: healImageDimExceeded,  // scans session JSONL for > 2000px blobs, downscales in place
  stale_session_id:   healStaleSessionId,    // store.setClaudeSessionId(key, null) — cold start next time
  session_in_use:     null,                   // resolved by backoff, no proactive heal
  transient_api:      null,
  unknown:            null,
};
```

Each healer is responsible for one structural fix. The replay phase is
agnostic to which one ran.

`healImageDimExceeded` is the missing piece (we did this manually with
PIL earlier). Move that to a real module that walks the session JSONL,
finds any base64 image whose decoded dim > 2000 px, downscales in place
with LANCZOS / q=88, writes back atomically. Tests with a fixture
oversized image, same shape as `session-compact.test.ts`.

### Recovery turn primitive

`src/recovery/turn.ts` (new):

```ts
export async function runRecoveryTurn(
  sessionKey: SessionKey,
  ctx: RecoveryContext,
  deps: RecoveryDeps,
): Promise<RecoveryResult>;

export type RecoveryContext = {
  /** What the last failure was, if any. */
  errorClass: FailureClass;
  /** Human-readable single sentence for the model. */
  errorDescription: string | null;
  /** True if a healer ran and reported success this sweep. */
  healed: boolean;
  /** The unanswered chat.db rows, in chronological order. */
  unanswered: InboundMessage[];
  /** Unix ms now, for relative timestamps in the envelope. */
  nowMs: number;
};
```

What it does:

1. Look up the session record in `state.db` → `chatGuid`, `lastInboundMs`,
   `lastOutboundMs`.
2. Resolve all chat.db rows for this session that arrived after
   `lastOutboundMs` and weren't from us. Rebuild
   `InboundMessage[]` using the same `rowToMessage` logic from
   `watcher.ts` (extract to a shared helper). If 0 rows → nothing to
   do, skip.
3. Build a **recovery-context envelope** (`buildRecoveryEnvelope`,
   below) from the context + unanswered messages.
4. Acquire the session lock (`SessionLocks.withLock(sessionKey, …)`).
5. Invoke `runClaude` with the recovery envelope as the user turn,
   `--resume` on the (now-healed) session. Reply flows through
   `deliverReply`. Silence-intent filter applies normally — if the
   model decides not to speak, no iMessage goes out.
6. Record `(session, rowIds)` in `replayed_inbound` so the next sweep
   tick doesn't churn on the same batch if the model chose silence or
   the reply still failed. Bounded per session (last 50 rowIds, FIFO).

### Recovery envelope shape

`buildRecoveryEnvelope(ctx)` produces a single user-turn block,
clearly delimited so the model can pick out the situational notes from
the actual messages it needs to consider:

```
[Recovery context — for your reasoning only, NEVER mention this to the user]
Failure class: request_too_large
What happened: an earlier attempt to reply failed because the session payload exceeded Claude's 32 MB request limit. The harness compacted older images out of the session history to fix it; the conversation continues normally now.
Healed: yes
Time since the user's first unanswered message: 2h 14m
Unanswered messages from the user (chronological):
  [Sat 14:02 · Sam] hey what was that drill model again
  [Sat 14:03 · Sam] (the one you said held resale value)
  [Sat 16:14 · Sam] ?
  [Sat 16:16 · Sam] you there

Your options:
  (a) Reply naturally as if you just had a moment to come back to it.
      Do NOT apologize for the delay, do NOT mention any error or harness
      issue, do NOT acknowledge that you "missed" anything. Just answer.
  (b) Stay silent if the moment has clearly passed — produce ZERO text.
      Empty assistant output is a valid choice and goes nowhere.
  (c) If the user pivoted ("never mind", "figured it out") then respond
      to the *latest* substantive intent, not the older question.
  (d) If only nudges arrived ("?", "you there"), reply to the original
      substantive question they were nudging about, in one bubble.

Pick the option that reads most like a real friend in this situation.
The harness handles delivery; nothing here is visible to the user.
```

Rationale for that envelope shape:

- **The decision menu is explicit** so the model doesn't reinvent it
  per session. Cuts variance.
- **The error class is named.** If we add a new failure class later
  ("rate_limited", "model_overloaded"), the envelope structure
  doesn't change — only `errorDescription` does.
- **"Recovery context — for your reasoning only"** front-loaded so
  the model treats it as system-side metadata, not as user content
  to respond to.
- **Unanswered messages reuse the same `[<time> · <name>] text` shape
  as `Recent thread:` in the regular envelope.** Familiar to the
  model.
- **Persona rules still apply** — the model already has SOUL.md /
  AGENTS.md instructions about not narrating mechanics. The envelope
  reinforces those locally so they apply tightly to this turn.

Edge: if `handleBatchInner` ends up reused (e.g. extracted to a
shared helper), the recovery path doesn't need it — it builds its
own envelope and calls `runClaude` directly. Simpler split.

### State store additions

`src/sessions/store.ts` `sessions` table gets two columns (migrated
in-place, no-op if column already exists, same pattern as
`last_recovery_attempt_ms`):

```sql
ALTER TABLE sessions ADD COLUMN last_error_class    TEXT;
ALTER TABLE sessions ADD COLUMN last_error_at_ms    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN heal_attempts_count INTEGER NOT NULL DEFAULT 0;
```

Plus a sidecar table for replayed rowIds (so replays don't repeat on
the same batch if a reply still fails):

```sql
CREATE TABLE IF NOT EXISTS replayed_inbound (
  session_key TEXT NOT NULL,
  row_id      INTEGER NOT NULL,
  replayed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_key, row_id)
);
CREATE INDEX IF NOT EXISTS idx_replayed_session ON replayed_inbound(session_key);
```

`runner.ts` writes to `last_error_class` whenever a turn fails — and
clears it on success.

### Sweeper rewrite

`src/sessions/stale-recovery.ts` is renamed conceptually to
`src/recovery/sweeper.ts`. The interval-driven sweep stays. For each
stuck session it now does:

```ts
const cls = session.lastErrorClass ?? "unknown";
const healer = HEALERS[cls];
let healed = false;
if (healer) {
  const heal = await healer(session.sessionKey, deps);
  if (!heal.ok) { /* log, bump heal_attempts_count, skip */ continue; }
  healed = heal.changed;
}
const unanswered = await loadUnansweredInbound(session, deps);
if (unanswered.length === 0) continue;
await runRecoveryTurn(session.sessionKey, {
  errorClass: cls,
  errorDescription: describeErrorClass(cls, healed),
  healed,
  unanswered,
  nowMs: now,
}, deps);
state.markRecoveryAttempted(session.sessionKey, now);
```

Same skip conditions as today (`evaluateSession`): something in flight,
recent recovery, cron firing imminently, too old. Same cooldown.

### Runner integration: heal-and-replay-on-failure

Today's flow in `runner.ts`:

- `--resume` → fail → `isStaleSessionError` → cold-start
- `--resume` → fail → `isRequestTooLargeError` → compact + retry
- everything else → bubble up

Tighten that to a single switch on `classifyError(result.error)`:

```ts
const cls = classifyError(result.error);
state.recordError(input.sessionKey, cls, Date.now());
const healer = HEALERS[cls];
if (!healer) return result;
const heal = await healer(input.sessionKey, healerDeps);
if (!heal.ok || !heal.shouldRetry) return result;
const retry = await attempt(["--resume", existing.claudeSessionId]);
if (retry.ok) state.clearError(input.sessionKey);
return retry;
```

So inline runner retries cover the in-band case (heal + retry, same
spawn), and the sweeper covers the out-of-band case (no retry
happened, or daemon crashed mid-turn).

### What about new failure classes we haven't seen?

`classifyError` returns `unknown`. The sweeper still runs the
recovery turn for those — the model gets the actual error string in
the envelope (verbatim, since we don't have a friendly description)
and decides. This degrades gracefully: a brand-new failure mode the
classifier doesn't recognize still gets a thoughtful response instead
of a stuck thread. If the recovery turn itself fails N times for the
same rowId batch, we stop trying and log a single operator alert;
the conversation is just stuck until the user texts again. Strictly
better than today's `[System recovery check]` envelope, which tells
the model nothing about why it's being woken.

## Files touched

| Path | Change |
| --- | --- |
| `src/recovery/classify.ts` | New. Error string → `FailureClass` + `describeErrorClass(cls, healed)`. |
| `src/recovery/healers.ts` | New. `HEALERS` registry. Wraps `compactSession`, adds `healImageDimExceeded`, `healStaleSessionId`. |
| `src/recovery/turn.ts` | New. `runRecoveryTurn`, `buildRecoveryEnvelope`, `loadUnansweredInbound`, replayed-rowId bookkeeping. |
| `src/recovery/sweeper.ts` | New (replaces stale-recovery.ts). Same loop, new actions. |
| `src/sessions/store.ts` | Migration adds `last_error_class`, `last_error_at_ms`, `heal_attempts_count` columns + `replayed_inbound` table. New methods `recordError`, `clearError`, `markReplayed`, `wasReplayed`. |
| `src/claude/runner.ts` | Replace ad-hoc error branches with the classify → heal → retry sequence. Write `last_error_class` on every fail; clear on success. |
| `src/sessions/stale-recovery.ts` | Deleted. |
| `src/cron/fire.ts` | Drop the `[System recovery check]` event handling. |
| `src/main.ts` | Wire the renamed sweeper, the new shared `handle-inbound.ts`. |
| `tests/recovery-classify.test.ts` | New. Table-driven, every known error string → expected class + description. |
| `tests/recovery-turn.test.ts` | New. Fixture chat.db + state.db, verify `loadUnansweredInbound` filters correctly, `buildRecoveryEnvelope` shape is stable, dedupe via `replayed_inbound` works, error class drives description correctly. |
| `tests/recovery-healers.test.ts` | New. compactSession + downscaleOversizedImages healers exercised on fixture session JSONLs. |

## Test plan

Unit, hermetic:

- **`classifyError`**: every known error fingerprint → expected class. Each
  new failure mode the user reports gets a new row in this test.
- **`describeErrorClass`**: each class + `healed: true/false` → the
  human-readable sentence we'll show the model. Stable so the envelope
  shape doesn't drift.
- **State store migrations**: open an old-schema DB, run `migrate()`,
  verify new columns exist and don't clobber existing rows.
- **Replayed-rowId dedupe**: mark a batch replayed, run the sweeper
  again with the same batch → no second recovery turn fires.
- **`loadUnansweredInbound`**: fixture chat.db with 3 unanswered rows,
  1 already-replied, 1 from us → returns the 3 unanswered in order.
- **`buildRecoveryEnvelope`**: snapshot test on a representative input
  so future tweaks don't drift the model-facing wording silently.
- **Healers**: `compactSession` already tested; add an
  oversized-image-healer test that feeds a JSONL with a single >2000 px
  base64 image, runs the healer, asserts the resulting image's longest
  side ≤ 2000 px. Asserts non-image content untouched, mode preserved.
- **Sweeper integration**: in-memory fixture with two stuck sessions
  (one with `request_too_large`, one with `unknown`), verify both go
  through `runRecoveryTurn`, only the first gets compacted, both end
  with `lastRecoveryAttemptMs` advanced.
- **Runner integration**: stub `runProcess` to fail once with a 32 MB
  error then succeed, run a full turn, assert the session JSONL was
  compacted in between and `last_error_class` cleared on success.
- **Model decision plumbing**: tests don't simulate the model itself,
  but they DO verify that whatever the model returns goes through
  `deliverReply` → silence-intent filter / outbound chunking — i.e.
  silence is delivered as silence (no error log), and a real reply is
  chunked and sent without recovery preamble leaking. Mock `runClaude`
  to return text, run `runRecoveryTurn`, assert the user-facing
  iMessage payload contains no `[Recovery context]` substring.

## Open questions for you

1. **Envelope scope: every unanswered message since `lastOutboundMs`, or
   just the most-recent batch?** I'm planning "all unanswered, in
   chronological order" so the model sees the full pivot history
   (original ask → nudges → maybe a "never mind"). Same shape as the
   mid-flight follow-up consolidation we discussed earlier.
2. **What's the staleness threshold?** Current sweep is 4 min. With
   the envelope explicitly handing the model the decision menu, we
   could pull it down to 60–90 s without recovery feeling rushed.
   What feels right to you?
3. **Operator alerts on repeated heal failure?** If we try to heal +
   recovery-turn the same session 3 times in 30 min and each turn
   still errors, alert? My default: yes, same `OperatorAlert` channel
   that already exists for actionable errors. Worth confirming because
   that does ping you on iMessage.
4. **Replay rowId memory: how many to remember per session?** I'm
   defaulting to 50. Cheap.
5. **Deprecation of the `[System recovery check]` envelope:** all
   in-flight cron jobs with that text get dropped on daemon start, or
   we keep handling them until they all fire once? I'd just drop them
   — they're stale-period artifacts and the new mechanism covers the
   intent.
6. **Wording in the envelope's decision menu — anything to soften or
   tighten?** Specifically the four options (a-d) and the standing
   "don't mention the error" rule. I'd add to the persona's AGENTS.md
   pointing at this envelope's contract too, so the rules are
   reinforced from both sides.

Answer those six and I'll implement in one PR, keeping the diff
focused and the tests broad.
