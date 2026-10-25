import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Bambu Studio's system profiles, resolved the way the app resolves them.
 *
 * Each profile names a parent (`inherits`) and optional mixins (`include`);
 * the slicer CLI wants the flattened result. Profiles ship inside the app
 * bundle, so they update when Bambu Studio does, and nothing here has to be
 * kept current by hand.
 */

export type Profile = Record<string, unknown> & { name: string };
type Kind = "machine" | "process" | "filament";

const cache = new Map<string, Map<string, Record<string, unknown>>>();

export function profilesDir(slicerPath: string): string {
  // .../BambuStudio.app/Contents/MacOS/BambuStudio -> .../Contents/Resources/profiles/BBL
  return join(dirname(dirname(slicerPath)), "Resources", "profiles", "BBL");
}

function index(dir: string, kind: Kind): Map<string, Record<string, unknown>> {
  const key = `${dir}|${kind}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const m = new Map<string, Record<string, unknown>>();
  const sub = join(dir, kind);
  if (existsSync(sub)) {
    for (const f of readdirSync(sub)) {
      if (!f.endsWith(".json")) continue;
      try {
        const d = JSON.parse(readFileSync(join(sub, f), "utf8")) as Record<string, unknown>;
        if (typeof d.name === "string") m.set(d.name, d);
      } catch {
        // A malformed profile is skipped, as the app skips it.
      }
    }
  }
  cache.set(key, m);
  return m;
}

export function resolveProfile(dir: string, kind: Kind, name: string, depth = 0): Profile {
  if (depth > 20) throw new Error(`profile inheritance loop at ${name}`);
  const d = index(dir, kind).get(name);
  if (!d) throw new Error(`no ${kind} profile named "${name}"`);
  const base =
    typeof d.inherits === "string" && d.inherits
      ? resolveProfile(dir, kind, d.inherits, depth + 1)
      : {};
  const merged: Record<string, unknown> = { ...base };
  for (const inc of Array.isArray(d.include) ? (d.include as string[]) : []) {
    const mix = index(dir, kind).get(inc);
    if (!mix) continue;
    for (const [k, v] of Object.entries(mix)) {
      if (!["name", "instantiation", "type", "from"].includes(k)) merged[k] = v;
    }
  }
  Object.assign(merged, d);
  const { inherits: _parent, include: _mixins, ...flat } = merged;
  return { ...flat, name } as Profile;
}

export function machineName(nozzle: string): string {
  return `Bambu Lab P2S ${nozzle || "0.4"} nozzle`;
}

/** Layer heights by quality, for the 0.4 nozzle the printer ships with. */
export const QUALITY: Record<string, string> = {
  extra_fine: "0.08mm High Quality @BBL P2S",
  fine: "0.12mm High Quality @BBL P2S",
  balanced: "0.16mm Standard @BBL P2S",
  standard: "0.20mm Standard @BBL P2S",
  draft: "0.24mm Standard @BBL P2S",
};

export function processName(quality: string, nozzle: string): string {
  if (nozzle === "0.2") return "0.10mm Standard @BBL P2S 0.2 nozzle";
  if (nozzle === "0.6") return "0.30mm Standard @BBL P2S 0.6 nozzle";
  if (nozzle === "0.8") return "0.40mm Standard @BBL P2S 0.8 nozzle";
  return QUALITY[quality] ?? QUALITY.standard!;
}

/**
 * The system filament profile for what is loaded: by Bambu filament id when
 * the spool says (RFID or set on the AMS), else the generic profile for the
 * material. Only profiles compatible with this machine count.
 */
export function filamentProfileName(
  dir: string,
  machine: string,
  type: string,
  infoIdx?: string,
): string {
  const all = index(dir, "filament");
  const candidates: string[] = [];
  for (const [name, d] of all) {
    if (d.instantiation !== "true") continue;
    const compat = Array.isArray(d.compatible_printers) ? (d.compatible_printers as string[]) : [];
    if (!compat.includes(machine)) continue;
    candidates.push(name);
  }
  if (infoIdx) {
    for (const name of candidates) {
      const r = resolveProfile(dir, "filament", name);
      if (r.filament_id === infoIdx) return name;
    }
  }
  const t = type.trim().toUpperCase();
  const generic = candidates.find((n) => n.toUpperCase().startsWith(`GENERIC ${t} @BBL P2S`));
  if (generic) return generic;
  const basic = candidates.find((n) => n.toUpperCase().startsWith(`BAMBU ${t} BASIC @BBL P2S`));
  if (basic) return basic;
  throw new Error(`no ${type} profile for ${machine}`);
}

/**
 * Apply setting overrides to a resolved profile. Only keys the profile
 * already has are accepted, and each value takes the profile's own shape
 * (Bambu stores most settings as one string per extruder variant).
 */
export function applyOverrides(
  profile: Profile,
  overrides: Record<string, string | number | boolean>,
): { profile: Profile; unknown: string[] } {
  const out: Profile = { ...profile };
  const unknown: string[] = [];
  for (const [k, raw] of Object.entries(overrides)) {
    if (!(k in profile) || k === "name") {
      unknown.push(k);
      continue;
    }
    const v = typeof raw === "boolean" ? (raw ? "1" : "0") : String(raw);
    const cur = profile[k];
    out[k] = Array.isArray(cur) ? cur.map(() => v) : v;
  }
  return { profile: out, unknown };
}
