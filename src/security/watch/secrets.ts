/**
 * What must never leave this machine, and how to recognise it in text.
 *
 * Three things, from most to least certain:
 *
 *  - A canary: a credential that opens nothing, planted where something
 *    looking for credentials would find it. Nothing has a reason to read
 *    one, and none to send one anywhere, so a sighting is never a false
 *    alarm about intent.
 *  - A real secret of this deployment, known by its value: every credential
 *    in config.toml and every file in the secrets folder. A pattern can only
 *    guess that a string is a key; this knows.
 *  - A string shaped like a well-known vendor's key that is neither. It may
 *    be a key the harness was never told about, or an example from a README.
 *
 * Values are held in memory only. What is reported, logged or shown to a
 * judge is the secret's name (`config:[sms].auth_token`), never the value.
 *
 * A value is also found in the common ways of carrying it somewhere without
 * it looking like itself: base64 at any byte offset, hex, and URL-encoding.
 * That is not a defence against a determined adversary, who can encrypt; it
 * is a net for the ordinary case of a command that pipes a file through
 * `base64` on its way out.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type SecretKind = "canary" | "secret";
export type SecretEntry = { name: string; value: string; kind: SecretKind };
export type SecretHit = { name: string; kind: SecretKind; encoded: boolean };

/** Shorter than this and a value turns up in ordinary text by chance. */
const MIN_SECRET_CHARS = 16;
/** A value its own name calls a password may be this short. */
const MIN_NAMED_SECRET_CHARS = 12;

/**
 * The part of `value`'s base64 that is the same wherever the value sits in a
 * longer buffer, for each of the three byte alignments. The first and last
 * characters of an encoding depend on the bytes next to the value, so they
 * are left off.
 */
function base64Cores(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const cores: string[] = [];
  for (let lead = 0; lead < 3; lead++) {
    const padded = Buffer.concat([Buffer.alloc(lead), bytes]);
    const encoded = padded.toString("base64").replace(/=+$/, "");
    const head = [0, 2, 3][lead]!;
    const rem = padded.length % 3;
    const tail = rem === 0 ? 0 : 1;
    const core = encoded.slice(head, encoded.length - tail);
    if (core.length >= MIN_NAMED_SECRET_CHARS) {
      cores.push(core, core.replace(/\+/g, "-").replace(/\//g, "_"));
    }
  }
  return cores;
}

type Needle = { text: string; entry: SecretEntry; encoded: boolean; fold: boolean };

/** Finds known secrets and canaries in text, by value. */
export class SecretScanner {
  private needles: Needle[] = [];
  /** Names only, for a count in the log. */
  readonly names: string[];

  constructor(entries: SecretEntry[]) {
    const seen = new Set<string>();
    for (const entry of entries) {
      const value = entry.value.trim();
      if (value.length < MIN_NAMED_SECRET_CHARS || seen.has(value)) continue;
      seen.add(value);
      const e = { ...entry, value };
      this.needles.push({ text: value, entry: e, encoded: false, fold: false });
      for (const core of new Set(base64Cores(value))) {
        this.needles.push({ text: core, entry: e, encoded: true, fold: false });
      }
      const hex = Buffer.from(value, "utf8").toString("hex");
      this.needles.push({ text: hex, entry: e, encoded: true, fold: true });
      const url = encodeURIComponent(value);
      if (url !== value) this.needles.push({ text: url, entry: e, encoded: true, fold: false });
    }
    this.names = [...new Set(this.needles.map((n) => n.entry.name))];
  }

  /** Every known secret or canary whose value, or an encoding of it, is in the text. */
  find(text: string): SecretHit[] {
    if (!text || this.needles.length === 0) return [];
    let lower: string | null = null;
    const hits = new Map<string, SecretHit>();
    for (const needle of this.needles) {
      let found: boolean;
      if (needle.fold) {
        if (lower === null) lower = text.toLowerCase();
        found = lower.includes(needle.text);
      } else {
        found = text.includes(needle.text);
      }
      if (!found) continue;
      const prior = hits.get(needle.entry.name);
      // Seen as itself outranks seen encoded.
      if (!prior || (prior.encoded && !needle.encoded)) {
        hits.set(needle.entry.name, {
          name: needle.entry.name,
          kind: needle.entry.kind,
          encoded: needle.encoded,
        });
      }
    }
    return [...hits.values()];
  }
}

/**
 * Formats a vendor publishes for its keys. Each is specific enough that a
 * match is a credential of that kind or a deliberate imitation of one; a
 * random share token or a commit hash matches none.
 */
const KEY_SHAPES: [vendor: string, pattern: RegExp][] = [
  ["anthropic", /\bsk-ant-[A-Za-z0-9_-]{24,}/],
  ["openrouter", /\bsk-or-v1-[A-Za-z0-9]{32,}/],
  ["openai", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
  ["aws", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["github", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/],
  ["slack", /\bxox[abprs]-[A-Za-z0-9-]{20,}/],
  ["google", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["stripe", /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}/],
  ["stripe-webhook", /\bwhsec_[0-9A-Za-z]{24,}/],
  ["twilio", /\bSK[0-9a-f]{32}\b/],
  ["huggingface", /\bhf_[A-Za-z0-9]{30,}/],
  ["private-key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/],
];

/** The vendors whose key format appears in the text; empty for ordinary text. */
export function keyShapesIn(text: string): string[] {
  if (!text) return [];
  return KEY_SHAPES.filter(([, pattern]) => pattern.test(text)).map(([vendor]) => vendor);
}

const SECRET_KEY_NAME =
  /(^|[_.-])(key|token|secret|password|passwd|pass|pwd|authorization|credential|credentials|api_key|auth_token|webhook_secret)($|[_.-])/i;
/** A section whose every value is a credential, whatever each is called: `[keys] openrouter = "…"`. */
const SECRET_SECTION = /^(keys|secrets|credentials|tokens)$/i;
/**
 * Named like a key and meant to be seen: a publishable key is in every page
 * that takes a payment, and an account or key id is in the URL of every
 * request made with it. Treating one as a secret refuses ordinary work.
 */
const NOT_SECRET_NAME = /publishable|public|(^|[_.-])(sid|id|user|username|host|url|path|mode)$/i;

/**
 * The credentials in a parsed config, by where they are. A value counts when
 * its key, or the section it is in, is named like a credential and it is
 * long enough to be one. The token after `Bearer ` is taken on its own,
 * since that is the part that travels.
 */
export function secretsInConfig(config: unknown, prefix = "", inSecrets = false): SecretEntry[] {
  const out: SecretEntry[] = [];
  if (!config || typeof config !== "object") return out;
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      if (NOT_SECRET_NAME.test(key) || (!inSecrets && !SECRET_KEY_NAME.test(key))) continue;
      const bare = value.replace(/^(?:Bearer|Basic|Token)\s+/i, "").trim();
      if (bare.length >= MIN_NAMED_SECRET_CHARS && !/\s/.test(bare)) {
        out.push({ name: `config:${path}`, value: bare, kind: "secret" });
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => out.push(...secretsInConfig(item, `${path}[${i}]`, inSecrets)));
    } else if (value && typeof value === "object") {
      out.push(...secretsInConfig(value, path, inSecrets || SECRET_SECTION.test(key)));
    }
  }
  return out;
}

/** Larger than this is a database or a key store, not a token to match by value. */
const MAX_SECRET_FILE_BYTES = 8 * 1024;

/**
 * The tokens kept as files, one folder deep (a signing key lives in a folder
 * of its own): each file's text, read as `secretsInText` reads it. `skip`
 * names files that are canaries and are listed separately.
 */
export function secretsInFolder(
  dir: string,
  skip: Set<string> = new Set(),
  label = "secrets",
  depth = 0,
): SecretEntry[] {
  const out: SecretEntry[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const path = join(dir, name);
    if (skip.has(path)) continue;
    try {
      const stat = statSync(path);
      if (stat.isDirectory()) {
        if (depth < 1) out.push(...secretsInFolder(path, skip, `${label}/${name}`, depth + 1));
        continue;
      }
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SECRET_FILE_BYTES) continue;
      const text = readFileSync(path, "utf8");
      if (text.includes("\u0000")) continue;
      out.push(...secretsInText(`file:${label}/${name}`, text, "secret"));
    } catch {
      // Unreadable is not ours to scan for.
    }
  }
  return out;
}

/**
 * The credentials in a small text file. A line that is all one token is a
 * token. A `NAME=value` line counts when the name says it is a credential,
 * or when the file is a canary, where every value was planted to be found:
 * an environment file also holds host names, places and account ids, and
 * calling those secrets would refuse any message that mentions one.
 */
export function secretsInText(name: string, text: string, kind: SecretKind): SecretEntry[] {
  const out: SecretEntry[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !/^\[.*\]$/.test(l));
  for (const line of lines) {
    // A base64 token ends in `=` too: `NAME=value` needs a name of sane
    // length and something after the sign that is not just padding.
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]{0,63})\s*=\s*(.+)$/.exec(line);
    const pair = match && !/^=*$/.test(match[2]!) ? match : null;
    const value = (pair ? pair[2]! : line).trim().replace(/^["']|["']$/g, "");
    if (/\s/.test(value)) continue;
    if (pair) {
      const named = SECRET_KEY_NAME.test(pair[1]!) && !NOT_SECRET_NAME.test(pair[1]!);
      if (kind !== "canary" && !named) continue;
      if (value.length >= MIN_NAMED_SECRET_CHARS) out.push({ name, value, kind });
    } else if (value.length >= MIN_SECRET_CHARS) {
      out.push({ name, value, kind });
    }
  }
  return out;
}
