/**
 * `edmund logs traffic [--since 24h] [--json]`
 *
 * Who has been at the door: every request the harness's servers answered,
 * summed by where it was sent, where it came from and what sent it; the
 * clients that scanned, flooded or were refused over and over; the hours
 * that stand out; and what on this machine is reachable from outside.
 */
import { resolve } from "node:path";
import type { ChannelRecord } from "../../src/util/log-files.ts";
import { readChannel } from "../../src/util/log-files.ts";
import { type Self, isSelf, readSelf } from "../../src/watch/inbound-watch.ts";
import type { Parsed } from "../args.ts";
import { getString, hasFlag } from "../args.ts";
import { LOGS_DIR, REPO } from "../services/paths.ts";
import { color, fail, info, print, table } from "../ui.ts";
import { parseSpan } from "./log-channels.ts";

type Tally = Map<string, number>;
const bump = (t: Tally, key: string, by = 1) => t.set(key, (t.get(key) ?? 0) + by);
const top = (t: Tally, n: number): [string, number][] =>
  [...t].sort((a, b) => b[1] - a[1]).slice(0, n);

export type TrafficSummary = {
  requests: number;
  fromOutside: number;
  /** Requests that came in through a tunnel from this machine's own public address. */
  fromSelf: number;
  byServer: [string, number][];
  byHost: [string, number][];
  byClientKind: [string, number][];
  byCountry: [string, number][];
  byStatus: [string, number][];
  probes: [string, number][];
  clients: {
    client: string;
    requests: number;
    refused: number;
    probes: number;
    country: string;
    kind: string;
  }[];
  events: { at: string; kind: string; what: string }[];
  newClients: number;
  /** Hours (UTC) whose requests from outside stand far above the rest. */
  outlierHours: { hour: string; requests: number; typical: number }[];
  exposure: { tunnels: string[]; listeners: string[]; changes: string[] } | null;
};

/** Sum a period's `net-in` and `security` records. A counted repeat stands for the requests it counted. */
export function summarizeTraffic(
  netIn: ChannelRecord[],
  security: ChannelRecord[],
  self: Self = { v4: [], v6: [] },
): TrafficSummary {
  const byServer: Tally = new Map();
  const byHost: Tally = new Map();
  const byKind: Tally = new Map();
  const byCountry: Tally = new Map();
  const byStatus: Tally = new Map();
  const probes: Tally = new Map();
  const hours: Tally = new Map();
  const clients = new Map<string, TrafficSummary["clients"][number]>();
  let requests = 0;
  let fromOutside = 0;
  let fromSelf = 0;
  for (const r of netIn) {
    const f = r.fields ?? {};
    const n = typeof f.count === "number" ? f.count : 1;
    requests += n;
    bump(byServer, String(f.server ?? "?"), n);
    bump(byStatus, `${String(f.status ?? "?")[0]}xx`, n);
    const client = (f.via as string | undefined) ?? null;
    if (!client) continue;
    // The operator opening their own pages from home arrives through the
    // tunnel like anyone else. It is counted, and it is not a visitor.
    if (isSelf(self, client)) {
      fromSelf += n;
      continue;
    }
    fromOutside += n;
    if (f.host) bump(byHost, String(f.host), n);
    const kind = String(f.client ?? "unknown").split(":")[0]!;
    bump(byKind, kind, n);
    if (f.country) bump(byCountry, String(f.country), n);
    bump(hours, r.ts.slice(0, 13), n);
    const c = clients.get(client) ?? {
      client,
      requests: 0,
      refused: 0,
      probes: 0,
      country: String(f.country ?? ""),
      kind,
    };
    c.requests += n;
    const status = Number(f.status);
    if (status === 401 || status === 403 || status === 404 || status === 429) c.refused += n;
    if (Array.isArray(f.probes)) {
      c.probes += n;
      for (const p of f.probes) bump(probes, String(p), n);
    }
    clients.set(client, c);
  }

  const events: TrafficSummary["events"] = [];
  let newClients = 0;
  let inventory: ChannelRecord | null = null;
  const changes: string[] = [];
  for (const r of security) {
    const kind = String(r.fields?.kind ?? "");
    if (r.tag === "inbound" && ["scan", "flood", "brute-force"].includes(kind)) {
      events.push({ at: r.ts, kind, what: r.msg });
    } else if (r.tag === "inbound" && kind === "new-client") newClients++;
    else if (r.tag === "exposure" && kind === "inventory") {
      inventory = r;
      changes.length = 0;
    } else if (r.tag === "exposure" && (kind === "opened" || kind === "closed")) {
      changes.push(`${r.ts.slice(0, 16)}Z ${r.msg}`);
    }
  }

  // An hour stands out when it is several times a typical busy hour, and busy in its own right.
  const counts = [...hours.values()].sort((a, b) => a - b);
  const typical = counts.length ? counts[Math.floor(counts.length / 2)]! : 0;
  const outlierHours = [...hours]
    .filter(([, n]) => n >= 50 && n > 4 * Math.max(typical, 1))
    .map(([hour, n]) => ({ hour: `${hour}:00Z`, requests: n, typical }))
    .sort((a, b) => b.requests - a.requests);

  const inv = inventory?.fields as
    | {
        tunnels?: { kind: string; target: string }[];
        listeners?: { command: string; port: number }[];
      }
    | undefined;
  return {
    requests,
    fromOutside,
    fromSelf,
    byServer: top(byServer, 10),
    byHost: top(byHost, 10),
    byClientKind: top(byKind, 6),
    byCountry: top(byCountry, 8),
    byStatus: top(byStatus, 5),
    probes: top(probes, 10),
    clients: [...clients.values()]
      .sort((a, b) => b.probes - a.probes || b.requests - a.requests)
      .slice(0, 12),
    events,
    newClients,
    outlierHours,
    exposure: inv
      ? {
          tunnels: (inv.tunnels ?? []).map((t) => `${t.kind} to ${t.target}`),
          listeners: (inv.listeners ?? []).map((l) => `${l.command} on port ${l.port}`),
          changes,
        }
      : null,
  };
}

export function trafficCommand(p: Parsed): void {
  const sinceText = getString(p, "since") ?? "24h";
  const span = parseSpan(sinceText);
  if (span === null) {
    fail(`--since takes a span such as 6h, 24h or 7d, not "${sinceText}"`);
    process.exit(1);
  }
  const since = Date.now() - span;
  const summary = summarizeTraffic(
    readChannel(LOGS_DIR, "net-in", since),
    // The inventory is written once a day: look back far enough to find the last one.
    readChannel(LOGS_DIR, "security", Math.min(since, Date.now() - 26 * 3_600_000)).filter(
      (r) => r.tag === "exposure" || Date.parse(r.ts) >= since,
    ),
    readSelf(process.env.EDMUND_DATA_DIR ?? resolve(REPO, "data")),
  );
  if (hasFlag(p, "json")) {
    print(JSON.stringify(summary, null, 2));
    return;
  }
  const list = (pairs: [string, number][]) =>
    pairs.map(([k, n]) => `${k} ${n}`).join(", ") || "none";
  const own = summary.fromSelf > 0 ? `, ${summary.fromSelf} from this machine's own address` : "";
  print(
    color.bold(
      `Last ${sinceText}: ${summary.requests} requests answered, ${summary.fromOutside} from outside${own}`,
    ),
  );
  print(`by server     ${list(summary.byServer)}`);
  print(`by status     ${list(summary.byStatus)}`);
  if (summary.fromOutside > 0) {
    print(`sent to       ${list(summary.byHost)}`);
    print(`sent by       ${list(summary.byClientKind)}`);
    print(`from          ${list(summary.byCountry)}`);
    print(`new today     ${summary.newClients} clients not seen earlier in the day`);
  }
  print();
  if (summary.events.length > 0) {
    print(color.bold(color.red(`Flagged: ${summary.events.length}`)));
    for (const e of summary.events.slice(-15)) print(`  ${e.at.slice(0, 16)}Z  ${e.what}`);
  } else {
    print(color.bold("Flagged: nothing scanned, flooded or was refused repeatedly"));
  }
  if (summary.probes.length > 0) print(`probes        ${list(summary.probes)}`);
  if (summary.outlierHours.length > 0) {
    print();
    print(color.bold("Hours that stand out"));
    for (const h of summary.outlierHours.slice(0, 6)) {
      print(`  ${h.hour}  ${h.requests} requests from outside (a typical busy hour: ${h.typical})`);
    }
  }
  if (summary.clients.length > 0) {
    print();
    print(color.bold("Clients from outside"));
    table(
      ["client", "from", "kind", "requests", "refused or missing", "probes"],
      summary.clients.map((c) => [
        c.client,
        c.country || "-",
        c.kind,
        String(c.requests),
        String(c.refused),
        String(c.probes),
      ]),
    );
  }
  print();
  if (summary.exposure) {
    print(color.bold("Reachable from outside this machine"));
    for (const t of summary.exposure.tunnels) print(`  tunnel    ${t}`);
    for (const l of summary.exposure.listeners) print(`  listener  ${l}`);
    for (const c of summary.exposure.changes.slice(-8)) print(color.yellow(`  ${c}`));
  } else {
    info("no exposure inventory on record yet (the daemon writes one at start and once a day)");
  }
}
