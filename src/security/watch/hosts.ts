/**
 * Which hosts a piece of text reaches for, and which of them this machine
 * has dealt with before.
 *
 * A command line or a URL names where it is going. That is read here, from
 * the text, because nothing below root on macOS can watch a process's
 * connections as they are made. It sees what a command says, not what a
 * script it runs does; the scripts a turn writes are read the same way when
 * they are written.
 *
 * "Known" is kept per site (`github.com` covers `api.github.com`), except on
 * the services where anyone can have a name: a page on `github.io`, a tunnel
 * on `trycloudflare.com`, a bucket, a paste. There every full name is its
 * own stranger, and those are also the places data is usually dropped.
 */
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../../util/atomic-write.ts";

/** Where anyone can get a hostname or a path of their own. */
const SHARED_SUFFIXES = [
  "github.io",
  "githubusercontent.com",
  "gitlab.io",
  "pages.dev",
  "workers.dev",
  "trycloudflare.com",
  "ngrok.io",
  "ngrok-free.app",
  "ngrok.app",
  "loca.lt",
  "serveo.net",
  "herokuapp.com",
  "vercel.app",
  "netlify.app",
  "onrender.com",
  "fly.dev",
  "glitch.me",
  "repl.co",
  "replit.dev",
  "web.app",
  "firebaseapp.com",
  "appspot.com",
  "run.app",
  "amazonaws.com",
  "cloudfront.net",
  "blob.core.windows.net",
  "azurewebsites.net",
  "digitaloceanspaces.com",
  "r2.dev",
  "supabase.co",
  "pipedream.net",
  "webhook.site",
  "requestcatcher.com",
  "requestbin.com",
  "beeceptor.com",
  "interact.sh",
  "oast.fun",
  "burpcollaborator.net",
];

/** Places whose whole purpose is to take what is sent to them and show it to someone else. */
const DROP_SITES = [
  "pastebin.com",
  "paste.ee",
  "hastebin.com",
  "dpaste.com",
  "ix.io",
  "0x0.st",
  "transfer.sh",
  "file.io",
  "termbin.com",
  "webhook.site",
  "requestcatcher.com",
  "requestbin.com",
  "beeceptor.com",
  "pipedream.net",
  "interact.sh",
  "oast.fun",
  "burpcollaborator.net",
  "ngrok.io",
  "ngrok-free.app",
  "ngrok.app",
  "trycloudflare.com",
  "loca.lt",
  "serveo.net",
];

const TWO_PART_TLDS = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "co.kr",
  "com.br",
  "com.mx",
  "com.cn",
  "co.in",
  "co.za",
]);

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** True for this machine and its own network: never a place data "leaves" to. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  // The endings reserved for examples and tests resolve nowhere (RFC 2606,
  // RFC 6761). `example.com` is not one of them: it is a real host that answers.
  if (/(?:^|\.)(?:example|invalid|test)$/.test(h)) return true;
  // IPv6: loopback, link-local, and the private range fc00::/7.
  if (h.includes(":")) return h === "::1" || h.startsWith("fe80:") || /^f[cd][0-9a-f]{2}:/.test(h);
  const m = IPV4.exec(h);
  // A bare name with no dot is a machine on this network.
  if (!m) return !h.includes(".");
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** The name a host is known by: its site, or the full name where sites are shared out. */
export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (IPV4.test(h) || h.includes(":")) return h;
  if (SHARED_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`))) return h;
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const lastTwo = parts.slice(-2).join(".");
  return TWO_PART_TLDS.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

/** True where the host exists to receive data and hand it to whoever asked. */
export function isDropSite(host: string): boolean {
  const h = host.toLowerCase();
  return DROP_SITES.some((s) => h === s || h.endsWith(`.${s}`));
}

const URL_RE =
  /\b(?:https?|wss?|ftp|sftp|ssh|git):\/\/(?:[^\s/@"'`<>]+@)?(\[[0-9a-f:]+\]|[a-z0-9.-]+)/gi;
/** `user@host:path` and `user@host` as ssh, scp, rsync and git write them. */
const USER_AT_HOST_RE =
  /(?:^|[\s"'=])[a-z_][a-z0-9._-]*@([a-z0-9][a-z0-9.-]*\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?=[:\s"']|$)/gi;
/** `nc host port`, `telnet host port`, `ssh host`, and curl's `--connect-to`/`--resolve`. */
const BARE_HOST_RE =
  /(?:^|[\s;&|(])(?:nc|ncat|netcat|telnet|socat|ssh|sftp|ftp|ping|dig|nslookup|host)\s+(?:-[A-Za-z0-9]+\s+(?:\d+\s+)?)*([a-z0-9][a-z0-9.-]*\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})\b/gi;

function cleanHost(raw: string): string | null {
  const h = raw
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (!h || h.length > 253) return null;
  // A version number or a file name is not a host.
  if (!h.includes(":") && !IPV4.test(h) && !/[a-z]/.test(h.split(".").pop() ?? "")) return null;
  return h;
}

/**
 * Every host the text names as somewhere to connect to, in order, once each.
 * `urlsOnly` is for text that is not a command, such as a file being
 * written: an address in a URL is somewhere to go, while `name@domain` in a
 * letter is only somebody's email.
 */
export function hostsIn(text: string, urlsOnly = false): string[] {
  if (!text) return [];
  const out: string[] = [];
  const add = (raw: string | undefined) => {
    const h = raw ? cleanHost(raw) : null;
    if (h && !out.includes(h)) out.push(h);
  };
  for (const m of text.matchAll(URL_RE)) add(m[1]);
  if (urlsOnly) return out;
  for (const m of text.matchAll(USER_AT_HOST_RE)) add(m[1]);
  for (const m of text.matchAll(BARE_HOST_RE)) add(m[1]);
  return out;
}

type Seen = { first: number; last: number; count: number };

/**
 * The sites this machine has reached before. Kept as a small file, written
 * back at most every few seconds; a crash loses a few sightings, which only
 * means a host is called new once more.
 */
export class KnownHosts {
  private sites = new Map<string, Seen>();
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly file: string | null) {
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, Seen>;
      for (const [site, seen] of Object.entries(raw)) {
        if (seen && typeof seen.first === "number") this.sites.set(site, seen);
      }
    } catch {
      // A file that does not parse is started again; every host is new once.
    }
  }

  get size(): number {
    return this.sites.size;
  }

  /** True when the host is local, or its site has been reached before. */
  has(host: string): boolean {
    return isLocalHost(host) || this.sites.has(siteOf(host));
  }

  /** Record a sighting. Returns true when this was the first. */
  note(host: string, at: number = Date.now()): boolean {
    if (isLocalHost(host)) return false;
    const site = siteOf(host);
    const seen = this.sites.get(site);
    if (seen) {
      seen.last = at;
      seen.count++;
    } else {
      this.sites.set(site, { first: at, last: at, count: 1 });
    }
    this.dirty = true;
    if (this.file && !this.timer) {
      this.timer = setTimeout(() => this.flush(), 5_000);
      this.timer.unref?.();
    }
    return !seen;
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    try {
      atomicWriteFileSync(this.file, `${JSON.stringify(Object.fromEntries(this.sites))}\n`);
    } catch {
      this.dirty = true;
    }
  }
}
