# Resident Claude agents + long-lived MCP server — design

> Historical design record. Written before or while the subsystem was built and kept because it explains why the shipped design looks the way it does. Where it disagrees with the code, the code is right.

## Status (as of 2026-05-13)

| Part | Status | Notes |
|---|---|---|
| A: In-daemon MCP HTTP server | **Deferred** | Subsumed by Part B (workers reuse their MCP child across many turns; per-turn MCP cold start is no longer the bottleneck). Worth revisiting only if measurements after Part B show MCP startup still dominant. |
| B: Resident worker pool | **Shipped (opt-in)** | `[claude.pool] enabled = false` by default. Flip to `true` once you're ready. Verified live with `RUN_WORKER_SMOKE=1 bun test tests/worker-smoke.test.ts`: turn 2 ran in 972ms vs turn 1's 7.4s — prompt cache + warm process. |
| imsg watch push inbound | **Shipped (on by default)** | `[imessage_watcher] source = "auto"` — tries imsg first, falls back to fs.watch + 200ms `PRAGMA data_version` poll on failure. |

The legacy spawn-per-turn path is preserved end-to-end; the pool is a
strict opt-in feature behind a config flag. Toggling the flag changes only
how `runClaude` reaches its result — the API surface is unchanged, and
healers / cold-start / collision fallback behave identically in both modes.

---



Two related architectural moves, each independently shippable. Together they
eliminate the per-turn cold-start tax that dominates P50 latency on warm
conversations.

## Current cost (the thing we're killing)

Every inbound turn does roughly:

```
spawn(claude -p)                                   ~200-400ms  (Node startup + CLI bootstrap)
  -> claude reads --append-system-prompt           ~50-150ms   (file IO + render)
  -> claude opens MCP child:                       ~250-500ms  (spawn bun + import 18 tool modules + parse zod)
       bun src/mcp/server.ts
         loadToolContext():
           new ChatDb(...)                         (reopens SQLite read connection)
           new ContactBook(...)                    (rebuilds canon maps)
           new BgJobStore(...)                     (opens bgjobs.db)
           new CronStore(dataDir)                  (opens cron.db)
  -> claude resumes session id, sends to Anthropic API
  -> stream-json events back over stdout
  -> on result, both processes exit
```

Conservatively: **500-1000ms of overhead before the model has done any
actual work**. On a back-and-forth burst of 5 messages that's 2.5-5s gone.

Two changes fix this:

- **Part A**: long-lived in-daemon MCP server over HTTP. Eliminates the
  per-turn `bun src/mcp/server.ts` cold start.
- **Part B**: resident `claude` workers per session. Eliminates the per-turn
  Claude CLI cold start.

Part A is independent and ~1-2 days of work. Part B is harder and rests on
Part A landing first.

---

## Part A — In-daemon MCP server over HTTP

### Why

Right now `src/mcp/server.ts` is a subprocess started fresh by Claude on every
turn. Inside the daemon we already hold the singletons that subprocess
rebuilds: `ChatDb`, `ContactBook`, `BgJobStore`, `CronStore`, `Config`. Moving
the MCP server in-process eliminates duplicate state, duplicate file handles,
and the spawn tax.

Claude Code natively supports HTTP MCP transports:

```
claude mcp add --transport http edmund http://127.0.0.1:PORT/SESSION_KEY
```

Or, equivalent JSON for `--mcp-config`:

```json
{ "mcpServers": { "edmund": {
    "type": "http",
    "url": "http://127.0.0.1:43117/imessage:dm:+15551234567"
}}}
```

### Architecture

```
                 ┌────────────────────────────────────┐
                 │  edmund-harness daemon (one proc)  │
                 │                                    │
   chat.db ───── │  ChatDb singleton                  │
                 │  ContactBook singleton             │
   state.db ──── │  StateStore singleton              │
                 │  BgJobStore singleton              │
                 │  CronStore singleton               │
                 │                                    │
   localhost ────┤  MCP HTTP listener (Bun.serve)     │
   :43117        │   /:sessionKey  → tool dispatcher  │
                 │   - reads sessionKey from URL      │
                 │   - per-request ToolContext built  │
                 │     from in-process singletons     │
                 └──────────────────┬─────────────────┘
                                    │ HTTP MCP (SSE / streamable-http)
                                    ▼
                 ┌────────────────────────────────────┐
                 │  claude -p (still spawned per turn │
                 │  in Part A — fixed in Part B)      │
                 └────────────────────────────────────┘
```

### Per-request context: how `sessionKey` flows

Currently `ToolContext` is constructed from env vars (`EDMUND_SESSION_KEY`,
`EDMUND_SANDBOX_PATH`, `EDMUND_DATA_DIR`). In the in-daemon model these are
runtime properties of the request, not the server process.

**Mechanism**: path-based session routing. The daemon mounts the MCP server
at `/:sessionKey/` and the per-turn `--mcp-config` writes the session-specific
URL into the JSON.

```ts
// In src/main.ts startup
const mcpPort = pickFreePort();
Bun.serve({
  port: mcpPort,
  async fetch(req) {
    const sessionKey = decodeURIComponent(req.url.split("/")[3]!);
    const ctx = buildToolContext(sessionKey, daemonSingletons);
    return mcpHandler(req, ctx);  // SSE/streamable-http MCP protocol
  },
});
```

```ts
// In src/claude/mcp-config.ts
return {
  mcpServers: {
    edmund: {
      type: "http",
      url: `http://127.0.0.1:${mcpPort}/${encodeURIComponent(sessionKey)}`,
    },
  },
};
```

### What changes

| File | Change |
|---|---|
| `src/mcp/server.ts` | Split into `register-tools.ts` (pure: builds the tool registry given a ToolContext) and `http-server.ts` (Bun.serve listener). The old stdio entry point stays as a fallback for users who prefer subprocess MCP. |
| `src/mcp/context.ts` | New `buildToolContext(sessionKey, singletons)` — no env-var reads, no SQLite reopens. |
| `src/main.ts` | Boot MCP HTTP listener at startup; pass `mcpPort` into `runClaude`. |
| `src/claude/mcp-config.ts` | Emit `{ type: "http", url: ... }` instead of `{ command: "bun", args: ["src/mcp/server.ts"] }`. |
| `src/sandbox/sandbox.ts` | The MCP server no longer needs cwd=sandbox; `chdir` semantics for tool handlers become explicit per-call. |
| `config.toml` | New `[mcp_server]` block: `transport = "http" | "stdio"` (default `"http"`), `port = 43117`, `bind = "127.0.0.1"`. Stdio remains for backwards compat. |

### MCP protocol surface

Claude Code's HTTP transport is one of `sse` (legacy) or `streamable-http`
(current). Streamable-http is a single POST endpoint that returns either a
JSON-RPC response or an SSE stream depending on the request. Reference impl:
the official `@modelcontextprotocol/sdk` typescript transport modules. We
should not hand-roll the framing — depend on the SDK's server class and just
mount its `handleRequest` inside `Bun.serve`.

Auth: localhost-only bind, no auth (consistent with the current stdio
transport's implicit trust model). For Part B's potential remote-worker
extension we'd add an `Authorization: Bearer <token>` header.

### What we win

- ~200-500ms shaved per turn (no `bun src/mcp/server.ts` cold start).
- Single `ChatDb` open instead of N — removes the per-MCP `PRAGMA journal_mode = WAL` and statement-cache rebuild.
- No more `EDMUND_DATA_DIR` env-var hack to redirect data_dir into the real path.
- Tool handlers can call into in-process services directly (no SQLite round-trip for cron creates → scheduler poke is in-process now).

### Risks

- Claude Code's HTTP MCP transport quirks (reconnects, error framing). Mitigation: keep stdio path working under a config flag; auto-fallback if HTTP returns 5xx during startup.
- Port collisions on multi-instance setups. Mitigation: bind to `:0` and persist the chosen port in `data/mcp.port` for restart consistency.
- A bad MCP handler now crashes the daemon, not just a subprocess. Mitigation: wrap each tool handler in a try/catch that returns `{ isError: true }` instead of bubbling.

### Estimate

1-2 days. Pure refactor — no protocol changes to Claude Code or the model's
view of the world.

---

## Part B — Resident `claude` workers per session

### Why

Even with Part A's MCP server in-daemon, every turn still spawns
`claude -p --resume <id>`. That's another ~200-500ms of Node + CLI startup
plus Anthropic API connection setup. For a back-and-forth burst the
cumulative wait is what makes the bot feel sluggish.

A resident worker per active session, fed via `--input-format stream-json`,
amortizes the cold-start over many turns.

### Architecture

```
daemon
  └── WorkerPool
        ├── worker[imessage:dm:+15551234567] : claude --input-format stream-json
        │     stdin  ← turn envelope events
        │     stdout → result events
        │     idle:false  bound_at: 2026-05-13T14:32:00
        ├── worker[imessage:group:chat...]  : (same)
        └── ...
```

Each worker is a long-lived `claude` process invoked with:

```sh
claude \
  --input-format stream-json \
  --output-format stream-json \
  --resume <session-id> \
  --mcp-config <(emit per-session config) \
  --append-system-prompt ... \
  --include-partial-messages \
  --replay-user-messages
```

`--input-format stream-json` is documented to support realtime streaming
input. Each new turn is a `{ type: "user", message: { ... } }` event written
to the worker's stdin; the result comes back as the existing stream-json
events on stdout (matching what `runProcess` already parses).

### Worker lifecycle

```
[turn arrives for session S]
  pool.acquire(S):
    if worker exists and !worker.busy:
      reuse
    else if pool.size < MAX:
      worker = spawn(claude, args(S))
      bind worker to session S
    else:
      evict LRU idle worker
      spawn new one
  worker.busy = true
  worker.send(envelope)
  result = await worker.nextResult()
  worker.busy = false
  worker.idleSince = Date.now()

[idle sweeper, every 30s]
  for w in pool:
    if !w.busy and Date.now() - w.idleSince > IDLE_MS:
      gracefully shut down w
```

Key sizing knobs (start values):

| Knob | Default | Why |
|---|---|---|
| `MAX_RESIDENT_WORKERS` | 6 | Each Claude CLI process is ~200-400 MB RSS; 6 fits in 3 GB headroom |
| `IDLE_EVICT_MS` | 10 * 60_000 | A conversation that's been quiet 10 min is unlikely to burst again |
| `BUSY_TIMEOUT_MS` | reuses the idle-timeout from runner.ts | Hung worker gets killed, replaced |

### Per-turn context

Today: env vars (`EDMUND_SESSION_KEY`, `EDMUND_SANDBOX_PATH`) are set at
spawn. Resident workers can't change env between turns — but they don't have
to:

- `sandboxPath` is stable for a session's lifetime (DM = one person; group = one chat).
- `sessionKey` is stable.
- MCP config (Part A's HTTP URL) is stable because session is encoded in the URL.

So a worker bound to session S is correctly scoped for every turn in S.

### Compaction races

`maybePreventiveCompact` rewrites the session JSONL while no `claude` process
is currently holding it. With a resident worker that may not be true.

Fix: hold a per-worker file lock. Compact only when the worker is idle AND
we've torn down its `claude` process for eviction or restart. The "fire and
forget after result" we just shipped becomes "schedule for next idle-eviction
pass."

Or simpler: bump the soft/hard limits so compaction never fires for normal
volumes and rely on eviction-then-compact for cleanup. Sessions that get hot
enough to need compaction are getting hot enough to never go idle, in which
case we don't want to disrupt them anyway.

### What changes

| File | Change |
|---|---|
| `src/claude/runner.ts` | `runClaude` consults the worker pool first. Cold-spawn path stays for fallback. |
| `src/claude/pool.ts` (new) | The `WorkerPool` class: acquire / release / evict / sweep. |
| `src/claude/worker.ts` (new) | Wrap a single `claude` subprocess: serialize input events to stdin, parse stream-json from stdout, expose `send(envelope) → Promise<RunResult>`. |
| `src/claude/compaction.ts` | Gate compaction on "worker not bound" instead of "right after the result." |
| `config.toml` | `[claude.pool] enabled = true, max_workers = 6, idle_evict_ms = 600000` |
| `src/main.ts` | On shutdown, drain the pool gracefully (send `{ type: "end" }` events). |

### What we win

- ~500-1500ms shaved per turn on warm sessions (no Claude CLI cold start).
- Anthropic API connection is reused (HTTP keepalive across turns).
- Stream-json input means the model can see envelope chunks as they're written — slight latency improvement for the model's first token.

### Risks (real ones)

- **Claude CLI's resident-mode contract**. `--input-format stream-json` is documented for `--print`, which exits after one result. We need to verify: does `--print --input-format stream-json` accept *multiple* user events on stdin, or does it process one and exit? If it exits, we'd need to either (a) use interactive mode without `--print`, or (b) switch to the Anthropic SDK directly (a bigger rewrite — replaces the CLI dependency entirely, but gives us full control and is the Claude Agent SDK's intended path). **Spike before committing**: run `printf '{...event1...}\n{...event2...}\n' | claude --print --input-format stream-json --output-format stream-json` and see if it processes both.
- **MCP child handshake**. If `claude -p` re-handshakes MCP per stdin event (vs. once at startup), we don't save the MCP cold-start — Part A's HTTP listener absorbs that, but the handshake RTT remains. Verify.
- **Resident-mode hooks/permissions**. The PreToolUse hook (`scripts/guard-path.ts`) currently fires per process. With a resident process its lifecycle changes — verify it still gets fired per tool call, not just at startup.
- **Memory.** 6 × 400 MB = 2.4 GB just for warm Claude processes. On a 16 GB Mac mini that's fine; on an 8 GB box that's not. Cap based on system RAM.

### Estimate

5-10 days. Most of the time is in verifying the Claude CLI's behavior in
resident mode and building the worker abstraction robustly. If `claude -p`
turns out to be one-shot only, switch to **Claude Agent SDK directly** —
which is ~5 days but is the right long-term move anyway (we lose the CLI
binary dependency, gain control over batching, prompt caching, and tool
streaming).

### Sequencing

1. Ship Part A first. Measure the win (~200-500ms). Establishes the
   in-daemon MCP pattern as the baseline.
2. Spike the Claude CLI resident-mode test (1 day, throwaway).
3. If CLI works: build worker abstraction (3-4 days).
4. If CLI is one-shot only: swap to Anthropic SDK / Claude Agent SDK
   (5-7 days). Drops external `claude` dependency, replaces `runProcess`
   wholesale.

---

## Cross-cutting notes

- Both parts preserve the current send-path config and the bridge-vs-legacy
  distinction. Worker pool only affects how Claude is invoked, not how
  messages go out.
- Recovery sweeper and cron-fire still work — they call `runClaude`, which
  in Part B routes through the pool transparently.
- For the dashboard: surface `pool.status()` (workers, last-used, busy state)
  on the existing observability tab.
