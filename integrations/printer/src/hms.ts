import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../../src/util/atomic-write.ts";

/**
 * Bambu's own words for every error the printer can raise.
 *
 * Two families. HMS entries (`hms: [{attr, code}]` in the report) are the
 * health-management messages shown on the screen, written as four groups of
 * four hex digits (0300_0100_0001_0007). Device errors (`print_error`, one
 * integer) are what stops or fails a job, written as two groups (0300_400C).
 * The text comes from Bambu's query service for this printer model, bundled
 * in data/hms-en.json and refreshed weekly into the data dir, so a new
 * firmware's codes arrive without a release.
 */

export type ErrorDb = { ver?: number; hms: Record<string, string>; errors: Record<string, string> };

export type DecodedError = {
  kind: "hms" | "device";
  /** As printed on the screen and in the wiki: 0300_0100_0001_0007 or 0300_400C. */
  code: string;
  severity: "fatal" | "serious" | "common" | "info" | "";
  module: string;
  text: string;
  known: boolean;
};

const BUNDLED = join(import.meta.dir, "..", "data", "hms-en.json");
const REFRESH_MS = 7 * 24 * 3600_000;

const SEVERITY: Record<number, DecodedError["severity"]> = {
  1: "fatal",
  2: "serious",
  3: "common",
  4: "info",
};

const MODULES: Record<number, string> = {
  3: "motion controller",
  5: "mainboard",
  7: "AMS",
  8: "toolhead",
  12: "camera and AI monitoring",
  16: "nozzle",
  18: "AMS lite",
  24: "AMS HT",
};

let cached: { path: string; mtime: number; db: ErrorDb } | null = null;

function refreshedPath(dataDir: string): string {
  return join(dataDir, "printer", "hms-en.json");
}

/** The newest error text available: the weekly refresh if present, else the bundled copy. */
export function loadErrorDb(dataDir?: string): ErrorDb {
  const fresh = dataDir ? refreshedPath(dataDir) : "";
  const path = fresh && existsSync(fresh) ? fresh : BUNDLED;
  const mtime = statSync(path).mtimeMs;
  if (cached && cached.path === path && cached.mtime === mtime) return cached.db;
  const db = JSON.parse(readFileSync(path, "utf8")) as ErrorDb;
  cached = { path, mtime, db };
  return db;
}

const hex = (n: number, w: number) => (n >>> 0).toString(16).toUpperCase().padStart(w, "0");

export function formatHms(attr: number, code: number): string {
  const a = hex(attr, 8);
  const c = hex(code, 8);
  return `${a.slice(0, 4)}_${a.slice(4)}_${c.slice(0, 4)}_${c.slice(4)}`;
}

export function decodeHms(entry: { attr: number; code: number }, db: ErrorDb): DecodedError {
  const ecode = `${hex(entry.attr, 8)}${hex(entry.code, 8)}`;
  const text = db.hms[ecode];
  return {
    kind: "hms",
    code: formatHms(entry.attr, entry.code),
    severity: SEVERITY[entry.code >>> 16] ?? "",
    module: MODULES[entry.attr >>> 24] ?? "",
    text: text ?? "Not in Bambu's list for this printer yet.",
    known: !!text,
  };
}

export function decodeDeviceError(value: number, db: ErrorDb): DecodedError | null {
  if (!value) return null;
  const h = hex(value, 8);
  const text = db.errors[h];
  return {
    kind: "device",
    code: `${h.slice(0, 4)}_${h.slice(4)}`,
    severity: "",
    module: MODULES[value >>> 24] ?? "",
    text: text ?? "Not in Bambu's list for this printer yet.",
    known: !!text,
  };
}

/**
 * Any way a person might write a code: "0300_0100_0001_0007",
 * "0300-0100-0001-0007", "HMS_0300...", "0300400C", "0300 400C", or the
 * decimal print_error the report carries (50348044).
 */
export function lookupCode(input: string, db: ErrorDb): DecodedError | null {
  const raw = input.trim();
  const h = raw
    .toUpperCase()
    .replace(/^HMS[_\s-]*/, "")
    .replace(/[^0-9A-F]/g, "");
  if (h.length === 16) {
    return decodeHms(
      { attr: Number.parseInt(h.slice(0, 8), 16), code: Number.parseInt(h.slice(8), 16) },
      db,
    );
  }
  // Eight digits is either the hex code or the decimal value the report
  // carries; whichever names a known error wins, hex by default.
  const asHex = h.length === 8 ? decodeDeviceError(Number.parseInt(h, 16), db) : null;
  if (asHex?.known) return asHex;
  if (/^\d{7,10}$/.test(raw)) {
    const asDecimal = decodeDeviceError(Number(raw), db);
    if (asDecimal?.known || !asHex) return asDecimal;
  }
  return asHex;
}

/** One line a person can read. */
export function describeError(e: DecodedError): string {
  const sev = e.severity ? `${e.severity}, ` : "";
  const mod = e.module ? `${e.module}` : e.kind === "hms" ? "HMS" : "print error";
  return `${e.code} (${sev}${mod}): ${e.text}`;
}

/** Help page for a code. Bambu's wiki is searchable by the code as written on the screen. */
export function wikiLink(e: DecodedError): string {
  return `https://wiki.bambulab.com/en/hms/home (search ${e.code})`;
}

/** Fetch Bambu's current text for this model and keep it beside the bundled copy. Weekly at most. */
export async function refreshErrorDb(dataDir: string, serial: string): Promise<boolean> {
  const path = refreshedPath(dataDir);
  if (existsSync(path) && Date.now() - statSync(path).mtimeMs < REFRESH_MS) return false;
  const prefix = serial.slice(0, 3);
  const get = async (url: string) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as {
      result: number;
      ver?: number;
      data?: Record<string, { en?: Array<{ ecode: string; intro: string }> }>;
    };
  };
  const out: ErrorDb = { hms: {}, errors: {} };
  const sources = [
    "https://e.bambulab.com/query.php?lang=en",
    ...(prefix ? [`https://e.bambulab.com/query.php?lang=en&d=${prefix}`] : []),
  ];
  for (const url of sources) {
    const j = await get(url);
    if (j.result !== 0 || !j.data) continue;
    out.ver = j.ver;
    for (const x of j.data.device_hms?.en ?? []) {
      if (x.intro?.trim()) out.hms[x.ecode.toUpperCase()] = x.intro.trim();
    }
    for (const x of j.data.device_error?.en ?? []) {
      if (x.intro?.trim()) out.errors[x.ecode.toUpperCase()] = x.intro.trim();
    }
  }
  // A short answer is an outage, not a smaller catalogue: keep what we had.
  if (Object.keys(out.hms).length < 500) return false;
  mkdirSync(join(dataDir, "printer"), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(out));
  return true;
}
