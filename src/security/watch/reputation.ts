/**
 * What is publicly known about an address, kept on this machine.
 *
 * The lists are downloaded whole, once a day, and every lookup is answered
 * from the copies here. A visitor's address is never sent anywhere to ask
 * about it.
 *
 *  - Spamhaus DROP: networks run by, or wholly leased to, criminals.
 *  - FireHOL level 1: a combined list of networks that only attack.
 *  - The Tor exit list.
 *  - An address-to-network table (iptoasn.com): which organisation announces
 *    an address, from which a home or mobile provider is told from a cloud
 *    or hosting company. A probe from a hosting network is a machine; a
 *    visitor from a home provider is usually a person.
 *
 * IPv4 only. An IPv6 visitor is judged on what it does.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { atomicWriteFileSync } from "../../util/atomic-write.ts";

type NetworkKind = "hosting" | "provider" | "tor" | "unknown";
export type Standing = {
  /** The lists the address is on. */
  listed: string[];
  asn: number | null;
  org: string;
  network: NetworkKind;
};

const REPUTATION_SOURCES = [
  {
    name: "spamhaus-drop",
    file: "spamhaus-drop.txt",
    url: "https://www.spamhaus.org/drop/drop.txt",
  },
  {
    name: "firehol-level1",
    file: "firehol-level1.netset",
    url: "https://raw.githubusercontent.com/firehol/blocklist-ipsets/master/firehol_level1.netset",
  },
  { name: "tor-exit", file: "tor-exits.txt", url: "https://check.torproject.org/torbulkexitlist" },
  { name: "asn", file: "ip2asn-v4.tsv.gz", url: "https://iptoasn.com/data/ip2asn-v4.tsv.gz" },
] as const;

/** An IPv4 address as a number, or null for anything else. */
export function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

/** Ranges that are never a visitor from outside: private, loopback, link-local, reserved. */
const NOT_PUBLIC: [number, number][] = (
  [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 3],
  ] as const
).map(([base, bits]) => {
  const start = ipv4ToInt(base)!;
  return [start, (start + 2 ** (32 - bits) - 1) >>> 0];
});

type Ranges = { starts: Uint32Array; ends: Uint32Array };

/** Parse a list of addresses and CIDR blocks, one a line, into sorted ranges. Comments are skipped. */
export function parseNetset(text: string): Ranges {
  const found: [number, number][] = [];
  for (const raw of text.split("\n")) {
    const line = raw.split(/[;#]/)[0]!.trim();
    if (!line) continue;
    const [base, bitsText] = line.split("/");
    const start = ipv4ToInt(base ?? "");
    if (start === null) continue;
    const bits = bitsText === undefined ? 32 : Number(bitsText);
    if (!Number.isInteger(bits) || bits < 8 || bits > 32) continue;
    const end = (start + 2 ** (32 - bits) - 1) >>> 0;
    // A blocklist of attackers also lists the private ranges, as "never route these".
    if (NOT_PUBLIC.some(([s, e]) => start >= s && end <= e)) continue;
    found.push([start, end]);
  }
  found.sort((a, b) => a[0] - b[0]);
  return {
    starts: Uint32Array.from(found.map((r) => r[0])),
    ends: Uint32Array.from(found.map((r) => r[1])),
  };
}

function inRanges(ranges: Ranges, ip: number): number {
  let lo = 0;
  let hi = ranges.starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ip < ranges.starts[mid]!) hi = mid - 1;
    else if (ip > ranges.ends[mid]!) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Names that sell machines by the hour. A match is a server, not somebody's phone. */
const HOSTING =
  /amazon|aws|google|microsoft|azure|digitalocean|linode|akamai|ovh|hetzner|vultr|choopa|oracle|alibaba|tencent|contabo|leaseweb|m247|datacamp|cloudflare|fastly|scaleway|hostinger|ionos|godaddy|rackspace|equinix|colocrossing|psychz|quadranet|servers?\b|hosting|host\b|cloud|vps|datacenter|data center|colo\b|dedicated/i;

type AsnTable = Ranges & { asns: Uint32Array; names: Map<number, string> };

/** Parse the address-to-network table: start, end, network number, country, name. */
export function parseAsnTable(tsv: string): AsnTable {
  const starts: number[] = [];
  const ends: number[] = [];
  const asns: number[] = [];
  const names = new Map<number, string>();
  for (const line of tsv.split("\n")) {
    const [a, b, asnText, , name] = line.split("\t");
    const start = ipv4ToInt(a ?? "");
    const end = ipv4ToInt(b ?? "");
    const asn = Number(asnText);
    // Network 0 is "not announced by anyone".
    if (start === null || end === null || !asn) continue;
    starts.push(start);
    ends.push(end);
    asns.push(asn);
    if (name && !names.has(asn)) names.set(asn, name.trim());
  }
  return {
    starts: Uint32Array.from(starts),
    ends: Uint32Array.from(ends),
    asns: Uint32Array.from(asns),
    names,
  };
}

export class Reputation {
  private lists: [name: string, ranges: Ranges][] = [];
  private tor: Ranges = { starts: new Uint32Array(), ends: new Uint32Array() };
  private asn: AsnTable | null = null;
  /** What was loaded, for the log. */
  readonly loaded: Record<string, number> = {};

  constructor(private readonly dir: string) {
    this.reload();
  }

  /** Read whatever lists are in the folder. A missing list is simply not consulted. */
  reload(): void {
    this.lists = [];
    for (const source of REPUTATION_SOURCES) {
      const path = join(this.dir, source.file);
      if (!existsSync(path)) continue;
      try {
        if (source.name === "asn") {
          this.asn = parseAsnTable(gunzipSync(readFileSync(path)).toString("utf8"));
          this.loaded.asn = this.asn.starts.length;
        } else {
          const ranges = parseNetset(readFileSync(path, "utf8"));
          this.loaded[source.name] = ranges.starts.length;
          if (source.name === "tor-exit") this.tor = ranges;
          else this.lists.push([source.name, ranges]);
        }
      } catch {
        // A list that does not read is not consulted; the next download replaces it.
      }
    }
  }

  lookup(ip: string): Standing {
    const n = ipv4ToInt(ip);
    const none: Standing = { listed: [], asn: null, org: "", network: "unknown" };
    if (n === null || NOT_PUBLIC.some(([s, e]) => n >= s && n <= e)) return none;
    const listed = this.lists
      .filter(([, ranges]) => inRanges(ranges, n) >= 0)
      .map(([name]) => name);
    const tor = inRanges(this.tor, n) >= 0;
    let asn: number | null = null;
    let org = "";
    if (this.asn) {
      const at = inRanges(this.asn, n);
      if (at >= 0) {
        asn = this.asn.asns[at]!;
        org = this.asn.names.get(asn) ?? "";
      }
    }
    const network: NetworkKind = tor
      ? "tor"
      : org
        ? HOSTING.test(org)
          ? "hosting"
          : "provider"
        : "unknown";
    return { listed: tor ? [...listed, "tor-exit"] : listed, asn, org, network };
  }
}

/** Lists older than this are fetched again. */
const REFRESH_MS = 24 * 3_600_000;

/**
 * Download every list that is missing or more than a day old. Returns the
 * names that were replaced. A download that fails leaves the old copy.
 */
export async function refreshReputation(
  dir: string,
  fetcher: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<string[]> {
  const replaced: string[] = [];
  for (const source of REPUTATION_SOURCES) {
    const path = join(dir, source.file);
    try {
      if (existsSync(path) && now - statSync(path).mtimeMs < REFRESH_MS) continue;
      const res = await fetcher(source.url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) continue;
      const body = Buffer.from(await res.arrayBuffer());
      // An error page is not a list.
      if (body.length < 200) continue;
      atomicWriteFileSync(path, body);
      replaced.push(source.name);
    } catch {
      // Tomorrow.
    }
  }
  return replaced;
}
