/**
 * What belongs in the data folder, and who writes it.
 *
 * The folder is where every subsystem keeps its state, and nothing said what
 * was supposed to be there. By 2026-11-25 it held 135 entries: beside the live
 * databases sat the databases of removed features, empty files created by a
 * typo nine months earlier, a dozen hand-made backups, and logs of services
 * that no longer exist. Telling them apart meant searching the code for each
 * name.
 *
 * This is the list. `auditDataDir` holds a real folder against it and sorts
 * every entry into known (with its owner), retired (named below, with the
 * reason), a backup, stale (undeclared, and empty or a log, and long
 * untouched), or unknown. `planClean` turns that into moves into
 * `data/.trash/<day>/`, which `edmund data clean` applies: nothing is deleted
 * outright, a file a process still has open is left alone, and an entry this
 * list does not know is reported and never touched.
 *
 * `tests/data-layout.test.ts` reads the code for every path it builds under
 * the data folder and fails on a name that is not here, so a new file is
 * declared when it is introduced.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { utcDay } from "./log-files.ts";

type DataKind = "database" | "state" | "secret" | "socket" | "folder";

export type DataEntry = {
  /** The name at the top of the data folder. A trailing `*` matches any ending. */
  name: string;
  kind: DataKind;
  /** The code that writes it. */
  owner: string;
  note: string;
  /** For a folder that is a cache: files older than this are removed by a clean. */
  cacheDays?: number;
};

const db = (name: string, owner: string, note: string): DataEntry => ({
  name,
  kind: "database",
  owner,
  note,
});
const state = (name: string, owner: string, note: string): DataEntry => ({
  name,
  kind: "state",
  owner,
  note,
});
const folder = (name: string, owner: string, note: string, cacheDays?: number): DataEntry => ({
  name,
  kind: "folder",
  owner,
  note,
  ...(cacheDays ? { cacheDays } : {}),
});

export const DATA_LAYOUT: DataEntry[] = [
  // --- the four folders that hold everything that is not a feature's own ---
  folder("db", "src/db/open.ts", "Every SQLite database, each with its -wal and -shm beside it."),
  folder(
    "run",
    "src/main.ts",
    "Written at every start and meaningless after a stop: generated configs, sockets, status files, tunnel addresses.",
  ),
  folder("secrets", "dashboard/server/auth.ts", "Tokens, the signing keychain and certificates."),
  folder(
    "state",
    "src/skills/",
    "Small durable files: skill records, addressing decisions, cursors, the pending queue.",
  ),

  // --- db/ ---
  db(
    "db/state.db",
    "src/sessions/store.ts",
    "Sessions, the outbox, guests, credits: the daemon's core state.",
  ),
  db("db/cron.db", "src/cron/store.ts", "Scheduled jobs."),
  db("db/spend.db", "src/spend/", "Every model turn and what it cost."),
  db("db/recall.sqlite", "src/memory/", "The recall index: every message, embedded."),
  db("db/vector.db", "src/memory/vector-store.ts", "The recall index under its earlier name."),
  db("db/agents.db", "src/agents/store.ts", "Sub-agents and their results."),
  db("db/bg_jobs.db", "src/background/store.ts", "Background jobs."),
  db("db/alerts.db", "src/alerts/store.ts", "Operator alerts sent."),
  db("db/announcements.db", "src/announce/store.ts", "Feature announcements offered and given."),
  db("db/calls.db", "src/calls/store.ts", "Calls placed and received."),
  db("db/errands.db", "src/concierge/errands.ts", "Errands in progress."),
  db("db/ideations.db", "src/ideation/store.ts", "Pages made for people."),
  db(
    "db/mirror.db",
    "integrations/mirror/src/store.ts",
    "The mirror's own conversation and state.",
  ),
  db("db/model_stats.db", "src/media/model-scorecard.ts", "Media model results, by model."),
  db("db/refresh.db", "src/refresh/store.ts", "Refresh scripts and their last runs."),
  db("db/triggers.db", "src/triggers/store.ts", "Data triggers."),

  // --- run/ ---
  state(
    "run/mcp.json",
    "src/model/mcp-config.ts",
    "Generated MCP server config, rewritten at boot.",
  ),
  state(
    "run/mcp-*.json",
    "src/model/mcp-config.ts",
    "Generated MCP server configs by tier, rewritten at boot.",
  ),
  state("run/pool-stats.json", "src/main.ts", "The worker pool, for the dashboard."),
  state(
    "run/public-router.json",
    "src/web/public-hosts.ts",
    "Where the public router listens, and the key the portal's listener relays with.",
  ),
  state(
    "run/resource-status.json",
    "src/boot/resource-governor.ts",
    "The latest memory sample, for the dashboard.",
  ),
  state("run/*.kick", "cli/", "A request for the daemon to do something now; consumed at once."),
  state(
    "run/portal-tunnel-url",
    "scripts/launchd/run-portal-tunnel.sh",
    "The portal's public address.",
  ),
  state(
    "run/sms-tunnel-url",
    "scripts/launchd/run-sms-tunnel.sh",
    "The SMS webhook's public address.",
  ),
  state(
    "run/grok-tunnel-url",
    "scripts/launchd/run-grok-tunnel.sh",
    "The Grok webhook's public address.",
  ),
  state("run/grok-connector-url.*", "src/grok/", "The Grok connector's address."),
  state(
    "run/dashboard-tunnel-url",
    "scripts/dashboard-tunnel.sh",
    "The dashboard's public address.",
  ),
  state(
    "run/dashboard-tunnel.pid",
    "scripts/dashboard-tunnel.sh",
    "The dashboard tunnel's process.",
  ),
  {
    name: "run/bridge-control.sock",
    kind: "socket",
    owner: "src/imessage/bridge/",
    note: "MCP servers ask the daemon's bridge to send through this.",
  },
  folder(
    "run/turn-workers",
    "src/model/turn-workers.ts",
    "Which model processes belong to this daemon.",
  ),
  folder("run/typing-heartbeats", "src/mcp/tools/typing.ts", "Typing indicators in flight."),
  folder(
    "run/facetime",
    "src/calls/providers/facetime/",
    "Sockets for a live call's audio, and turn clips when they are kept.",
  ),

  // --- secrets/ ---
  {
    name: "secrets/dashboard.secret",
    kind: "secret",
    owner: "dashboard/server/auth.ts",
    note: "Signs dashboard and portal sessions.",
  },
  {
    name: "secrets/kitchen-tunnel-token",
    kind: "secret",
    owner: "integrations/kitchen/scripts/host.ts",
    note: "The public router's tunnel credential.",
  },
  {
    name: "secrets/sms-tunnel-token",
    kind: "secret",
    owner: "scripts/launchd/run-sms-tunnel.sh",
    note: "The SMS tunnel's credential.",
  },
  folder(
    "secrets/signing",
    "native/facetime/signing-identity.sh",
    "The keychain that signs the call audio driver.",
  ),
  folder("secrets/voice-lab", "scripts/voice-lab-link.ts", "The voice lab's certificate and key."),

  // --- state/ ---
  state(
    "state/installed-skills.json",
    "src/skills/",
    "Skills installed from outside the checkout.",
  ),
  state("state/skill-consent.json", "src/skills/", "Skill install consent."),
  state(
    "state/skill-curator.json",
    "src/skills/curator-observer.ts",
    "The skill curator's cursor.",
  ),
  state(
    "state/skill-usage.jsonl",
    "src/skills/usage.ts",
    "Which skills were read, for the curator.",
  ),
  state(
    "state/addressing.jsonl",
    "src/gating/address-check.ts",
    "Group addressing decisions, for calibration.",
  ),
  state(
    "state/runtime-crash-cursor.json",
    "src/boot/runtime-crash.ts",
    "How far launchd's stderr has been read for crash reports.",
  ),
  state("state/cli-version.json", "src/claude/cli-canary.ts", "The model CLI version last seen."),
  state("state/web-mounts.json", "src/web/mounts.ts", "Pages mounted on the public router."),
  folder(
    "state/pending",
    "src/channels/session-queue.ts",
    "Messages that arrived while a turn was running.",
  ),

  // --- a feature's own folder ---
  folder("calls", "src/calls/", "Call voice and pronunciation settings."),
  folder(
    "computer-use",
    "src/mcp/computer-use/",
    "Screen control: the lock, per-turn state and the action verdicts.",
  ),
  folder(
    "evals",
    "src/evals/",
    "Reply-quality probes, recall evaluations, addressing calibration and weekly reviews.",
  ),
  folder("grok", "src/grok/", "Grok exchanges and pending replies."),
  folder("ideations", "src/ideation/", "The pages made for people."),
  folder("instant-share", "skills/instant-share/", "Shared artifacts and their tunnels."),
  folder(
    "kitchen",
    "integrations/kitchen/",
    "Household kitchen ledgers, their sites and browser profile.",
  ),
  folder("media", "src/media/", "Converted audio for transcription: a cache.", 30),
  folder("models", "config: [tools] local_stt_model", "Speech model files named in the config."),
  folder("plugins", "config: [claude] plugin_dirs", "Model CLI plugins."),
  folder("printer", "integrations/printer/", "Print jobs, camera frames and the printer's state."),
  folder("shelf", "src/shelf/", "What was handed to people at a permanent link."),
  folder("sms-media", "src/sms/", "Attachments received by SMS."),
  folder(".trash", "src/util/data-layout.ts", "What a clean moved aside; emptied after 30 days."),
];

/** The folders whose contents are declared one by one. */
export const GROUP_FOLDERS = ["db", "run", "secrets", "state"] as const;

/**
 * Where each name that used to sit at the top of the data folder lives now.
 * Until 2026-11-25 everything was at the top: 16 databases with their -wal
 * and -shm files, generated configs, tokens, sockets, cursors and a dozen
 * logs, 116 entries with the features' folders lost among them.
 * `edmund data migrate` applies this to a folder in the old layout.
 */
const MOVED: Record<string, string> = {
  "state.db": "db/state.db",
  "cron.db": "db/cron.db",
  "spend.db": "db/spend.db",
  "recall.sqlite": "db/recall.sqlite",
  "vector.db": "db/vector.db",
  "agents.db": "db/agents.db",
  "bg_jobs.db": "db/bg_jobs.db",
  "alerts.db": "db/alerts.db",
  "announcements.db": "db/announcements.db",
  "calls.db": "db/calls.db",
  "errands.db": "db/errands.db",
  "ideations.db": "db/ideations.db",
  "mirror.db": "db/mirror.db",
  "model_stats.db": "db/model_stats.db",
  "refresh.db": "db/refresh.db",
  "triggers.db": "db/triggers.db",
  "mcp.json": "run/mcp.json",
  "mcp-*.json": "run/",
  "pool-stats.json": "run/pool-stats.json",
  "resource-status.json": "run/resource-status.json",
  "*.kick": "run/",
  "portal-tunnel-url": "run/portal-tunnel-url",
  "sms-tunnel-url": "run/sms-tunnel-url",
  "grok-tunnel-url": "run/grok-tunnel-url",
  "grok-connector-url.*": "run/",
  "dashboard-tunnel-url": "run/dashboard-tunnel-url",
  "dashboard-tunnel.pid": "run/dashboard-tunnel.pid",
  "bridge-control.sock": "run/bridge-control.sock",
  "turn-workers": "run/turn-workers",
  "typing-heartbeats": "run/typing-heartbeats",
  facetime: "run/facetime",
  "dashboard.secret": "secrets/dashboard.secret",
  "kitchen-tunnel-token": "secrets/kitchen-tunnel-token",
  "sms-tunnel-token": "secrets/sms-tunnel-token",
  signing: "secrets/signing",
  "voice-lab": "secrets/voice-lab",
  "installed-skills.json": "state/installed-skills.json",
  "skill-consent.json": "state/skill-consent.json",
  "skill-curator.json": "state/skill-curator.json",
  "skill-usage.jsonl": "state/skill-usage.jsonl",
  "addressing.jsonl": "state/addressing.jsonl",
  "runtime-crash-cursor.json": "state/runtime-crash-cursor.json",
  "cli-version.json": "state/cli-version.json",
  "web-mounts.json": "state/web-mounts.json",
  pending: "state/pending",
  addressing: "evals/addressing",
  reviews: "evals/reviews",
};

/** Names a deployment may still have that nothing reads or writes any more. */
export const RETIRED_DATA: { name: string; why: string }[] = [
  { name: "trading.db", why: "the trading integration was removed (2026-11-25)" },
  { name: "trading", why: "the trading integration was removed (2026-11-25)" },
  { name: "trading.launchd.*", why: "the trading integration was removed (2026-11-25)" },
  {
    name: "mcp-trading.json",
    why: "the trading integration was removed (2026-11-25); it can hold a bearer token",
  },
  { name: "annotations.db", why: "image annotation links were removed (2026-11-25)" },
  { name: ".DS_Store", why: "Finder's folder settings" },
];

/** An undeclared empty file is stale after this long; an undeclared log after the second. */
const STALE_EMPTY_DAYS = 30;
const STALE_LOG_DAYS = 90;

function matches(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  const [head, tail] = pattern.split("*") as [string, string];
  return name.length >= head.length + tail.length && name.startsWith(head) && name.endsWith(tail);
}

/** A SQLite file's companions belong to the database they sit beside. */
function withoutSidecar(name: string): string {
  return name.replace(/-(wal|shm)$/, "");
}

const BACKUP = /(\.bak($|[-.])|\.pre-[a-z]|\.orig$|~$)/i;

/** The layout entry for a path relative to the data folder (`db/state.db`, `kitchen`), if it has one. */
export function entryFor(name: string): DataEntry | null {
  const base = withoutSidecar(name);
  // An exact name wins over a pattern.
  return (
    DATA_LAYOUT.find((e) => e.name === base) ??
    DATA_LAYOUT.find((e) => e.name.includes("*") && matches(e.name, base)) ??
    null
  );
}

/** Where a name from the old, flat layout lives now, relative to the data folder; null if it never moved. */
export function movedTo(name: string): string | null {
  const base = withoutSidecar(name);
  for (const [pattern, to] of Object.entries(MOVED)) {
    if (!matches(pattern, base)) continue;
    // A database's -wal and -shm go with it.
    return to.endsWith("/") ? `${to}${name}` : `${to}${name.slice(base.length)}`;
  }
  return null;
}

export type Finding = {
  /** Relative to the data folder: `kitchen`, `db/state.db`. */
  name: string;
  path: string;
  bytes: number;
  modifiedMs: number;
  isFolder: boolean;
  status: "known" | "misplaced" | "retired" | "backup" | "stale" | "unknown";
  entry?: DataEntry;
  why?: string;
};

function sizeOf(path: string, depth = 0): number {
  try {
    const stat = statSync(path);
    if (!stat.isDirectory()) return stat.size;
    if (depth > 12) return 0;
    let total = 0;
    for (const name of readdirSync(path)) total += sizeOf(join(path, name), depth + 1);
    return total;
  } catch {
    return 0;
  }
}

/**
 * Sort every entry at the top of a data folder, and every entry inside the
 * four group folders, into known, misplaced, retired, backup, stale or
 * unknown. Misplaced is the old flat layout: a name that has a place now and
 * is not in it, or a log, which belongs in the logs folder
 * (`edmund data migrate`). Stale is what a deployment collects that no list
 * could name: an undeclared file that is empty (a mistyped database name
 * creates one) or an undeclared log, that nothing has written to for a long
 * time.
 */
export function auditDataDir(dataDir: string, now: number = Date.now()): Finding[] {
  const findings: Finding[] = [];
  const classify = (name: string, topLevel: boolean): void => {
    const path = join(dataDir, name);
    let isFolder = false;
    let modifiedMs = 0;
    try {
      const stat = statSync(path);
      isFolder = stat.isDirectory();
      modifiedMs = stat.mtimeMs;
    } catch {
      return;
    }
    const leaf = name.split("/").pop() ?? name;
    const base = { name, path, bytes: sizeOf(path), modifiedMs, isFolder };
    const retired = RETIRED_DATA.find((r) => matches(r.name, withoutSidecar(leaf)));
    if (retired) {
      findings.push({ ...base, status: "retired", why: retired.why });
      return;
    }
    if (BACKUP.test(leaf)) {
      findings.push({ ...base, status: "backup", why: "a copy somebody made by hand" });
      return;
    }
    const entry = entryFor(name);
    if (entry) {
      findings.push({ ...base, status: "known", entry });
      return;
    }
    if (topLevel) {
      const now_ = movedTo(name);
      if (now_) {
        findings.push({ ...base, status: "misplaced", why: `belongs at ${now_}` });
        return;
      }
      if (name === "logs" || (!isFolder && leaf.endsWith(".log"))) {
        findings.push({ ...base, status: "misplaced", why: "a log: belongs in the logs folder" });
        return;
      }
    }
    const idleDays = (now - modifiedMs) / 86_400_000;
    if (!isFolder && base.bytes === 0 && idleDays > STALE_EMPTY_DAYS) {
      findings.push({
        ...base,
        status: "stale",
        why: `empty, undeclared, and untouched for ${Math.floor(idleDays)} days`,
      });
    } else if (!isFolder && leaf.endsWith(".log") && idleDays > STALE_LOG_DAYS) {
      findings.push({
        ...base,
        status: "stale",
        why: `a log nothing declares, last written ${Math.floor(idleDays)} days ago`,
      });
    } else {
      findings.push({ ...base, status: "unknown" });
    }
  };
  for (const name of readdirSync(dataDir).sort()) {
    classify(name, true);
    if (!(GROUP_FOLDERS as readonly string[]).includes(name)) continue;
    let children: string[] = [];
    try {
      children = readdirSync(join(dataDir, name)).sort();
    } catch {}
    for (const child of children) classify(`${name}/${child}`, false);
  }
  return findings;
}

export type CleanStep =
  | { action: "trash"; finding: Finding; why: string }
  | { action: "expire"; path: string; bytes: number; why: string };

export type CleanOptions = {
  /** A hand-made backup is left alone until it is this old. */
  backupDays: number;
  /** What a clean moved aside is deleted after this long. */
  trashDays: number;
};

const DEFAULT_CLEAN: CleanOptions = { backupDays: 30, trashDays: 30 };

function oldFilesIn(
  dir: string,
  olderThanMs: number,
  out: { path: string; bytes: number }[],
): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (stat.isDirectory()) oldFilesIn(path, olderThanMs, out);
      else if (stat.mtimeMs < olderThanMs) out.push({ path, bytes: stat.size });
    } catch {}
  }
}

/** What a clean would do. Known entries stay, except the old contents of a declared cache. */
export function planClean(
  dataDir: string,
  findings: Finding[] = auditDataDir(dataDir),
  options: CleanOptions = DEFAULT_CLEAN,
  now: number = Date.now(),
): CleanStep[] {
  const DAY = 86_400_000;
  const steps: CleanStep[] = [];
  for (const finding of findings) {
    if (finding.status === "retired" || finding.status === "stale") {
      steps.push({ action: "trash", finding, why: finding.why ?? finding.status });
    } else if (finding.status === "backup" && now - finding.modifiedMs > options.backupDays * DAY) {
      steps.push({
        action: "trash",
        finding,
        why: `a hand-made backup older than ${options.backupDays} days`,
      });
    } else if (finding.status === "known" && finding.entry?.cacheDays) {
      const old: { path: string; bytes: number }[] = [];
      oldFilesIn(finding.path, now - finding.entry.cacheDays * DAY, old);
      for (const file of old) {
        steps.push({
          action: "expire",
          ...file,
          why: `cache file older than ${finding.entry.cacheDays} days`,
        });
      }
    }
  }
  // Earlier cleans, once nobody has asked for anything back.
  const trash = join(dataDir, ".trash");
  try {
    for (const day of readdirSync(trash)) {
      const path = join(trash, day);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      if (now - Date.parse(`${day}T00:00:00Z`) > options.trashDays * DAY) {
        steps.push({
          action: "expire",
          path,
          bytes: sizeOf(path),
          why: `moved aside more than ${options.trashDays} days ago`,
        });
      }
    }
  } catch {}
  return steps;
}

/** The command that has a file open, or null. A file in use is never moved. */
export function heldOpenBy(path: string, writersOnly = false): string | null {
  try {
    const run = Bun.spawnSync(["lsof", "-Fca", "--", path], { stdout: "pipe", stderr: "ignore" });
    if (run.exitCode !== 0) return null;
    // One block a process: c<command>, then for each descriptor a<access> (r, w or u).
    let command = "another process";
    let anyone: string | null = null;
    for (const line of run.stdout.toString().split("\n")) {
      if (line.startsWith("c")) command = line.slice(1);
      else if (line.startsWith("a")) {
        anyone ??= command;
        if (line[1] === "w" || line[1] === "u") return command;
      }
    }
    return writersOnly ? null : (anyone ?? "another process");
  } catch {
    return null;
  }
}

export type CleanResult = {
  trashed: { name: string; bytes: number; to: string }[];
  expired: { path: string; bytes: number }[];
  skipped: { name: string; reason: string }[];
};

/** Carry out a plan. Retired entries and old backups move into `.trash/<day>/`; nothing known is touched. */
export function applyClean(
  dataDir: string,
  steps: CleanStep[],
  inUse: (path: string) => string | null = heldOpenBy,
  today: string = utcDay(),
): CleanResult {
  const result: CleanResult = { trashed: [], expired: [], skipped: [] };
  const trashDir = join(dataDir, ".trash", today);
  for (const step of steps) {
    if (step.action === "expire") {
      try {
        if (statSync(step.path).isDirectory()) rmSync(step.path, { recursive: true, force: true });
        else unlinkSync(step.path);
        result.expired.push({ path: step.path, bytes: step.bytes });
      } catch (err) {
        result.skipped.push({ name: step.path, reason: (err as Error).message });
      }
      continue;
    }
    const { finding } = step;
    // A database's companions are held by whoever holds the database.
    const holder = finding.isFolder ? null : inUse(finding.path);
    if (holder) {
      result.skipped.push({ name: finding.name, reason: `still open in ${holder}` });
      continue;
    }
    try {
      let target = join(trashDir, finding.name);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      for (let n = 1; existsSync(target); n++) target = join(trashDir, `${finding.name}.${n}`);
      renameSync(finding.path, target);
      result.trashed.push({ name: finding.name, bytes: finding.bytes, to: target });
    } catch (err) {
      result.skipped.push({ name: finding.name, reason: (err as Error).message });
    }
  }
  return result;
}
