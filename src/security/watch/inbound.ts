/**
 * Who is knocking: a running picture of every outside address that reaches
 * a harness server, and the point at which one is worth a review.
 *
 * The tunnels dial out, so a volumetric attack lands on the tunnel provider.
 * What reaches this machine is application traffic: the same probes every
 * address on the internet gets, guesses at a share's key, and floods that
 * are slow or spread out. The access log already counts a single address
 * that scans, floods or is refused over and over. That misses two things:
 * many addresses each staying under the limit, and the difference between
 * noise and somebody actually working on this server.
 *
 * So each address has a score that fades over a day, and the same counts are
 * kept by /24, by IPv6 /64 and by network against what is normal for the
 * hour. Suspicion is not enough to bother anyone: a bad reputation, a probe
 * or an odd client only adds to the score, and an address that scores high
 * is blocked quietly. A review is tripped only by harm or by persistence:
 *
 *   got through     a probe or payload answered with a real page
 *   key guessed     refused keys on a share, then an accepted one
 *   aimed           exploit payloads at a route that exists here
 *   brute force     refusals that keep coming
 *   flood           a subnet, a network or one link far above its baseline
 *   persistent      back across hours, walking many paths, trying more
 *                   than one share, or returning after a block
 *
 * This file only counts and decides. Reading the log, blocking and asking
 * the judge are the watch's (src/watch/inbound-watch.ts).
 */
import type { Standing } from "./reputation.ts";

export type Hit = {
  at: number;
  /** The outside address the request came from. */
  ip: string;
  server: string;
  method: string;
  path: string;
  status: number;
  /** The probe signatures the request matched (inbound-signals.ts). */
  probes: string[];
  /** What the user agent claims to be: browser, crawler, tool, scanner… */
  client: string;
  /** True when the server refused it because the address is blocked. */
  blocked?: boolean;
};

type ReviewReason =
  | "got-through"
  | "key-guessed"
  | "aimed"
  | "brute-force"
  | "flood"
  | "persistent"
  | "leaked-link";

export type Review = {
  reason: ReviewReason;
  /** The address, or the subnet, network or path the review is about. */
  subject: string;
  why: string;
  /** What the judge is shown. */
  record: string;
};

export type Outcome = {
  reviews: Review[];
  /** An address to block quietly, and why. */
  block: { target: string; why: string } | null;
};

const HOUR = 3_600_000;
const HALF_LIFE_MS = 6 * HOUR;
/** Score at which an address is blocked without anyone being told. */
export const BLOCK_SCORE = 60;
const WINDOW_MS = 10 * 60_000;
const MAX_VISITORS = 20_000;

type Visitor = {
  first: number;
  last: number;
  score: number;
  scoreAt: number;
  requests: number;
  notFound: number;
  refused: number;
  refusedRecent: number[];
  paths: Set<string>;
  hours: Set<number>;
  probeKinds: Set<string>;
  /** Shares (server and first path segment) where it was refused. */
  refusedAt: Map<string, number>;
  /** Paths of its own that were answered with a real page. */
  served: number;
  blockedAt: number;
  reviewed: Set<string>;
  recent: string[];
  standing: Standing | null;
  noted: Set<string>;
};

/** Answers that mean "no": not found, refused, gone, bad request, rate limited. */
const REFUSALS = new Set([400, 401, 403, 404, 405, 410, 429]);
const answered = (status: number) => status >= 200 && status < 400 && !REFUSALS.has(status);

export function subnetOf(ip: string): string {
  if (ip.includes(":")) {
    const groups = ip.split(":");
    return `${groups.slice(0, 4).join(":")}::/64`;
  }
  return `${ip.split(".").slice(0, 3).join(".")}.0/24`;
}

/** The first segment of a path, which is where one share or site begins. */
const areaOf = (server: string, path: string) => `${server}/${path.split("/")[1] ?? ""}`;

type Bucket = { start: number; count: number; ips: Set<string> };

export class Inbound {
  private visitors = new Map<string, Visitor>();
  /** Paths that ordinary visitors were served: what "exists here" means. */
  private real = new Set<string>();
  private groups = new Map<string, Bucket>();
  private reviewedGroups = new Map<string, number>();
  /** Requests per ten minutes, by hour of day, as a slow average. */
  private baseline: number[];
  private current: Bucket = { start: 0, count: 0, ips: new Set() };

  constructor(
    private readonly standingOf: (ip: string) => Standing,
    baseline?: number[],
  ) {
    this.baseline = baseline?.length === 24 ? [...baseline] : new Array(24).fill(0);
  }

  /** The learned baseline, to keep between runs. */
  baselineByHour(): number[] {
    return [...this.baseline];
  }

  private visitor(ip: string, at: number): Visitor {
    let v = this.visitors.get(ip);
    if (!v) {
      if (this.visitors.size >= MAX_VISITORS) {
        // Forget whoever has been quiet longest.
        let oldest = "";
        let oldestAt = Number.POSITIVE_INFINITY;
        for (const [key, value] of this.visitors) {
          if (value.last < oldestAt) {
            oldest = key;
            oldestAt = value.last;
          }
        }
        this.visitors.delete(oldest);
      }
      v = {
        first: at,
        last: at,
        score: 0,
        scoreAt: at,
        requests: 0,
        notFound: 0,
        refused: 0,
        refusedRecent: [],
        paths: new Set(),
        hours: new Set(),
        probeKinds: new Set(),
        refusedAt: new Map(),
        served: 0,
        blockedAt: 0,
        reviewed: new Set(),
        recent: [],
        standing: null,
        noted: new Set(),
      };
      this.visitors.set(ip, v);
    }
    return v;
  }

  /** The score of an address now, faded since it was last added to. */
  scoreOf(ip: string, at: number): number {
    const v = this.visitors.get(ip);
    return v ? v.score * 0.5 ** ((at - v.scoreAt) / HALF_LIFE_MS) : 0;
  }

  private add(v: Visitor, points: number, at: number): void {
    v.score = v.score * 0.5 ** ((at - v.scoreAt) / HALF_LIFE_MS) + points;
    v.scoreAt = at;
  }

  /** Add points for something that only counts once per address. */
  private once(v: Visitor, what: string, points: number, at: number): void {
    if (v.noted.has(what)) return;
    v.noted.add(what);
    this.add(v, points, at);
  }

  private describe(ip: string, v: Visitor, at: number): string {
    const s = v.standing;
    return [
      `Visitor: ${ip}`,
      `Network: ${s?.org || "unknown"} (${s?.network ?? "unknown"})${s && s.listed.length > 0 ? `; on ${s.listed.join(", ")}` : ""}`,
      `Seen: first ${Math.round((at - v.first) / 60_000)} minutes ago, active in ${v.hours.size} separate hours`,
      `Requests: ${v.requests}, to ${v.paths.size} different paths; ${v.notFound} not found, ${v.refused} refused, ${v.served} answered with a page`,
      `Probe kinds matched: ${[...v.probeKinds].join(", ") || "none"}`,
      `Score: ${Math.round(this.scoreOf(ip, at))}${v.blockedAt ? "; was blocked and came back" : ""}`,
      "",
      "Its latest requests, oldest first (method path -> status):",
      ...v.recent.map((r) => `  ${r}`),
    ].join("\n");
  }

  /** Take one request into account. */
  observe(hit: Hit): Outcome {
    const at = hit.at;
    const v = this.visitor(hit.ip, at);
    v.standing ??= this.standingOf(hit.ip);
    v.last = at;
    v.requests++;
    v.hours.add(Math.floor(at / HOUR));
    if (v.paths.size < 300) v.paths.add(hit.path);
    v.recent.push(
      `${hit.method} ${hit.path} -> ${hit.status}${hit.probes.length > 0 ? ` [${hit.probes.join(",")}]` : ""}`,
    );
    if (v.recent.length > 30) v.recent.shift();

    const reviews: Review[] = [];
    const review = (reason: ReviewReason, why: string, once = reason as string) => {
      if (v.reviewed.has(once)) return;
      v.reviewed.add(once);
      reviews.push({ reason, subject: hit.ip, why, record: this.describe(hit.ip, v, at) });
    };

    // --- what it is ------------------------------------------------------------
    const standing = v.standing;
    if (standing.listed.length > 0) this.once(v, "listed", 25, at);
    if (standing.network === "hosting") this.once(v, "hosting", 3, at);
    if (standing.network === "tor") this.once(v, "tor", 10, at);
    if (hit.client.startsWith("scanner")) this.once(v, "scanner-ua", 10, at);

    // --- what it did -------------------------------------------------------------
    if (hit.blocked) {
      if (!v.blockedAt) v.blockedAt = at;
      review("persistent", "it was blocked and is still trying", "back-after-block");
      this.add(v, 2, at);
    }
    for (const kind of hit.probes) {
      this.add(v, v.probeKinds.has(kind) ? 6 : 15, at);
      v.probeKinds.add(kind);
    }
    if (hit.status === 404) {
      v.notFound++;
      this.add(v, 1, at);
    }
    const area = areaOf(hit.server, hit.path);
    if (hit.status === 401 || hit.status === 403) {
      v.refused++;
      v.refusedAt.set(area, (v.refusedAt.get(area) ?? 0) + 1);
      v.refusedRecent = [...v.refusedRecent.filter((t) => at - t < WINDOW_MS), at];
      this.add(v, 4, at);
      if (v.refusedRecent.length >= 8) {
        review("brute-force", `${v.refusedRecent.length} refusals in ten minutes on ${area}`);
      }
      if (v.refusedAt.size >= 2 && v.refused >= 6) {
        review(
          "persistent",
          `it has been refused at ${v.refusedAt.size} different shares`,
          "many-shares",
        );
      }
    }
    if (answered(hit.status)) {
      v.served++;
      if (hit.probes.length > 0) {
        review(
          "got-through",
          `a request matching ${hit.probes.join(", ")} was answered ${hit.status} at ${hit.path}`,
          `got-through:${hit.path}`,
        );
      } else if ((v.refusedAt.get(area) ?? 0) >= 3) {
        review(
          "key-guessed",
          `after ${v.refusedAt.get(area)} refusals at ${area}, a request there was accepted`,
          `key:${area}`,
        );
      } else if (v.probeKinds.size === 0 && v.refused === 0 && this.real.size < 5_000) {
        // An ordinary visitor being served is what tells us a path is real.
        this.real.add(`${hit.server} ${hit.path}`);
      }
    }
    if (hit.probes.some((p) => p === "injection" || p === "traversal" || p === "probe:exploit")) {
      if (this.real.has(`${hit.server} ${hit.path}`)) {
        review(
          "aimed",
          `a ${hit.probes.join(", ")} payload was sent to ${hit.path}, a page that exists here`,
        );
      }
    }
    const score = this.scoreOf(hit.ip, at);
    if (v.hours.size >= 3 && score >= 30) {
      review(
        "persistent",
        `it has come back in ${v.hours.size} separate hours and keeps probing`,
        "across-hours",
      );
    }
    if (v.paths.size >= 40 && v.notFound >= 30) {
      review(
        "persistent",
        `it has walked ${v.paths.size} different paths looking for something`,
        "many-paths",
      );
    }

    // --- everyone together ---------------------------------------------------------
    const flood = this.together(hit, v, at);
    if (flood) reviews.push(flood);

    const block =
      score >= BLOCK_SCORE && !v.noted.has("blocked")
        ? {
            target: hit.ip,
            why: `score ${Math.round(score)}: ${[...v.probeKinds].join(", ") || "refusals and misses"}`,
          }
        : null;
    if (block) v.noted.add("blocked");
    return { reviews, block };
  }

  /** Counts by subnet, network and path, against what is normal for the hour. */
  private together(hit: Hit, v: Visitor, at: number): Review | null {
    // The whole-server count is what the baseline is learned from.
    if (at - this.current.start >= WINDOW_MS) {
      const hour = new Date(this.current.start).getUTCHours();
      if (this.current.start > 0) {
        const prior = this.baseline[hour]!;
        this.baseline[hour] =
          prior === 0 ? this.current.count : prior * 0.9 + this.current.count * 0.1;
      }
      this.current = { start: at, count: 0, ips: new Set() };
    }
    this.current.count++;
    const usual = Math.max(this.baseline[new Date(at).getUTCHours()]!, 30);

    const keys: [kind: string, key: string, limit: number][] = [
      ["subnet", subnetOf(hit.ip), Math.max(300, usual * 5)],
      ...(v.standing?.asn
        ? ([["network", `AS${v.standing.asn} ${v.standing.org}`, Math.max(600, usual * 8)]] as [
            string,
            string,
            number,
          ][])
        : []),
    ];
    for (const [kind, key, limit] of keys) {
      const id = `${kind}:${key}`;
      let bucket = this.groups.get(id);
      if (!bucket || at - bucket.start >= WINDOW_MS) {
        bucket = { start: at, count: 0, ips: new Set() };
        this.groups.set(id, bucket);
      }
      bucket.count++;
      if (bucket.ips.size < 500) bucket.ips.add(hit.ip);
      // One address over the limit is the access log's flood. Many under it is this.
      if (bucket.count >= limit && bucket.ips.size >= 5 && this.fresh(id, at)) {
        return {
          reason: "flood",
          subject: key,
          why: `${bucket.count} requests in ten minutes from ${bucket.ips.size} addresses in ${kind} ${key}, where about ${Math.round(usual)} is usual for the whole server`,
          record: `${kind}: ${key}\nRequests in ten minutes: ${bucket.count} from ${bucket.ips.size} addresses\nUsual for this hour, whole server: ${Math.round(usual)}\nLatest from one of them:\n${v.recent
            .slice(-10)
            .map((r) => `  ${r}`)
            .join("\n")}`,
        };
      }
    }

    // A link that has got out: many new addresses on one path at once.
    if (answered(hit.status) && v.requests <= 3) {
      const id = `path:${hit.server} ${hit.path}`;
      let bucket = this.groups.get(id);
      if (!bucket || at - bucket.start >= WINDOW_MS) {
        bucket = { start: at, count: 0, ips: new Set() };
        this.groups.set(id, bucket);
      }
      bucket.ips.add(hit.ip);
      if (bucket.ips.size >= 20 && this.fresh(id, at)) {
        return {
          reason: "leaked-link",
          subject: `${hit.server} ${hit.path}`,
          why: `${bucket.ips.size} addresses that had never been here opened ${hit.path} within ten minutes`,
          record: `Path: ${hit.server} ${hit.path}\nNew addresses in ten minutes: ${bucket.ips.size}\nUsual for this hour, whole server: ${Math.round(usual)} requests`,
        };
      }
    }
    if (this.groups.size > 5_000) {
      for (const [id, bucket] of this.groups) {
        if (at - bucket.start >= WINDOW_MS) this.groups.delete(id);
      }
    }
    return null;
  }

  /** True the first time in an hour that a group is reviewed. */
  private fresh(id: string, at: number): boolean {
    if (at - (this.reviewedGroups.get(id) ?? 0) < HOUR) return false;
    this.reviewedGroups.set(id, at);
    return true;
  }

  /** How many addresses are being tracked. */
  size(): number {
    return this.visitors.size;
  }
}
