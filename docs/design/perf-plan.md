# Perf + reliability sweep — plan

> Historical design record. Written before or while the subsystem was built and kept because it explains why the shipped design looks the way it does. Where it disagrees with the code, the code is right.

Scope: implement the audit punch list. Bridge-vs-legacy send path is preserved
and surfaced as a config setting (not a hard assumption that SIP is disabled),
so anyone running the codebase without the IMCore unlock still gets reliable
sends through the AppleScript path.

## In scope (this PR)

| # | Item | File(s) | Impact |
|---|---|---|---|
| 1 | Parallelize per-turn enrichment | `src/main.ts` | P50 −2-4s, P99 −8s+ |
| 2 | Cache prepared statements in `ChatDb` | `src/imessage/db.ts` + callers | 5-15 ms / turn |
| 3 | Move `maybePreventiveCompact` off the critical path | `src/claude/runner.ts` | 50-300 ms P99 |
| 4 | Relay: fire at `Date.now()` + `scheduler.poke()` | `src/bridge/relay.ts` | Relay P50 −1-5s |
| 5 | `Scheduler.fireDue`: `markFired` BEFORE `await onFire` | `src/cron/scheduler.ts` | No duplicate cron on crash |
| 6 | Watcher: advance cursor AFTER successful enqueue | `src/main.ts` | No silent message loss |
| 7 | Drop `await` in `watcher.drain` (sync onMessage) | `src/imessage/watcher.ts` | Faster catch-up |
| 8 | `ContactBook`: precompute reverse alias map | `src/sessions/contacts.ts` | O(N²) → O(N) |
| 9 | `setCursor` write churn: batch in memory, flush on timer | `src/sessions/store.ts` + `src/main.ts` | Less WAL pressure |
| 10 | Collapse 2-3× `upsertSession` per turn into one | `src/main.ts` | Fewer fsyncs |
| 11 | Collapse `sendWithRetry` × `sendMessage` retry layers | `src/imessage/send.ts` + `send-retry.ts` | Bounded latency on partial outage |
| 12 | **Bridge-vs-legacy send is now a config setting** | `src/config/config.ts` + `src/imessage/send.ts` | Works for both SIP-on and SIP-off operators |

## Item 12 — send path is now a channel setting

Today's earlier fix made the IMCore bridge the implicit default. That's correct
for THIS deployment (SIP off, dylib injected, AMFI relaxed) but assumes too
much for anyone else cloning the repo. The fix:

- New `config.toml` section `[imessage.send]` with a `path` enum:
  - `"auto"` (default) — probe at startup; use bridge if `richBridgeAvailable()`, else legacy (`imsg send`), else AppleScript.
  - `"bridge"` — bridge only; fail loudly if unavailable.
  - `"legacy"` — `imsg send` (chat.db / AppleScript hybrid) only — for operators who haven't disabled SIP and don't want the bridge probe.
  - `"applescript"` — pure AppleScript fallback only.
- `src/imessage/send.ts::sendMessage` reads this setting (passed via the
  already-existing `Config` plumbing) and chooses ONE path; falls back inside
  that path only on transient errors, never silently jumps tiers.
- `sendViaImsg` is preserved as the `legacy` path — it stays the right default
  for unmodified macOS.

## Explicitly OUT of scope (separate PRs)

These were on the audit list but are multi-day-to-multi-week and need their own
design pass. Calling out so they're not forgotten:

- **Long-lived MCP server / resident `claude` agent pool.** Biggest perf win
  on the board but architectural — needs socket transport for Claude Code's
  MCP loader and a pool manager. Track as `docs/resident-agent-plan.md`.
- **Replace `fs.watch` + 2s safety poll with `NSDistributedNotification`.**
  Requires a Swift helper bridging to Node. Track as
  `docs/imcore-notify-plan.md`.

## Verification per item

- Each item ends with `bunx tsc --noEmit` clean and `bun test` green.
- Item 1 (parallel enrichment): add a focused test stubbing the three slow
  helpers and assert total time ≈ max of the three, not sum.
- Item 5 (cron): add a test that `onFire` throwing still advances `markFired`.
- Item 6 (cursor): add a test that an `enqueue` throw does NOT advance cursor.
- Item 12 (send path config): unit-test each path setting picks the right
  branch given a stubbed bridge probe.

## Order of work

1. 5, 6, 8, 7 — small, isolated, low-risk correctness/perf wins.
2. 2, 9, 10 — DB-layer changes; touch many call sites but each is mechanical.
3. 3, 4 — runner + relay tweaks.
4. 12 — config-driven send path (keeps `sendViaImsg`, makes channel choice explicit).
5. 11 — retry-layer collapse (depends on 12 because the retry now sits inside one path).
6. 1 — parallel enrichment (last because it touches `handleBatchInner` hot path).

End-of-PR: daemon restart, watch logs for a real inbound turn.
