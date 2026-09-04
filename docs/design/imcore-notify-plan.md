# Push-based inbound notify — design

> Historical design record. Written before or while the subsystem was built and kept because it explains why the shipped design looks the way it does. Where it disagrees with the code, the code is right.

## Status (as of 2026-05-13)

**Shipped:** Option 1 (`imsg watch`) as the default for `auto`, with Option 3
(`PRAGMA data_version` polling at 200ms) as the fallback path replacing the
old 2s safety poll. New module `src/imessage/imsg-source.ts` handles
subprocess supervision (restart with backoff, give-up after 3 rapid
restarts in 30s, 60s stream-silence detection). Toggle via
`[imessage_watcher] source = "auto" | "imsg" | "fs"`.

**Skipped:** Option 2 (NSDistributedNotification Swift helper). Microsecond
gain isn't worth the Swift binary distribution friction or the dependency
on undocumented private notification names. Revisit if `imsg watch` proves
unreliable in practice.

---



Replace the current `fs.watch(chat.db) + fs.watch(chat.db-wal) + 2s safety
poll` with a true push source for new-message events, dropping inbound→reply
P50 by 1-2s on a quiet machine.

## Current state

`src/imessage/watcher.ts`:

- `fs.watch` on `chat.db` and `chat.db-wal` (FSEvents-backed)
- 2s polling timer that fires drains anyway, gated by a 10s "watch is fresh"
  window so it's mostly a no-op
- On each wake, runs `SELECT ... FROM message WHERE ROWID > ? LIMIT 200` and
  feeds new rows to `onMessage`

Problems:
- macOS FSEvents is documented-flaky for SQLite WAL writes; the 2s poll
  exists *because* the watch can miss writes
- On a truly quiet machine the poll still adds up to 2s of latency before a
  missed write surfaces
- We pay full SELECT cost on every poll tick even when nothing has changed

## Three options (ranked)

### Option 1 — `imsg watch --json --bb-events --attachments --reactions` (RECOMMENDED)

`imsg` already has a streaming watcher. From `imsg watch --help`:

```
imsg watch
  Stream incoming messages

  --since-rowid     start watching after this rowid
  --attachments     include attachment metadata
  --reactions       include reaction events (tapback add/remove)
  --bb-events       include dylib-pushed events (typing, alias-removed) when injection is active
  --json            machine-readable JSON output
```

Already runs as a long-lived process and uses internal IMCore events plus
SQLite tailing under the hood, so it sees everything our hand-rolled
watcher sees (and more — reactions, typing, alias-removed).

**Implementation:**

```ts
// src/imessage/imsg-watcher.ts (new)
const child = spawn("imsg", [
  "watch", "--json",
  "--attachments",
  "--reactions",
  "--bb-events",
  "--since-rowid", String(startCursor),
]);

const lines = new LineReader(child.stdout);
for await (const line of lines) {
  const evt = JSON.parse(line);
  if (evt.kind === "message") onMessage(toInboundMessage(evt));
  else if (evt.kind === "reaction") onReaction(evt);
  // ...
}
```

`onMessage` already exists; the JSON envelope from `imsg watch` maps
cleanly to `InboundMessage` (text, attachments, reply parent, dates).

**Replaces:**
- `fs.watch` on chat.db / chat.db-wal
- The 2s safety poll
- Most of `rowToMessage` (parsing) — `imsg watch` decodes attributedBody for us

**Fallback chain (graceful degradation):**

| Path | When |
|---|---|
| `imsg watch` | imsg installed AND `--bb-events` accepted (verify at startup) |
| current fs.watch + poll | imsg missing or stream errors at startup |
| poll-only | both watches failing |

`config.toml` flag `[imessage.watcher] source = "auto" | "imsg" | "fs"`,
default `"auto"`.

**Health monitoring:**

The `imsg watch` process can die (Messages.app crash, imsg bug, OOM). The
watcher must:
- Heartbeat: expect *some* event (including periodic keepalives if imsg
  emits them) within N seconds. If silent for >60s, restart the subprocess.
- On `exit`: re-spawn with `--since-rowid <last-seen-row-id>` to avoid
  gaps. Backoff on rapid crashes (3 restarts in 10s → fall back to fs.watch).
- On unparseable stdout: log + skip the line, don't kill the process.

**Win**:
- Inbound→reply P50 −1-2s on quiet machines
- No more SELECT-spam from the 2s poll (current ~30/min idle cost gone)
- Free reaction-event feed for the next reactor-aware feature
- ~120 LOC of fs-watcher + rowToMessage code becomes obsolete

**Risk**:
- Adds a critical subprocess dependency on `imsg watch` stability. Mitigated
  by automatic fallback to current behavior on failure.
- Schema drift if a future imsg version changes JSON shape. Mitigated by
  pinning the imsg version in setup docs and validating shape on each event.

**Estimate**: 2-3 days. The hard part is making the supervisor robust
(restart logic, fallback, dedup if both sources are live during cutover).

---

### Option 2 — Native `NSDistributedNotificationCenter` listener

The right "platform-native" answer. macOS's `imagent` posts a notification
when a new message arrives — that's what Messages.app uses to update its
UI. We can subscribe to those notifications and use them as a zero-latency
push signal, then drain chat.db as we do today.

**Implementation:**

A small Swift helper binary:

```swift
// notify-helper/main.swift  (compiles to ./bin/edmund-notify-listen)
import Foundation
let center = DistributedNotificationCenter.default()
center.addObserver(forName: NSNotification.Name("__kIMChatMessageReceivedNotification"),
                   object: nil, queue: nil) { _ in
    print("notify")
    FileHandle.standardOutput.synchronizeFile()
}
RunLoop.current.run()
```

Spawn from the daemon; each line on stdout = a notify event = drain
trigger. The daemon still owns SELECT + cursor logic.

**Why we'd want this over Option 1:**
- Push latency is microseconds, not milliseconds
- Doesn't depend on `imsg watch`'s stability
- "Right" answer from a macOS architecture standpoint

**Why we wouldn't:**
- Adds a Swift binary to the build (more setup friction for new operators)
- Specific notification names (`__kIM...`) are undocumented private API —
  may change across macOS versions
- Doesn't replace the SELECT logic, only triggers it — smaller code-cleanup
  win than Option 1

**Estimate**: 3-5 days, mostly because of Swift build/distribution mechanics.

---

### Option 3 — `PRAGMA data_version` polling

A pure-SQLite, no-new-dependencies option. SQLite exposes a `PRAGMA
data_version` that bumps any time the database is modified. Poll it on a
fast cadence (200ms) and only drain when it changed.

```ts
let lastVer = 0;
setInterval(() => {
  const ver = (chatDb.query("PRAGMA data_version").get() as { data_version: number }).data_version;
  if (ver !== lastVer) {
    lastVer = ver;
    drain();
  }
}, 200);
```

**Pros:**
- Zero new dependencies, ~10 lines of code
- More reliable than FSEvents (it's the DB telling us, not the filesystem)
- 200ms latency cap; well under perceptible

**Cons:**
- Not push; just a much better poll
- ~5 fast queries/sec even when idle (`PRAGMA data_version` is cheap but non-zero)
- Doesn't get us reactions/typing for free

**Estimate**: half a day.

---

## Recommendation

**Ship Option 1.** It's the right ratio of effort to win:

- The push source is `imsg watch`, which is a Steipete-maintained subprocess
  the project already depends on (we use `imsg send-rich`, `imsg tapback`,
  etc. via the same binary). Adding one more subcommand of the same tool
  doesn't widen the dependency surface meaningfully.
- We get reaction-event push as a bonus, useful for the next "tapback me back
  faster" UX iteration.
- Failure mode is well-defined (drop to current fs.watch path) and tested in
  CI by stubbing the subprocess.

Option 2 (NSDistributedNotification) becomes worth doing only if `imsg
watch` proves unreliable in practice. Option 3 (`PRAGMA data_version`) is a
fine quick win for operators who don't have `imsg` installed — wire it as
the fallback path instead of the current 2s poll while we're in there.

### Concrete sequencing

1. Spike `imsg watch --json --bb-events --reactions --attachments
   --since-rowid 0` for 10 minutes against the live chat.db; verify event
   shape and that `--since-rowid` correctly resumes.
2. Implement `src/imessage/imsg-watcher.ts` with the supervisor (restart,
   fallback, backoff).
3. Wire as the default behind `[imessage.watcher] source = "auto"` config.
4. Replace the 2s `pollTimer` in the legacy fs-watch path with a `PRAGMA
   data_version`-bump check at 200ms (Option 3 as a freebie in the same PR).
5. Ship behind a config flag for one release cycle, then make `"imsg"` the
   default for `auto` if no incidents reported.

### What we DON'T need to touch

- `InboundMessage` type — already shaped correctly.
- The cursor/setCursor flow.
- shouldAccept / gate / mention detection.
- Any code downstream of `onMessage`.

Everything new is contained to the watcher module.
