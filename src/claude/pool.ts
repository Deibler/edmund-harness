import { humanMs, log } from "../util/log.ts";
import { Worker, type WorkerResult, type WorkerSpawnArgs, type WorkerTurn } from "./worker.ts";

/**
 * Per-session pool of resident `claude` workers.
 *
 * The pool is keyed by session key (DM canon or group chat guid). Each
 * entry holds at most ONE Worker — turns within a session serialize, so we
 * don't need multiple workers per key. The pool's job is to:
 *
 *  - Reuse a warm worker across turns of the same conversation (the big win).
 *  - Evict on idle (`idleEvictMs`) so a quiet session doesn't hold a Claude
 *    process forever.
 *  - Cap total resident workers at `maxWorkers` (RAM ceiling) — evict the
 *    LRU idle entry when an acquire would push us past the cap.
 *  - Recycle a worker when its bind state no longer matches the requested
 *    turn — different sandbox path, different sender identity (group only,
 *    rare), different inboundDepth, etc. Determined by `rebindKey`.
 *
 * Concurrency: the pool itself is single-threaded JS; acquire/release pair
 * around an `await` inside the runner. The `busy` flag prevents two turns
 * from interleaving on the same worker.
 */

export type PoolOptions = {
  maxWorkers: number;
  idleEvictMs: number;
  perTurnIdleMs: number;
};

type Entry = {
  worker: Worker;
  /** Opaque key describing the worker's bind state. Mismatch ⇒ recycle. */
  rebindKey: string;
  busy: boolean;
  lastUsedMs: number;
};

export class WorkerPool {
  private entries = new Map<string, Entry>();
  private sweepTimer: ReturnType<typeof setInterval>;
  private statsTimer: ReturnType<typeof setInterval>;
  private opts: PoolOptions;
  private stopped = false;
  /** Rolling per-window counters reset by the stats logger. Lets the
   *  operator see "MISS rate is high" at a glance instead of grep-piping
   *  the daemon log. */
  private stats = {
    hits: 0,
    misses: 0,
    rebinds: 0,
    deadDiscards: 0,
    idleEvictions: 0,
    lruEvictions: 0,
    /** Death reasons since last stats flush (capped) */
    deaths: new Map<string, number>(),
  };

  constructor(opts: PoolOptions) {
    this.opts = opts;
    // Sweep idle workers every 30s. Cheap (Map iteration) when there are
    // no workers to evict.
    this.sweepTimer = setInterval(() => this.sweepIdle(), 30_000);
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
    // Stats roll-up every 10 min. Single log line summarising warm-reuse
    // health; high MISS rate is the #1 latency signal.
    this.statsTimer = setInterval(() => this.flushStats(), 10 * 60_000);
    if (typeof this.statsTimer.unref === "function") this.statsTimer.unref();
  }

  private flushStats(): void {
    const s = this.stats;
    const total = s.hits + s.misses;
    if (total === 0) return;
    const hitPct = Math.round((s.hits / total) * 100);
    const topDeaths = [...s.deaths.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason, n]) => `${n}×${reason}`)
      .join(", ");
    log.info("claude-pool", "stats (10m)", {
      hits: s.hits,
      misses: s.misses,
      hit_pct: hitPct,
      rebinds: s.rebinds,
      dead_discards: s.deadDiscards,
      idle_evictions: s.idleEvictions,
      lru_evictions: s.lruEvictions,
      top_deaths: topDeaths || "none",
      pool_size: this.entries.size,
    });
    this.stats = {
      hits: 0,
      misses: 0,
      rebinds: 0,
      deadDiscards: 0,
      idleEvictions: 0,
      lruEvictions: 0,
      deaths: new Map(),
    };
  }

  /** Public snapshot for the dashboard. Numbers are the live rolling
   *  counters since the last 10-minute flush; pool_size is current. */
  getStats(): {
    poolSize: number;
    hits: number;
    misses: number;
    rebinds: number;
    deadDiscards: number;
    idleEvictions: number;
    lruEvictions: number;
    deaths: Array<{ reason: string; n: number }>;
    workers: Array<{
      sessionKey: string;
      rebindKey: string;
      lastUsedMs: number;
      pid: number | null;
      isDead: boolean;
    }>;
  } {
    const s = this.stats;
    const deaths = [...s.deaths.entries()]
      .map(([reason, n]) => ({ reason, n }))
      .sort((a, b) => b.n - a.n);
    const workers = [...this.entries.entries()].map(([sessionKey, e]) => ({
      sessionKey,
      rebindKey: e.rebindKey,
      lastUsedMs: e.lastUsedMs,
      pid: (e.worker as { pid?: number | null }).pid ?? null,
      isDead: e.worker.isDead,
    }));
    return {
      poolSize: this.entries.size,
      hits: s.hits,
      misses: s.misses,
      rebinds: s.rebinds,
      deadDiscards: s.deadDiscards,
      idleEvictions: s.idleEvictions,
      lruEvictions: s.lruEvictions,
      deaths,
      workers,
    };
  }

  /** The rebindKey of this session's current warm worker (dead workers
   *  excluded), or null. Lets the runner make upgrade-only binding
   *  decisions — e.g. keep using an already-browser-bound worker for a
   *  non-browser turn instead of paying a recycle + cold prefix. */
  currentRebindKey(sessionKey: string): string | null {
    const e = this.entries.get(sessionKey);
    if (!e || e.worker.isDead) return null;
    return e.rebindKey;
  }

  /** True while any pooled worker is mid-turn. Lets background maintenance
   *  (e.g. the RadarOmega freshness restart) defer until the harness is
   *  quiet instead of yanking shared resources out from under a session. */
  anyBusy(): boolean {
    for (const e of this.entries.values()) if (e.busy) return true;
    return false;
  }

  /** Force-evict every worker. Used by the dashboard "Flush pool" button. */
  async flushAll(reason = "dashboard flush"): Promise<number> {
    const keys = [...this.entries.keys()];
    for (const k of keys) await this.evict(k, reason);
    return keys.length;
  }

  private recordDeath(reason: string): void {
    // Bucket by the leading token so "exited code=1 ..." and "exited code=1 ..."
    // collapse. Cap at 400 chars to bound key growth.
    const key = reason.split("|")[0]!.trim().slice(0, 80) || "unknown";
    this.stats.deaths.set(key, (this.stats.deaths.get(key) ?? 0) + 1);
  }

  /**
   * Run one turn against the pool. Acquires (or spawns) a worker bound to
   * the requested `rebindKey`, sends the payload, returns the result.
   * Caller is responsible for serializing turns within a session — for
   * edmund-harness that's guaranteed by the pipeline's per-session lock.
   */
  async run(args: {
    sessionKey: string;
    rebindKey: string;
    spawn: WorkerSpawnArgs;
    payload: WorkerTurn;
  }): Promise<WorkerResult> {
    if (this.stopped) {
      return {
        ok: false,
        error: "pool stopped",
        claudeSessionId: undefined,
        durationMs: 0,
      };
    }
    let entry = this.entries.get(args.sessionKey);

    // Recycle on bind-key mismatch (depth changed, sandbox changed, etc.)
    if (entry && entry.rebindKey !== args.rebindKey) {
      log.info("claude-pool", "recycling worker (rebindKey mismatch)", {
        session: args.sessionKey,
        old: entry.rebindKey,
        new: args.rebindKey,
      });
      this.stats.rebinds++;
      await this.evict(args.sessionKey, "rebindKey mismatch");
      entry = undefined;
    }

    // Recycle if the worker died between turns (process exit, crash, etc.).
    if (entry?.worker.isDead) {
      // Death reason is opaque without this — operator can't tell whether
      // workers are dying from CLI auto-exit, MCP crash, OOM, etc. Each of
      // those needs a different fix, so surfacing the reason is critical.
      const reason = entry.worker.deathReason ?? "unknown";
      log.info("claude-pool", "discarding dead worker", {
        session: args.sessionKey,
        reason: reason.slice(0, 200),
        bound_for_ms: Date.now() - entry.lastUsedMs,
      });
      this.stats.deadDiscards++;
      this.recordDeath(reason);
      this.entries.delete(args.sessionKey);
      entry = undefined;
    }

    let spawned = false;
    if (!entry) {
      // Capacity check — make room if needed by evicting the LRU idle entry.
      if (this.entries.size >= this.opts.maxWorkers) {
        await this.evictLruIdle();
      }
      const worker = new Worker(args.spawn);
      entry = {
        worker,
        rebindKey: args.rebindKey,
        busy: false,
        lastUsedMs: Date.now(),
      };
      this.entries.set(args.sessionKey, entry);
      worker.onDeath((reason) => {
        // A clean `exited code=0 signal=null` is the CLI auto-exiting between
        // turns — expected pool churn, not a failure. Logging it at warn
        // buried the real deaths (code!=0, signals, "Session ID already in
        // use") under hundreds of benign lines. Keep warn for those.
        const clean = /^exited code=0 signal=null$/.test(reason);
        log[clean ? "info" : "warn"]("claude-pool", "worker died", {
          session: args.sessionKey,
          reason,
        });
        this.recordDeath(reason);
        // The entry will be replaced on next run() if it's still in the map.
      });
      spawned = true;
      this.stats.misses++;
    } else {
      this.stats.hits++;
    }

    // One-liner per turn so the operator can see warm-reuse working. HIT =
    // existing process handled this turn (cache benefit available); MISS =
    // we had to spawn (cold turn). On MISS we surface the spawn mode
    // (resume vs cold-cohort vs fresh) so the operator doesn't need a
    // separate worker-level spawn line for that.
    const idleMs = Date.now() - entry.lastUsedMs;
    const fields: Record<string, unknown> = {
      session: args.sessionKey,
      pool_size: this.entries.size,
    };
    if (spawned) {
      const mode = inferSpawnMode(args.spawn.argv);
      if (mode) fields.mode = mode;
    }
    log.info(
      "claude-pool",
      spawned ? "MISS (cold spawn)" : `HIT (warm reuse, idle ${humanMs(idleMs)})`,
      fields,
    );

    if (entry.busy) {
      // Pipeline should serialize, but defend against bugs that would
      // otherwise interleave turns on one worker.
      return {
        ok: false,
        error: "worker busy (concurrent turns for same session)",
        claudeSessionId: entry.worker.sessionId ?? undefined,
        durationMs: 0,
      };
    }

    entry.busy = true;
    try {
      const result = await entry.worker.turn(args.payload);
      entry.lastUsedMs = Date.now();
      return result;
    } finally {
      entry.busy = false;
    }
  }

  /** Evict the entry for one session (e.g. after a healer cleared its session id). */
  async evict(sessionKey: string, reason: string): Promise<void> {
    const entry = this.entries.get(sessionKey);
    if (!entry) return;
    this.entries.delete(sessionKey);
    try {
      await entry.worker.shutdown(reason);
    } catch (err) {
      log.warn("claude-pool", "shutdown threw", { err: (err as Error).message });
    }
  }

  /** True if a non-dead worker is currently bound to this session. Used by
   *  compaction to defer file rewrites while a worker is live. */
  hasWorker(sessionKey: string): boolean {
    const entry = this.entries.get(sessionKey);
    return entry !== undefined && !entry.worker.isDead;
  }

  /**
   * Inject Claude Code's `/compact` slash command into the warm worker for
   * this session, compacting the persistent JSONL in place. Returns the
   * worker result, or `null` when there's no warm worker to compact
   * (caller should skip — the cold session will recompact itself naturally
   * on its first resume).
   *
   * Takes the busy flag so a concurrent `run()` from the same session
   * waits (or errors with "worker busy") rather than racing on stdin.
   *
   * INVARIANT: callers must hold the per-session lock — the deferred
   * compact runs in its own locked section (scheduleDeferredCompact in
   * src/channels/turn.ts). The busy flag here is a second line of
   * defense, not a substitute for the outer lock — without it, run()
   * and compactIfWarm could race between the busy-check and the
   * busy=true write.
   */
  async compactIfWarm(sessionKey: string, signal?: AbortSignal): Promise<WorkerResult | null> {
    const entry = this.entries.get(sessionKey);
    if (!entry || entry.worker.isDead) return null;
    if (entry.busy) {
      return {
        ok: false,
        error: "worker busy with a turn — /compact deferred",
        claudeSessionId: entry.worker.sessionId ?? undefined,
        durationMs: 0,
      };
    }
    entry.busy = true;
    try {
      const startedAt = Date.now();
      log.info("claude-pool", "injecting /compact", {
        session: sessionKey,
      });
      const result = await entry.worker.compact(signal);
      entry.lastUsedMs = Date.now();
      log.info("claude-pool", result.ok ? "/compact ok" : "/compact failed", {
        session: sessionKey,
        dur_ms: Date.now() - startedAt,
        error: result.ok ? undefined : result.error,
      });
      return result;
    } finally {
      entry.busy = false;
    }
  }

  /** Total worker count (busy + idle). */
  size(): number {
    return this.entries.size;
  }

  /** Snapshot for dashboards / debug. */
  snapshot(): Array<{ sessionKey: string; busy: boolean; idleMs: number; dead: boolean }> {
    const now = Date.now();
    return [...this.entries.entries()].map(([key, e]) => ({
      sessionKey: key,
      busy: e.busy,
      idleMs: now - e.lastUsedMs,
      dead: e.worker.isDead,
    }));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.sweepTimer);
    clearInterval(this.statsTimer);
    const evictions: Promise<void>[] = [];
    for (const key of [...this.entries.keys()]) {
      evictions.push(this.evict(key, "pool shutdown"));
    }
    await Promise.all(evictions);
  }

  private async evictLruIdle(): Promise<void> {
    let lru: { key: string; ageMs: number } | null = null;
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.busy) continue;
      const age = now - entry.lastUsedMs;
      if (!lru || age > lru.ageMs) lru = { key, ageMs: age };
    }
    if (!lru) {
      // All workers are busy — refuse to spawn another (the caller's
      // turn will get a "pool full" error from acquire). Rare in practice
      // because a single user is a single concurrent turn.
      log.warn("claude-pool", "at capacity with all workers busy", { size: this.entries.size });
      return;
    }
    log.info("claude-pool", "evicting LRU idle", { session: lru.key, ageMs: lru.ageMs });
    this.stats.lruEvictions++;
    await this.evict(lru.key, "lru-idle to make room");
  }

  private sweepIdle(): void {
    if (this.stopped) return;
    const now = Date.now();
    for (const [key, entry] of [...this.entries]) {
      if (entry.busy) continue;
      if (entry.worker.isDead) {
        this.entries.delete(key);
        continue;
      }
      if (now - entry.lastUsedMs > this.opts.idleEvictMs) {
        log.info("claude-pool", "evicting idle worker", {
          session: key,
          idleMs: now - entry.lastUsedMs,
        });
        this.stats.idleEvictions++;
        // Fire-and-forget — don't block the sweep loop.
        void this.evict(key, "idle eviction");
      }
    }
  }
}

/** Extract the spawn mode (resume/cohort/fresh) from a `claude` argv so the
 *  pool's MISS line can carry it without depending on Worker internals. */
function inferSpawnMode(argv: string[]): string | null {
  const ri = argv.indexOf("--resume");
  if (ri >= 0 && ri + 1 < argv.length) return `resume ${argv[ri + 1]!.slice(0, 8)}…`;
  const si = argv.indexOf("--session-id");
  if (si >= 0 && si + 1 < argv.length) return `cold ${argv[si + 1]!.slice(0, 8)}…`;
  return "cold (fresh)";
}
