---
name: edmund-harness-production-coding
description: >-
  Rules and lessons for working on edmund-harness, the personal iMessage AI
  assistant daemon at ~/edmund-harness. Use whenever editing the session
  pipeline, Claude runner, memory/recall, ghost/brown-nose, recovery healers,
  MCP tools, trading subsystem, RadarOmega integration, mirror bridge, cron
  scheduler, orchestrator routing, or iMessage send/watcher. Prefer this skill
  over ad-hoc reverse engineering of the debounce/coalesce pipeline, the
  worker pool, the failure-classification healer chain, and the embedding
  pipeline — those subsystems punish guessing.
---

# edmund-harness — agent skill

A personal iMessage AI assistant running as a long-lived Bun daemon on a Mac
(macOS, Apple Silicon). It watches the local Messages chat.db, routes inbound
messages through a gating → debounce → session-pipeline → Claude Code worker
pool, and delivers replies via AppleScript or an IMCore dylib bridge. The
daemon also runs a cron scheduler, a semantic-memory embedding pipeline, a
proactive-outreach ghost, a multi-healer recovery loop, and optional subsystems
for autonomous trading, weather radar, a smart mirror, and fishing data.
Everything is TypeScript, Bun-native SQLite for state, and Claude Code
(headless CLI) for inference — no API keys for the chat brain.

## Does

### Architecture & conventions
- **Reuse the existing pipeline** under `src/channels/` (`pipeline.ts`,
  `turn.ts`, `deliver.ts`, `envelope.ts`, `history.ts`) — one shape of
  `InboundMessage`, one path into `handleBatch` → `runClaude` →
  `sendDeliver`. Parallel implementations are the main source of drift here.
- **Every turn goes through `SessionPipeline.enqueue`** (debounce →
  `SessionLocks.withLock` → snapshot batch → `handleBatch`). Never bypass
  the pipeline for a "quick" direct Claude call.
- **Match existing patterns** rather than importing your favourites: use
  `src/db/open.ts` (openDb with busy_timeout + WAL) for any new SQLite
  store, `src/util/log.ts` (`log.info`/`log.warn`/`log.error`/`log.debug`)
  for structured logging, `src/util/ids.ts` (`genId`) for idempotency keys,
  and `src/sessions/key.ts` (`SessionKey`, `chatIdFromKey`) for routing keys.
- **Investigate before inventing.** Read `config.toml`, the live `data/`
  directory, and `data/daemon.log` before writing a fix. The running daemon's
  state (SQLite rows, session JSONL files, cursor position) is the ground
  truth — not the config defaults.
- **Keep files feature-scoped.** New MCP tools go in `src/mcp/tools/<name>.ts`
  and register in `src/mcp/server.ts`. New skills go in `skills/<name>/SKILL.md`.
  Don't extend catch-all files for a feature that can own its own module.
- **Add pure helpers with unit tests** for risk, classification, ranking,
  parsing, and scheduling logic. Those bugs ship silently and only show up in
  production behaviour. The test suite lives in `tests/` and runs with
  `bun test tests`.

### The message pipeline (hot path)
- **Watcher** (`src/imessage/watcher.ts`): tails `chat.db` via `fs.watch` +
  ROWID cursor. Drains on file change, no timer polling. Supports `imsg` push
  source for sub-100ms latency as an alternative to the 2s fs poll safety gap.
- **Gating** (`src/gating/allowlist.ts`): drops self-echoes, non-allowlisted
  senders, group messages that don't @mention the bot, and edmund-911 hand-off
  triggers. Post-Whisper re-gate for voice notes without Apple transcripts.
  Also checks `src/imessage/sanitize.ts` for leaked scaffolding.
- **Routing** (`src/main.ts` → `src/orchestrators/registry.ts`): each inbound
  message routes to an orchestrator (main persona, named secondary like Desmond,
  or trading sub-persona) based on invocation-name matching. Trading sessions
  use the `trading:dm:` namespace; named orchestrators use `orch:<key>:`.
  The primary handles everything un-named.
- **Debounce** (`src/channels/pipeline.ts`): per-session debounce with
  message-type-aware windows — plain text, captioned attachment, bare
  attachment (longer to wait for the caption), and voice-session (much
  shorter for mirror turns). Hard cap from first queued message.
- **Coalesce** (`src/channels/turn.ts`): when a message parks while a turn
  is running (coalesce_pending), the pipeline re-runs up to 3 iterations,
  showing the model its draft + the new message(s) and asking it to fold
  everything into one reply or respond `KEEP_DRAFT`.
- **Durable ack** (`src/sessions/store.ts` + `src/bridge/session-queue.ts`):
  inbound rows are persisted to `inbound_ack` BEFORE the cursor advances.
  Boot replay recovers rows that were ack'd but never answered (the
  "2026-07-19 10:21 incident" — daemon killed inside the debounce window).
- **Outbox** (`src/sessions/store.ts` putOutbox/clearOutbox): replies that
  fail to send (bridge wedge) are stashed. The next turn flushes before
  invoking the model. Permanent send errors trigger a reformat cron instead.

### Claude worker pool
- **Pool** (`src/claude/pool.ts` + `src/claude/runner.ts`): up to
  `max_workers` (default 6) persistent `claude` subprocesses. Each worker
  stays bound to its session via `--resume <uuid>`; idle eviction after
  `idle_evict_ms` (30 min). Spawn-per-turn fallback when pool is disabled.
- **MCP loadout** (`src/claude/mcp-config.ts`): three MCP config variants —
  `default` (edmund-harness server + optional RadarOmega), `withBrowser`
  (+ chrome-devtools-mcp), `trading` (+ Robinhood HTTP MCP). Selected per
  turn via rebindKey; warm-reuse across same-loadout turns.
- **Auto-compact** (`src/claude/auto-compact.ts` + `/compact` injection):
  when the resumed session's prefix crosses `threshold_tokens` (0.75× context
  window), inject Claude Code's built-in `/compact` into the warm worker.
  DEFERRED — runs AFTER the reply is on the wire, not before delivery.
  Adapts threshold to the live model via the OpenRouter proxy.
- **System prompt** (`src/claude/system-prompt.ts`): assembled from persona
  files (IDENTITY.md, SOUL.md, HOME.md, AGENTS.md, VENUE_DM.md/VENUE_GROUP.md/
  VENUE_MIRROR.md) + per-contact persona + group persona + sandbox path +
  owner name. Token `{{root}}` resolves to the harness checkout path.

### Session state
- **StateStore** (`src/sessions/store.ts`): SQLite (WAL, busy_timeout) holding
  sessions, cursors, message_routing, outbox, inbound_ack, errors,
  sent_attribution, compact_at. One DB per data_dir.
- **SessionKey** (`src/sessions/key.ts`): typed string — `imessage:<chatId>`
  for legacy/main, `orch:<key>:<chatId>` for named orchestrators,
  `trading:dm:<handle>` for trading. Never construct SessionKeys by hand;
  use the factory functions.
- **SessionLocks** (`src/sessions/locks.ts`): per-key mutex with configurable
  timeout. Shared between pipeline turns and cron fires so scheduled events
  can't collide with inbound. Backstop timeout = 2× the claude timeout
  (budgets for turn + in-place compact as two sequential Claude calls).
- **EchoCache** (`src/sessions/echo-cache.ts`): short-term LRU of sent-message
  text → GUID. Prevents the bot from replying to its own messages that the
  watcher sees before the echo guard catches them.
- **ContactBook** (`src/sessions/contacts.ts`): maps handles to display names
  from `[[contacts]]` config. AddressBook resolves raw handles to contact names
  from the local AddressBook database.

### Memory & semantic recall
- **Embedding provider** (`src/memory/embed-provider.ts`): pluggable —
  `transformers` (Xenova/all-MiniLM-L6-v2, 384-dim, in-process WASM ONNX),
  `openai` (HTTP API), `ollama` (HTTP API), or `none`/test stub.
  Multi-threaded WASM via `env.backends.onnx.wasm.numThreads`.
- **Indexer** (`src/memory/indexer.ts`): background incremental pass over
  chat.db messages (watermark by ROWID), persona files (watermark by mtime),
  and sandbox artifacts (text-bearing files in per-session sandboxes).
  Batched embedding. Adaptive retick when backlog > threshold.
  Idempotency guard via `store.hasRef()` — won't re-embed already-indexed GUIDs.
  Backfill window configurable (`backfill_days`, default 365).
- **Vector store** (`src/memory/vector-store.ts`): SQLite-backed with
  in-memory Float32Array cache. Full-scan cosine similarity (dot product on
  pre-normalized vectors). PRAGMA data_version for cross-process consistency
  (bg-runner writes → daemon cache auto-refreshes). MMR reranking for
  diversity; hard dedup threshold for near-duplicates. Recency boost
  (exponential decay) and outside-context boost for pre-compaction messages.
- **Auto-recall** (`src/memory/auto-recall.ts`): runs on every inbound BEFORE
  the model is invoked. Embeds the query text, searches the vector store with
  chat-scoped filter, and returns three blocks: sender-in-chat (group only),
  recent (recency-boosted), deep (pure cosine). Injected into the envelope.
  Failure stance: any error is swallowed — recall is enrichment, not critical path.
- **Enrichment** (`src/memory/enrich.ts`): `buildEnrichedText` appends
  attachment metadata (filename, mime type, Apple transcript) to message
  text before embedding.

### Ghost / brown-nose (proactive outreach)
- **Observer** (`src/ghost/observer.ts`): periodic + event-driven ghost ticks.
  Event triggers: `onMainReplied` (60-120s deferred after outbound), window_start
  (active hours just opened), quiet_24h/quiet_4h (user silent past threshold),
  sweep (round-robin backstop). Minimum 45-min spacing between ticks per session.
  Enrollment safety net: auto-enrolls sessions on first touch (not just at boot).
- **Picker** (`src/ghost/picker.ts`): ranks eligible sessions by priority:
  window_start > quiet_24h > quiet_4h > sweep (oldest tick wins).
- **Think** (`src/ghost/think.ts`): runs a cheap Claude Haiku model
  (`ghost_model`, default claude-sonnet-5) with conversation context. Decides
  act:true/false + reason + optional snooze. Never sends; only proposes.
  The decision flows through cron → proactive/fire.ts for the actual model turn.
- **Intensity** (`src/ghost/intensity.ts`): 1-10 scale maps to sweep cadence +
  weekly caps. Operator change synced via `syncWeeklyCapsToIntensity()`.
- **Semaphore** (`src/proactive/semaphore.ts`): global in-memory concurrency
  cap (max_concurrent_fires, default 5) + stagger floor (min_seconds_between_fires,
  default 90s). tryAcquire returns {acquired: false, reason} when capped.
- **Outcomes** (`src/ghost/outcomes.ts`): 10-min sweep scans chat.db for
  engagement signals (did the user reply within the window?) and stamps
  engaged/ignored on past fires. Drives engagement decay.

### Recovery & healing
- **Classification** (`src/recovery/classify.ts`): error string → FailureClass
  (request_too_large, image_dim_exceeded, stale_session_id, session_in_use,
  transient_api, send_failed, unknown). Table-driven; first pattern match wins.
- **Healers** (`src/recovery/healers.ts`): one healer per class. Structural
  fixes applied BEFORE model re-invocation. `healSendFailed`: runs `imsg launch`
  to re-inject the IMCore bridge dylib, probes with `imsg account`, prunes
  duplicate Messages instances, invalidates the rich-bridge cache.
  `healRequestTooLarge`: compacts session JSONL (image elision).
  `healImageDimExceeded`: sips-based downscale of >2000px images in-place.
  `healStaleSessionId`: drops the stored Claude session UUID.
- **Sweeper** (`src/boot/wire-recovery.ts`): two intervals — recovery sweep
  (loads unanswered inbound, classifies errors, runs healers, re-invokes model)
  and reaper (cleans up stale cron rows, bg-job rows, and unblocked outbox
  sessions). Cooldown per session (default 30 min). Operator alert on repeated
  failures.

### Cron scheduler
- **CronStore** (`src/cron/store.ts`): SQLite-backed persistent job store.
  Jobs have sessionKey, systemEvent (injected into the model's envelope as if
  the user sent it), schedule (once/recurring), and retry state.
- **Scheduler** (`src/cron/scheduler.ts`): runs in the daemon. Fires due jobs
  through `fireJob` (`src/cron/fire.ts`), which routes to `handleBatch` for
  system events (treated as inbound from the system), `src/proactive/fire.ts`
  for brown-nose events, or `src/trading/trigger-watcher.ts` for trading events.
- **External poke** (`main.ts`): 2s heartbeat calls `scheduler.poke()` so cron
  rows inserted by MCP subprocesses or agent completions fire promptly.
- **Inbound retry** (`src/cron/retry-marker.ts`): marks cron rows as
  inbound-retry so `cancelInboundRetries` can drop them when the session
  successfully answers. Capped at 3 retries × 5min spacing.

### iMessage send path
- **Policy** (`src/imessage/send.ts`): three paths — `bridge` (IMCore dylib,
  `imsg send-rich` with reply threading, expressive effects, subject lines),
  `legacy` (AppleScript via `imsg send`), `auto` (bridge when available,
  falls back to legacy). Configured by `[imessage_send].path` in config.toml.
  Self-healing: richBridgeAvailable() re-probes on a 5s TTL after a false
  result; recoverBridge() runs `imsg launch` in-band on first send failure.
- **Self-echo verify** (`main.ts`): before retrying a timed-out bridge send,
  checks chat.db for the exact text already delivered (prevents double-text).
- **Bridge singleton** (`src/imessage/bridge-singleton.ts`): prunes duplicate
  injected Messages.app instances at boot + 60s intervals + post-launch.
  Root cause of the double-send bug (two dylib instances servicing the same RPC).
- **Typing bubble** (`src/imessage/typing.ts`): `TypingSession` pulses
  `imsg typing` every 5s while the model is producing text. Latch: starts on
  first user-facing text block; stays lit through tool-text-tool patterns;
  explicitly stopped before `sendDeliver` or on error/tool-only.

### iMessage receive path
- **ChatDb** (`src/imessage/db.ts`): thin wrapper over bun:sqlite for the
  system chat.db. Handles Apple epoch conversion. Read-only (the harness
  only queries).
- **Decode** (`src/imessage/decode.ts`): extracts plain text from
  `message.text` or the attributedBody blob. Handles the undocumented
  attributed-string format.
- **Apple transcript** (`src/imessage/apple-transcript.ts`): extracts the
  on-device voice-note transcript from attachment user_info plist blobs.
  Free and instant — checked before Whisper.
- **Transcribe inbound** (`src/imessage/transcribe-inbound.ts`): OpenAI
  Whisper for audio attachments without Apple transcripts. Runs in parallel
  with attachment copy + link prefetch.
- **Participants** (`src/imessage/participants.ts`): resolves group chat
  participant handles from chat.db joins for the participant roster block.

### Trading subsystem (Quant)
- **Routing** (`src/trading/route.ts`): `tradingGate` — eligible handle
  (from `[trading].handles`) that says "trader"/"quant"/trigger name →
  sticky routing into `trading:dm:<handle>`. "trader off" switches back.
  Enforced BEFORE allowlist.dm.
- **Risk engine** (`src/trading/risk.ts`): pure function, unit-tested.
  Max % equity per position (`max_position_pct`, default 40%), per-order USD
  cap (`max_order_usd`, default $40), orders-per-run cap (6), cash floor ($5).
  Deterministic — the model proposes, code rejects.
- **Execution** (`src/trading/execute.ts`): single `executeOrder` path with
  UUID idempotency key (`ref_id`). Journals everything.
- **Broker** (`src/trading/broker.ts` + `brokers/http.ts`): two modes —
  `http_code` (daemon connects to Robinhood MCP directly as MCP client, needs
  bearer token) or `in_session` (model drives Robinhood tools, code risk-gates).
  The probe auto-selects.
- **Triggers** (`src/trading/trigger-store.ts` + `trigger-watcher.ts`): polls
  armed price triggers via the code-level broker. On threshold cross, injects
  a one-shot cron systemEvent into the trading session (~2s latency via
  externalPoke).
- **Dashboard** (`dashboard/trading-server/`): Hono server on port 4848,
  PIN-gated, shows positions, orders, journal, policy editor.

### RadarOmega integration
- **Vendored MCP server** (`vendor/radaromega-mcp/`): Node.js MCP server
  that drives RadarOmega.app via Chrome DevTools Protocol on port 9222.
  Self-healing: auto-connect, auto-launch (open -a RadarOmega --args
  --remote-debugging-port=<port>), auto-reconnect on socket drop.
  Single-flight concurrent connects. Everything timeout-bounded (3-45s).
- **Tool map**: 26 tools covering navigation, radar control, animation,
  overlays, data queries (warnings, lightning, METARs, NHC, storm reports),
  drawing, measurement, capture, and JS escape hatches.
- **Freshness watchdog** (`src/radaromega/refresher.ts`): preventatively
  relaunches the app after `refresh_hours` of uptime (the model engine corrupts
  on long runs). Deferred while any worker is mid-turn. Reactive self-heal in
  the MCP tools remains the backstop.

### Smart mirror
- **Bridge** (`src/mirror/bridge.ts`): WebSocket client to the Pi's mirror
  bridge. Handles wake-word detection, audio streaming, screen status.
- **Orchestrator** (`src/mirror/orchestrator.ts`): manages the voice
  conversation lifecycle — listen → transcribe → model turn → TTS → speak.
  Interrupt detection for wake-word during playback.
- **Voice** (`src/mirror/voice.ts`): local Kokoro-82M TTS (0.34s for a
  one-liner) + Whisper base.en STT (0.25s). Automatic fallback to hosted
  OpenRouter models when the sidecar is missing.
- **Background watch** (`src/mirror/background-watch.ts`): polls the agents
  table so sub-agent progress shows on the mirror glass even after the
  spawning turn ends.

### Data triggers
- **Store** (`src/triggers/store.ts`): SQLite-backed. Model-authored watch
  conditions — URL probes (HTTP GET + predicate) or JS expressions evaluated
  inside the live RadarOmega app (`evaluate_triggers_js` tool).
- **Watcher** (`src/triggers/watcher.ts`): polls armed triggers, evaluates
  conditions via the ProbeRunner, fires one-shot cron on match. Per-trigger
  check_interval; per-trigger error isolation.
- **Probe** (`src/triggers/evaluate.ts`): URL probe via fetch + JSONpath
  predicate; JS probe via CDP `Runtime.evaluate` in RadarOmega's renderer.

### MCP server
- **Server** (`src/mcp/server.ts`): stdio MCP server spawned as a subprocess
  by each Claude worker. Exposes ~27 tools organized by domain:
  messaging (send_message, send_attachment), contacts, memory/recall
  (semantic_search, save_memory, list_memories), cron (schedule_task,
  list_tasks), persona (update_persona_file, list_persona_files), fishing
  (fishing_query, fishing_viz), missions (start_mission, list_missions, cancel_mission),
  web, voice, video, image generation, typing, trading (gated), triggers,
  skills marketplace, agents/teams, background jobs, mirror, brown-nose,
  cloudflare browser.
- **Tool env** (`src/claude/mcp-config.ts` toolEnv): exports API keys
  (OpenAI, Gemini, ElevenLabs) into the MCP subprocess environment.

### Persona system
- **Files** (`persona/`): IDENTITY.md (who Edmund is), SOUL.md (how he thinks/
  speaks), HOME.md (context about the operator and the home), AGENTS.md (sub-agent guidance),
  VENUE_DM.md/VENUE_GROUP.md/VENUE_MIRROR.md (channel-specific behaviour),
  GHOST.md (ghost persona). Per-contact files in `persona/people/<handle>.md`.
  Per-group files in `persona/groups/<slug>.md`. Trading persona in
  `persona/trading/`.
- **Maintainer** (`src/persona/maintainer-observer.ts`): after every outbound,
  defers 60-120s then runs a background Claude pass that reads recent chat
  history and updates persona files. Skipped for orchestrator sessions
  (privacy: secondaries' private threads must not leak into main persona).
- **Sandbox** (`src/persona/sandbox.ts`): per-session scratch directory under
  `sandbox/<session_dir>/`. Model has full read/write. Reaper
  (`src/persona/sandbox-reaper.ts`) cleans machine-generated assets older
  than 7 days every 6h.

### Environment & deploy
- **Runtime**: `bun run src/main.ts` (or `bun run dev` for watch mode).
  Managed by a LaunchAgent (com.edmund-harness). Restart with
  `launchctl kickstart -k gui/<uid>/com.edmund-harness`.
- **Data directory**: `./data/` relative to the harness root. Contains
  daemon.log, session state SQLite, recall.sqlite, cron SQLite, MCP config
  JSONs, pool-stats.json, agent store, background job store. The daemon
  writes to this directory; the dashboard reads from it.
- **Config**: `config.toml` at the harness root. Loaded by
  `src/config/config.ts` via smol-toml + zod validation. Not in git.
  Template at `config.example.toml`.
- **Secrets**: API keys in `[keys]` section of config.toml. Exported to env
  vars (EDMUND_OPENAI_KEY, etc.) by main.ts for subprocess inheritance.
- **Logs**: `data/daemon.log` via `src/util/log-sink.ts` (overwrites on each
  boot). Structured: `[timestamp] [LEVEL] [tag] message {key: value}`.
  View with `bun run logs` (tail -F).

### External integrations
- **OpenRouter proxy** (`scripts/anthropic-proxy.ts`): local proxy on port
  3999 that translates Anthropic API requests to OpenRouter. Used as fallback
  when the primary Anthropic API is down. Config-driven model mapping
  (`[openrouter.fallbacks]`). Handles video/audio/image generation by routing
  to specialized providers.
- **Cloudflare** (`src/web/cloudflare.ts`): Cloudflare API client for
  dashboard tunnel management (operator types "harness" in DM → quicktunnel).
  Also used for browser sandbox via chrome-devtools-mcp.
- **Fishing** (`integrations/fishing/`): client for local FastAPI at
  http://127.0.0.1:8087/api/v1. Eligible sessions get `fishing_query` and
  `fishing_viz` directly; `skills/fishing` holds the endpoint playbook.
- **Skills marketplace** (`src/skills/`): fetches and installs skills from
  GitHub repos (`anthropics/skills`, `edmund-harness/edmund-skills`). Manages
  installed-skills.json. Approval required for scripts by default.

### Performance on the real target
- **Optimise for the Mac this runs on** — Apple Silicon, 16+ GB RAM, all
  available cores. The embedding pipeline uses multi-threaded WASM ONNX
  (numThreads = hardwareConcurrency, SIMD enabled). The worker pool caps at
  6 concurrent Claude processes.
- **Rank candidates by fit, not maximum spec.** The default embedding model is
  all-MiniLM-L6-v2 (384-dim, ~30MB) because it runs in-process with zero
  network latency. Only fall back to OpenAI embeddings when specifically
  configured.
- **Treat metadata as advisory, behaviour as authoritative.** The vector
  store's `PRAGMA data_version` drives cache invalidation — not timestamps.
  Session locks use actual unlock time, not configured timeouts alone.
- **Manage resource contention explicitly.** The RadarOmega refresher defers
  while `isWorkerPoolBusy()`. The auto-compact defers when `peekPending` has
  messages. Brown-nose fires are gated by the proactive semaphore.

### Safety & hygiene
- **Keep credentials out of git** — `config.toml` is gitignored. API keys
  only in `[keys]` and `[cloudflare]` config sections, exported to env vars.
  The OpenRouter proxy token is in config, not in source.
- **Don't thrash external APIs during diagnosis.** Prefer reading from the
  local SQLite stores and the daemon log. One deliberate probe, not a loop.
- **Clean up after experiments.** Remove test cron rows, test outbox entries,
  test session state rows. The recovery reaper auto-cleans stale rows, but
  don't rely on it for your own debris.
- **When claiming something works, say what was actually exercised** — which
  session, which code path, which model was invoked, which send path was used
  (bridge vs legacy).

## Don'ts

### Architecture
- **Don't invent a parallel pipeline** for a new channel or event type. The
  existing `InboundMessage` → `SessionPipeline` → `handleBatch` → `runClaude`
  → `sendDeliver` path is the one pipeline. New event sources become cron
  systemEvents or channel notifications that flow through it.
- **Don't edit the wrong data directory.** The daemon writes to
  `./data/` relative to the harness root. The dashboard reads the same
  directory. Fixes that only touch source code and never verify against the
  live `data/daemon.log` and SQLite files look correct and change nothing.
- **Don't put fixed `sleep`s in the hot path** — wait on real process exit
  (`imsg launch` completion), readiness (`PRAGMA data_version` changes,
  session lock release), or cache state (richBridgeAvailable probe TTL).
- **Don't await fire-and-forget calls** where the pipeline expects immediate
  feedback. The ghost observer's `onMainReplied` is fire-and-forget (60-120s
  deferred). The auto-compact is deferred after `sendDeliver`.
- **Don't add a dependency** for something `src/util/` already does (logging,
  ID generation, date formatting, SQLite open).
- **Don't spawn a Claude process directly** outside the worker pool —
  everything goes through `runClaude` (`src/claude/runner.ts`), which handles
  pool binding, MCP config selection, system prompt assembly, persona
  fingerprint, proxy env, and timeout/wedge protection.

### Session & state
- **Don't construct SessionKeys by hand.** Use `sessionKeyFor()`,
  `tradingKeyFor()`, `orchKeyFor()`, `sessionKeyForOrchestrator()` from
  `src/sessions/key.ts`. Hand-rolled keys create orphan sessions that
  routing and recovery can't find.
- **Don't hold a session lock across I/O you don't control.** The lock budget
  is 2× the Claude timeout (for turn + compact). Adding a third sequential
  Claude call under the same lock will trip the timeout and fire an operator
  alert.
- **Don't assume `state.db` is safe for concurrent writes** from a different
  process without WAL + busy_timeout. Always open via `src/db/open.ts`.
- **Don't advance the cursor before the ack is durable.** The `inbound_ack`
  write + `setCursor` ordering in `main.ts` onMessage is load-bearing.
  Reversing them drops messages on crash.

### External services
- **Don't hand credentials to third-party resolvers** or embed them in URLs
  passed to services you don't control. The OpenRouter proxy is the explicit,
  user-owned exception — it's localhost-only.
- **Don't infinite-retry after a permanent send error.** The outbox path
  detects permanent errors (CLI parse failure, content rejection) and
  schedules a reformat cron instead of stashing to outbox. The outbox only
  holds recoverable failures (bridge wedge, timeout).
- **Don't depend on undocumented chat.db schema.** The watcher queries are
  reverse-engineered from the system Messages database. Test against the
  live DB after any macOS update; Apple changes the schema silently.
- **Don't treat the Robinhood MCP as always available.** The broker
  auto-detects http_code vs in_session mode. Don't assume code-level auth
  is present.

### Performance
- **Don't rank by "biggest/newest/highest wins."** The recall system uses
  MMR (Maximal Marginal Relevance) to diversify results — pure cosine
  ranking would return near-duplicates. Recency boost is bounded
  (exponential decay, not linear).
- **Don't re-enable expensive configuration on constrained hardware.** The
  default embedding model is 384-dim in-process WASM. Don't switch to
  OpenAI embeddings (network round-trip per batch) without measuring.
- **Don't treat HEIC/HEIF images as first-class** without sips conversion.
  The runner converts HEIC to JPEG via sips before base64 encoding for
  Claude. Don't pass raw HEIC bytes.

### Agent behaviour
- **Don't thrash shared accounts or production while "figuring it out."**
  Diagnose from `data/daemon.log`, `data/*.sqlite`, and
  `~/.claude/debug/<session-id>.txt` (Claude Code debug logs). One
  intentional probe, not a loop.
- **Don't generalise from a single failure** to "this is permanently broken."
  The recovery system has 6 classified failure modes with specific healers.
  Re-check with a known-good and a known-bad case.
- **Don't leave debris** — scratch scripts in `/tmp`, test rows in SQLite
  stores, half-applied migrations, commented-out experiments. The reaper
  cleans some things but not everything.
- **Don't restart the daemon for config changes** that the running process
  can't see — TOML config is loaded once at boot. Config changes need a
  daemon restart (or a targeted code change that re-reads a specific key).

## Quick reference paths

| Concern | Location |
|--------|----------|
| Entry point | `src/main.ts` |
| Config & secrets | `config.toml`, `src/config/config.ts` |
| Session pipeline | `src/channels/pipeline.ts`, `src/channels/turn.ts`, `src/channels/deliver.ts` |
| Envelope assembly | `src/channels/envelope.ts`, `src/channels/history.ts` |
| Claude runner + pool | `src/claude/runner.ts`, `src/claude/pool.ts`, `src/claude/worker.ts` |
| MCP config (per-turn) | `src/claude/mcp-config.ts` |
| System prompt assembly | `src/claude/system-prompt.ts`, `src/claude/persona.ts` |
| Auto-compact | `src/claude/auto-compact.ts`, `src/claude/session-compact.ts` |
| iMessage watcher | `src/imessage/watcher.ts` |
| iMessage send | `src/imessage/send.ts`, `src/imessage/bridge-singleton.ts` |
| Gating / allowlist | `src/gating/allowlist.ts` |
| Session state | `src/sessions/store.ts`, `src/sessions/key.ts`, `src/sessions/locks.ts` |
| Semantic recall pipeline | `src/memory/indexer.ts`, `src/memory/vector-store.ts`, `src/memory/auto-recall.ts`, `src/memory/embed-provider.ts` |
| Recall wiring (boot) | `src/boot/wire-recall.ts` |
| Recovery + healers | `src/boot/wire-recovery.ts`, `src/recovery/classify.ts`, `src/recovery/healers.ts` |
| Ghost / brown-nose | `src/ghost/observer.ts`, `src/ghost/think.ts`, `src/ghost/picker.ts`, `src/ghost/prefs.ts` |
| Proactive semaphore | `src/proactive/semaphore.ts`, `src/proactive/fire.ts` |
| Cron scheduler | `src/cron/scheduler.ts`, `src/cron/store.ts`, `src/cron/fire.ts` |
| Orchestrator routing | `src/orchestrators/registry.ts`, `src/orchestrators/visibility.ts` |
| Trading subsystem | `src/trading/route.ts`, `src/trading/risk.ts`, `src/trading/execute.ts`, `src/trading/broker.ts` |
| RadarOmega integration | `vendor/radaromega-mcp/`, `src/radaromega/refresher.ts` |
| Smart mirror | `src/mirror/bridge.ts`, `src/mirror/orchestrator.ts`, `src/mirror/voice.ts` |
| Data triggers | `src/triggers/store.ts`, `src/triggers/watcher.ts`, `src/triggers/evaluate.ts` |
| MCP tools (server-side) | `src/mcp/server.ts`, `src/mcp/tools/*.ts` |
| Persona files | `persona/IDENTITY.md`, `persona/SOUL.md`, `persona/HOME.md`, `persona/VENUE_*.md` |
| Persona maintainer | `src/persona/maintainer-observer.ts` |
| Live runtime state | `data/daemon.log`, `data/*.sqlite`, `data/pool-stats.json` |
| Claude debug logs | `~/.claude/debug/<session-id>.txt` |
| Restart | `launchctl kickstart -k gui/<uid>/com.edmund-harness` |
| Logs | `bun run logs` (tail -F data/daemon.log) |
| Test suite | `bun test tests` |
| TypeScript check | `bun run typecheck` (tsc --noEmit) |
| Dependencies | `package.json` (Bun, @huggingface/transformers, @modelcontextprotocol/sdk, hono, zod, smol-toml) |
| Database layer | `src/db/open.ts` (SQLite via bun:sqlite, WAL + busy_timeout) |
| Dashboard | `dashboard/server/main.ts` (Hono, port 4747), `dashboard/trading-server/main.ts` (port 4848) |
| Skills (model-facing) | `skills/*/SKILL.md` |
| Persona (model-facing) | `persona/`, `persona/people/*.md`, `persona/groups/*.md`, `persona/trading/` |
| OpenRouter proxy | `scripts/anthropic-proxy.ts` (port 3999) |
| Cloudflare tunnel | `scripts/dashboard-tunnel.sh` |
| Boot catch-up | `src/boot/catchup.ts` |

## Verification habits

- After **pipeline/debounce changes**: verify with a real burst — send 3 rapid
  messages, confirm one turn (not three) fires. Check the coalesce log line
  in daemon.log. Verify durable ack survives a kill -9 inside the debounce window.
- After **Claude runner/pool changes**: check pool-stats.json for worker count
  and miss rate. Confirm warm-reuse across same-loadout turns. Verify
  auto-compact defers when a follow-up is queued.
- After **recall/indexer changes**: check the coverage log line (`bun run logs |
  grep recall`). Confirm indexed = total for the current window. Run a known
  query and verify hits are relevant.
- After **ghost/brown-nose changes**: check ghost tick log lines. Verify
  spacing floor (no two ticks within 45 min for same session). Check
  semaphore isn't capping real fires. Verify outcome sweep stamps engagement.
- After **send path changes**: test bridge + legacy paths. Confirm self-echo
  verify catches the double-text case. Check that permanent errors schedule
  a reformat cron, not outbox.
- After **recovery/healer changes**: simulate each FailureClass. Confirm the
  healer runs, the model is re-invoked exactly once, and the cooldown
  prevents duplicate heal attempts.
- After **config/schema changes**: run `bun run typecheck`. Verify against
  config.example.toml. Check that the daemon boots and the banner shows
  expected values.
- After **cleanup**: check data/*.sqlite for test rows. Verify daemon.log
  isn't polluted with test runs. Check that scratch sandbox dirs are clean.

## Keeping this skill alive

This file is scar tissue, not documentation. Add a rule when something bites —
with the concrete detail that makes it credible (the number, the path, the
symptom). Delete a rule when the code changes so it's no longer true; a stale
rule costs more than a missing one. If a section grows past what fits on a
screen, split it into `references/<topic>.md` and leave a pointer here.
