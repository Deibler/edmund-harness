/**
 * The publish gate: what must be true of a share before it is given a
 * public address, and the list of doors that were opened through it.
 *
 * A share server already binds to loopback, demands a key and serves no
 * listings; those are properties of the server (skills/instant-share). What
 * nothing checked was what the assistant chose: how long it stays up, and
 * what is in the folder. On 2026-11-25 one share had been started with an
 * expiry of 525,600 minutes, a year, and had been up nine days.
 *
 * So before a share goes live:
 *  - its expiry is set and within the limit, unless the operator allowed
 *    longer for that folder;
 *  - no file in the folder is the kind that holds credentials, and none
 *    contains a canary, a real credential or a vendor's key format.
 *
 * And when it does go live it is written down here by port, which is how
 * the watch tells a tunnel that came through the gate from one that did not.
 */
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { atomicWriteFileSync } from "../../util/atomic-write.ts";
import { type SecretScanner, keyShapesIn } from "./secrets.ts";
import { readWatchState, watchDir } from "./state.ts";

/** File names that exist to hold credentials or a whole repository. */
const FORBIDDEN_NAMES: [what: string, pattern: RegExp][] = [
  ["an environment file", /^\.env(?:\..+)?$/],
  ["a token file", /\.(?:token|secret|credentials)$/i],
  ["a private key", /^id_(?:rsa|dsa|ecdsa|ed25519)$|\.(?:pem|key|p12|pfx|keystore|jks)$/i],
  [
    "a credentials file",
    /^(?:\.netrc|\.npmrc|\.pypirc|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml))$/i,
  ],
  ["a repository", /^\.(?:git|svn|hg)$/],
];
/** A template is not a secret. */
const ALLOWED_NAMES = /^\.env\.(?:example|sample|template)$/;

const MAX_FILES = 3_000;
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

export type GateProblem = { file: string; why: string };

/** Everything in a folder that must not be published. Empty when it may go. */
export function scanFolder(root: string, scanner: SecretScanner): GateProblem[] {
  const problems: GateProblem[] = [];
  let seen = 0;
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (seen >= MAX_FILES) return;
      const path = join(dir, name);
      const rel = relative(root, path) || name;
      const forbidden = ALLOWED_NAMES.test(name)
        ? undefined
        : FORBIDDEN_NAMES.find(([, pattern]) => pattern.test(name));
      if (forbidden) {
        problems.push({ file: rel, why: `is ${forbidden[0]}` });
        continue;
      }
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      // A link can point anywhere on the machine: what it serves is not in this folder.
      if (stat.isSymbolicLink()) {
        problems.push({ file: rel, why: "is a link to somewhere outside the folder" });
        continue;
      }
      if (stat.isDirectory()) {
        if (name !== "node_modules") walk(path);
        continue;
      }
      seen++;
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SCAN_BYTES) continue;
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue;
      const hits = scanner.find(text);
      if (hits.length > 0) {
        problems.push({ file: rel, why: `contains ${hits.map((h) => h.name).join(", ")}` });
        continue;
      }
      const shapes = keyShapesIn(text);
      if (shapes.length > 0) {
        problems.push({
          file: rel,
          why: `contains something shaped like a ${shapes.join(", ")} key`,
        });
      }
    }
  };
  walk(root);
  return problems;
}

/** What an OK from the operator allows: this folder, up for longer than the limit. */
export const longSharePattern = (folder: string) => `long-share|${folder}|gate`;

/**
 * Why a share may not stay up as long as asked, or null when it may.
 * `minutes` of 0 means "never expires", which nothing published here may.
 */
export function expiryProblem(
  minutes: number,
  maxDays: number,
  folder: string,
  dataDir: string,
): string | null {
  const limit = maxDays * 24 * 60;
  if (Number.isFinite(minutes) && minutes > 0 && minutes <= limit) return null;
  if (longSharePattern(folder) in readWatchState(dataDir).allowed) return null;
  const asked =
    !Number.isFinite(minutes) || minutes <= 0
      ? "no expiry at all"
      : `${Math.round(minutes / 1440)} days`;
  return `it asks for ${asked}, and a share expires within ${maxDays} days unless the operator has said this one may stay longer`;
}

// --- the doors that came through the gate -------------------------------------

export type Door = {
  port: number;
  artifact: string;
  path: string;
  /** When it stops being served, epoch ms. */
  expiresAt: number;
  registeredAt: number;
};

const doorsFile = (dataDir: string) => join(watchDir(dataDir), "doors.json");

function readDoors(dataDir: string): Door[] {
  try {
    const raw = JSON.parse(readFileSync(doorsFile(dataDir), "utf8")) as Door[];
    return Array.isArray(raw) ? raw.filter((d) => typeof d?.port === "number") : [];
  } catch {
    return [];
  }
}

/** Write a door down as it is opened. One per port: a port reused replaces what was there. */
export function registerDoor(dataDir: string, door: Door, now: number = Date.now()): void {
  const kept = readDoors(dataDir).filter(
    // A day past expiry and it is history.
    (d) => d.port !== door.port && d.expiresAt > now - 24 * 3_600_000,
  );
  atomicWriteFileSync(doorsFile(dataDir), `${JSON.stringify([...kept, door], null, 1)}\n`);
}

/** True when a tunnel to this local address is one the gate let through. */
export function isRegisteredTarget(
  dataDir: string,
  target: string,
  now: number = Date.now(),
): boolean {
  const port = Number(/:(\d+)\/?$/.exec(target)?.[1] ?? Number.NaN);
  if (!Number.isFinite(port)) return false;
  return readDoors(dataDir).some((d) => d.port === port && d.expiresAt > now);
}
