/**
 * The inbound half of the watch: reads what every harness server recorded
 * about who asked it for what, keeps the running picture
 * (security/watch/inbound.ts), blocks what scores high, and has the judge
 * look at a visitor only when the picture says harm or persistence.
 *
 * It reads the `net-in` log channel and not the servers themselves, because
 * the servers are four separate processes and one of them is Python. Ten
 * seconds behind is soon enough: nothing here answers a request.
 *
 * Tiers, as the plan set them. Blocked quietly: an address whose score got
 * high. Reviewed and recorded: one the judge called benign or suspicious.
 * Texted to the operator: brute force on a share, a flood spread across
 * many addresses, and anything the judge called serious, which means aimed
 * at this server or got through.
 *
 * This machine's own public address and its IPv6 /64 are never scored and
 * never looked up: the operator opening their own pages is not a visitor.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { type Hit, Inbound, type Review, subnetOf } from "../security/watch/inbound.ts";
import { Reputation, refreshReputation } from "../security/watch/reputation.ts";
import { watchDir } from "../security/watch/state.ts";
import { atomicWriteFileSync } from "../util/atomic-write.ts";
import { block } from "../util/blocklist.ts";
import { classifyClient, threatSignals } from "../util/inbound-signals.ts";
import { readChannel } from "../util/log-files.ts";
import { log } from "../util/log.ts";
import { type Incident, newIncidentId } from "./incidents.ts";
import type { Verdict } from "./judge.ts";
import type { WatchMode } from "./service.ts";

const BLOCK_MS = 24 * 3_600_000;
/**
 * The ranges reserved for documentation (RFC 5737, RFC 3849). No real
 * visitor can come from one, so anything raised about one is the fire drill.
 */
const DOCUMENTATION = /^(?:192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|2001:db8:)/i;
/** The judge is asked about at most this many visitors an hour. */
const REVIEWS_PER_HOUR = 20;

export type Self = { v4: string[]; v6: string[] };

/** This machine's own addresses as the outside sees them. */
async function discoverSelf(fetcher: typeof fetch = fetch): Promise<Self> {
  const self: Self = { v4: [], v6: [] };
  for (const list of Object.values(networkInterfaces())) {
    for (const address of list ?? []) {
      // A global IPv6 address is the same from outside; an IPv4 one behind a router is not.
      if (address.family === "IPv6" && !address.internal && /^[23]/.test(address.address)) {
        const prefix = subnetOf(address.address);
        if (!self.v6.includes(prefix)) self.v6.push(prefix);
      }
    }
  }
  try {
    const res = await fetcher("https://1.1.1.1/cdn-cgi/trace", {
      signal: AbortSignal.timeout(8_000),
    });
    const ip = /^ip=(.+)$/m.exec(await res.text())?.[1]?.trim();
    if (ip?.includes(":")) {
      const prefix = subnetOf(ip);
      if (!self.v6.includes(prefix)) self.v6.push(prefix);
    } else if (ip) {
      self.v4.push(ip);
    }
  } catch {
    // Offline, or the lookup is blocked: the interface addresses still count.
  }
  return self;
}

export function isSelf(self: Self, ip: string): boolean {
  return ip.includes(":") ? self.v6.includes(subnetOf(ip)) : self.v4.includes(ip);
}

const selfFile = (dataDir: string) => join(watchDir(dataDir), "self.json");

/** The addresses last found to be this machine's own, for the traffic report. */
export function readSelf(dataDir: string): Self {
  try {
    const raw = JSON.parse(readFileSync(selfFile(dataDir), "utf8")) as Partial<Self>;
    return { v4: raw.v4 ?? [], v6: raw.v6 ?? [] };
  } catch {
    return { v4: [], v6: [] };
  }
}

type NetInFields = {
  server?: string;
  method?: string;
  path?: string;
  status?: number;
  ip?: string;
  via?: string;
  ua?: string;
  client?: string;
  probes?: string[];
  relayed?: boolean;
  blocked?: boolean;
  count?: number;
};

/** One record of the `net-in` channel as a hit, or null when it is not an outside visitor. */
export function hitOf(ts: string, fields: NetInFields, self: Self): Hit | null {
  if (!fields || fields.relayed || fields.count !== undefined) return null;
  // Through a tunnel the tunnel says who asked; a direct caller on loopback is this machine.
  const ip = fields.via;
  if (!ip || isSelf(self, ip)) return null;
  const method = fields.method ?? "GET";
  const path = fields.path ?? "/";
  return {
    at: Date.parse(ts),
    ip,
    server: fields.server ?? "?",
    method,
    path,
    status: fields.status ?? 0,
    probes: fields.probes ?? threatSignals(method, path, fields.ua ?? null),
    client: fields.client ?? classifyClient(fields.ua ?? null).kind,
    blocked: fields.blocked === true,
  };
}

export type InboundWatchDeps = {
  dataDir: string;
  logsDir: string;
  mode: WatchMode;
  judge: (record: string, flagged: string) => Promise<Verdict | null>;
  record: (incident: Incident) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
};

export class InboundWatch {
  readonly inbound: Inbound;
  private readonly reputation: Reputation;
  private self: Self = { v4: [], v6: [] };
  private cursor: number;
  private timers: ReturnType<typeof setInterval>[] = [];
  private pumping = false;
  private reviewTimes: number[] = [];
  private readonly now: () => number;
  private readonly dir: string;
  readonly counts = { hits: 0, blocked: 0, reviewed: 0 };

  constructor(private readonly deps: InboundWatchDeps) {
    this.now = deps.now ?? Date.now;
    this.dir = join(watchDir(deps.dataDir), "reputation");
    mkdirSync(this.dir, { recursive: true });
    this.reputation = new Reputation(this.dir);
    let baseline: number[] | undefined;
    try {
      baseline = JSON.parse(
        readFileSync(join(watchDir(deps.dataDir), "inbound-baseline.json"), "utf8"),
      );
    } catch {}
    this.inbound = new Inbound((ip) => this.reputation.lookup(ip), baseline);
    this.self = readSelf(deps.dataDir);
    this.cursor = this.now();
  }

  start(): void {
    if (this.deps.mode === "off" || this.timers.length > 0) return;
    const every = (ms: number, run: () => void) => {
      const timer = setInterval(run, ms);
      timer.unref?.();
      this.timers.push(timer);
    };
    every(10_000, () => void this.pump());
    every(10 * 60_000, () => this.saveBaseline());
    // Hourly once everything is in hand; every few minutes until then. Not
    // at the instant of starting: the daemon's first minute is busy enough
    // that both the table download and the address lookup timed out
    // (measured 2026-11-25), and an hour is a long time to wait to retry.
    let lastTry = 0;
    every(90_000, () => {
      const complete = this.reputation.loaded.asn !== undefined && this.self.v4.length > 0;
      if (this.now() - lastTry < (complete ? 3_600_000 : 5 * 60_000)) return;
      lastTry = this.now();
      void this.refresh();
    });
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.saveBaseline();
  }

  private saveBaseline(): void {
    try {
      atomicWriteFileSync(
        join(watchDir(this.deps.dataDir), "inbound-baseline.json"),
        `${JSON.stringify(this.inbound.baselineByHour().map((n) => Math.round(n)))}\n`,
      );
    } catch {}
  }

  /** Fetch the lists that are a day old, and find this machine's own addresses again. */
  async refresh(): Promise<void> {
    const fetcher = this.deps.fetch ?? fetch;
    const replaced = await refreshReputation(this.dir, fetcher, this.now());
    if (replaced.length > 0 || !existsSync(selfFile(this.deps.dataDir))) {
      this.reputation.reload();
      log.info("watch", "reputation lists loaded", this.reputation.loaded);
    }
    const self = await discoverSelf(fetcher);
    if (self.v4.length + self.v6.length > 0) {
      this.self = self;
      atomicWriteFileSync(selfFile(this.deps.dataDir), `${JSON.stringify(self)}\n`);
    }
  }

  /** Read what the servers have recorded since the last read. */
  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const from = this.cursor;
      const to = this.now();
      this.cursor = to;
      for (const record of readChannel(this.deps.logsDir, "net-in", from, to)) {
        const hit = hitOf(record.ts, (record.fields ?? {}) as NetInFields, this.self);
        if (hit) await this.take(hit);
      }
    } catch (err) {
      log.warn("watch", "could not read the inbound log", { err: (err as Error).message });
    } finally {
      this.pumping = false;
    }
  }

  /** One hit: score it, block if it earned it, review if it tripped one. */
  async take(hit: Hit): Promise<void> {
    this.counts.hits++;
    const outcome = this.inbound.observe(hit);
    if (outcome.block) this.blockQuietly(outcome.block.target, outcome.block.why);
    for (const review of outcome.reviews) await this.review(review);
  }

  private blockQuietly(target: string, why: string): void {
    const enforcing = this.deps.mode === "enforce";
    if (enforcing) block(target, why, this.now() + BLOCK_MS, this.now());
    this.counts.blocked++;
    log.event(
      "security",
      "watch",
      `${enforcing ? "blocked" : "would block"} ${target} for a day: ${why}`,
      {
        kind: "auto-block",
        target,
      },
    );
  }

  private async review(review: Review): Promise<void> {
    const now = this.now();
    this.reviewTimes = this.reviewTimes.filter((t) => now - t < 3_600_000);
    // Brute force and a spread-out flood are serious on their face; the judge adds a sentence when it can.
    const onItsFace = review.reason === "brute-force" || review.reason === "flood";
    let verdict: Verdict | null = null;
    if (this.reviewTimes.length < REVIEWS_PER_HOUR) {
      this.reviewTimes.push(now);
      this.counts.reviewed++;
      verdict = await this.deps.judge(review.record, review.why).catch(() => null);
    }
    const serious = onItsFace || verdict?.verdict === "serious";
    if (!serious && (!verdict || verdict.verdict === "benign")) {
      log.event("security", "watch", `reviewed ${review.subject}: ${review.why}`, {
        kind: "inbound-review",
        reason: review.reason,
        verdict: verdict?.verdict ?? "none",
        why: verdict?.why,
      });
      return;
    }
    const enforcing = this.deps.mode === "enforce";
    const incident: Incident = {
      id: newIncidentId(),
      at: now,
      where: review.subject,
      kind: `inbound-${review.reason}`,
      tier: serious ? "serious" : "notable",
      what: review.why,
      verdict: verdict?.verdict ?? "rule",
      judged: verdict?.why ?? "",
      pattern: `inbound|${review.subject}|machine`,
      did: [],
      undo: [],
      status: "open",
      ...(DOCUMENTATION.test(review.subject) ? { drill: true as const } : {}),
    };
    // An address can be blocked. A network or a path cannot be, from here.
    const target = /^[0-9a-f.:]+$/i.test(review.subject) ? review.subject : null;
    if (serious && target && enforcing) {
      block(target, review.why, now + BLOCK_MS, now);
      incident.did.push("blocked it for a day");
      incident.undo.push({ kind: "unblock", target });
    }
    await this.deps.record(incident);
  }
}
