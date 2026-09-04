/**
 * Read/write config.toml for the dashboard.
 *
 * Read: parse with smol-toml, run through ConfigSchema, mask every secret
 * (see maskSecrets) so credentials never leave the server.
 * Write: validate the merged object, stringify with smol-toml, write atomically
 * via a temp file + rename, keeping a timestamped backup for each save.
 *
 * Inline comments inside TOML are lost on save — smol-toml has no
 * comment-preserving round-trip. A leading comment block (everything before
 * the first `[section]` in the file) is preserved.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { ConfigSchema } from "../../../src/config/config.ts";

const CONFIG_PATH = resolve(import.meta.dir, "../../../config.toml");

/**
 * Which values never leave the server. A denylist of five key names used to
 * live here and silently missed every secret added after it (OpenRouter,
 * Stripe, the mirror token, MCP headers). The rule is now structural: any
 * key whose name looks like a credential, at any depth, and every value
 * inside a table that exists to hold credentials.
 */
const SECRET_KEY_RE =
  /(^|_)(key|token|secret|password|passwd|pin_hash|authorization|api_key)($|_)/i;
const SECRET_TABLES = new Set(["keys", "mcp_headers", "headers"]);
/** Names the regex would catch that are identifiers, not credentials. */
const NOT_SECRET = new Set(["session_key", "config_key", "index_db", "installed_db", "consent_db"]);

export type MaskedConfig = Record<string, unknown>;

export function isSecretKey(name: string): boolean {
  if (NOT_SECRET.has(name)) return false;
  return SECRET_KEY_RE.test(name);
}

/**
 * Return a copy of `value` with every secret string replaced by its mask.
 * Exported for tests; the read path below is the only production caller.
 */
export function maskSecrets(value: unknown, keyName = "", inSecretTable = false): unknown {
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, keyName, inSecretTable));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskSecrets(v, k, inSecretTable || SECRET_TABLES.has(k));
    }
    return out;
  }
  if (typeof value === "string" && (inSecretTable || isSecretKey(keyName))) {
    return value ? maskSecret(value) : "";
  }
  return value;
}

export function readConfigRaw(): Record<string, unknown> {
  const raw = readFileSync(CONFIG_PATH, "utf8");
  return parseToml(raw) as Record<string, unknown>;
}

export function readConfigMasked(): MaskedConfig {
  const parsed = readConfigRaw();
  // Round-trip through zod to fill defaults and reject malformed state.
  const validated = ConfigSchema.parse(parsed) as Record<string, unknown>;
  const masked = maskSecrets(validated) as Record<string, unknown>;
  // pin_hash is a hash, not a secret with a useful tail: never show any of it.
  const dash = (masked.dashboard ?? {}) as Record<string, unknown>;
  const rawDash = (validated.dashboard ?? {}) as Record<string, unknown>;
  masked.dashboard = { ...dash, pin_hash: rawDash.pin_hash ? "•••" : "" };
  return masked;
}

function maskSecret(v: string): string {
  if (!v) return "";
  const last = v.slice(-4);
  return `•••${last}`;
}

/**
 * Merge top-level + secret updates into the file and persist atomically.
 *
 * `next`: full config object (as received from the client). Any secret whose
 * value starts with "•••" is treated as "unchanged" and replaced with the
 * current on-disk value — the UI never learns the secret, so it can't echo
 * it back, so we have to reconstruct it here.
 */
export async function writeConfig(next: Record<string, unknown>): Promise<{ backupPath: string }> {
  const current = readConfigRaw();
  const merged = deepMergeWithSecrets(current, next);
  // Preserve any externally-set pin_hash if the client sent "•••".
  const mergedDash = (merged.dashboard ?? {}) as Record<string, unknown>;
  const currentDash = (current.dashboard ?? {}) as Record<string, unknown>;
  if (typeof mergedDash.pin_hash === "string" && mergedDash.pin_hash.startsWith("•")) {
    mergedDash.pin_hash = currentDash.pin_hash ?? "";
  }
  merged.dashboard = mergedDash;

  // Validate — throws on bad values; caller will surface the error.
  ConfigSchema.parse(merged);

  const serialized = serializeToml(merged);
  const backupPath = `${CONFIG_PATH}.bak-${Date.now()}`;
  if (existsSync(CONFIG_PATH)) {
    try {
      writeFileSync(backupPath, readFileSync(CONFIG_PATH));
    } catch {}
  }
  const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, serialized, "utf8");
  renameSync(tmp, CONFIG_PATH);
  return { backupPath };
}

function serializeToml(obj: Record<string, unknown>): string {
  // Preserve the file's leading comment block (everything before the first
  // `[section]`). smol-toml drops comments but the top-of-file block is
  // usually where the user has orientation notes.
  const leader = extractLeadingComments();
  const body = stringifyToml(obj);
  return leader ? `${leader}\n${body}\n` : `${body}\n`;
}

function extractLeadingComments(): string {
  if (!existsSync(CONFIG_PATH)) return "";
  const raw = readFileSync(CONFIG_PATH, "utf8");
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) {
      out.push(line);
      continue;
    }
    break;
  }
  return out.join("\n").replace(/\s+$/, "");
}

/**
 * Recursively merge `next` onto `base`. Any string at a `keys.*` path whose
 * value starts with "•" is dropped (preserve base). This matches the mask
 * read path: the UI echoes back masked secrets by default; we treat that as
 * "don't change."
 */
export function deepMergeWithSecrets(base: unknown, next: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...((base as Record<string, unknown>) ?? {}) };
  const nextObj = (next as Record<string, unknown>) ?? {};
  for (const [k, v] of Object.entries(nextObj)) {
    if (Array.isArray(v)) {
      out[k] = mergeArrayWithSecrets(out[k], v);
    } else if (v && typeof v === "object") {
      out[k] = deepMergeWithSecrets(out[k], v);
    } else if (k && typeof v === "string" && v.startsWith("•")) {
      // secret placeholder — keep existing base value
      // (no-op; out[k] already has base value)
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Arrays used to be replaced wholesale, which was fine while nothing inside
 * one was masked. `[[guest_campaigns]]` carries a key per element, so a
 * masked element has to be merged with the element at the same index of the
 * on-disk array or the mask would be written over the real key. Elements
 * beyond the on-disk length are taken as sent.
 */
function mergeArrayWithSecrets(base: unknown, next: unknown[]): unknown[] {
  const baseArr = Array.isArray(base) ? base : [];
  return next.map((item, i) => {
    const prior = baseArr[i];
    if (Array.isArray(item)) return mergeArrayWithSecrets(prior, item);
    if (item && typeof item === "object") return deepMergeWithSecrets(prior, item);
    if (typeof item === "string" && item.startsWith("•")) return prior ?? item;
    return item;
  });
}
