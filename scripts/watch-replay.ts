#!/usr/bin/env bun
/**
 * Run the watch's rules over what the assistant has already done.
 *
 * A rule that fires on ordinary work is worse than no rule: it teaches
 * everyone to ignore it. Before a tripwire is allowed to hold a call or text
 * the operator, this replays it over the Claude Code transcripts on disk,
 * turn by turn in order, and counts what it would have done: how many turns,
 * how many trips of each kind, how many calls would have waited for a judge.
 * It also prints the sites those turns reached, which seeds the list of
 * known hosts so that the first day is not all first sightings.
 *
 *   bun scripts/watch-replay.ts <sessions dir> [--days 30] [--config config.toml]
 *       [--samples 3] [--seed-hosts out.json]
 *
 * Nothing is sent anywhere, no judge is called, and secret values are never
 * printed: a sample shows the trip's own sentence and a clipped command.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config/config.ts";
import { operatorHandles } from "../src/security/policy.ts";
import { meaningOf } from "../src/security/watch/classify.ts";
import { KnownHosts, isLocalHost, siteOf } from "../src/security/watch/hosts.ts";
import { SecretScanner, secretsInConfig, secretsInFolder } from "../src/security/watch/secrets.ts";
import {
  type Flight,
  type Trip,
  type TripContext,
  newFlight,
  recordCall,
  recordResult,
  tripsBefore,
} from "../src/security/watch/tripwires.ts";
import { atomicWriteFileSync } from "../src/util/atomic-write.ts";

type Args = { dir: string; days: number; config: string; samples: number; seed: string | null };

function parseArgs(argv: string[]): Args {
  const args: Args = { dir: "", days: 30, config: "./config.toml", samples: 3, seed: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--days") args.days = Number(argv[++i]);
    else if (a === "--config") args.config = argv[++i]!;
    else if (a === "--samples") args.samples = Number(argv[++i]);
    else if (a === "--seed-hosts") args.seed = argv[++i]!;
    else if (!a.startsWith("-")) args.dir = a;
  }
  if (!args.dir) {
    console.error(
      "usage: bun scripts/watch-replay.ts <sessions dir> [--days 30] [--config config.toml]",
    );
    process.exit(2);
  }
  return args;
}

/** Every transcript under the folder, sub-agents included, changed within the window. */
function transcripts(dir: string, sinceMs: number): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(d, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth < 4 && name !== "tool-results") walk(path, depth + 1);
      } else if (name.endsWith(".jsonl") && stat.mtimeMs >= sinceMs) {
        out.push(path);
      }
    }
  };
  walk(dir, 0);
  return out;
}

type Block = {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  text?: string;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b && typeof b === "object" && typeof (b as Block).text === "string" ? (b as Block).text : "",
    )
    .join("\n");
}

const args = parseArgs(process.argv.slice(2));
const sinceMs = Date.now() - args.days * 86_400_000;
const config = loadConfig(args.config);
const scanner = new SecretScanner([
  ...secretsInConfig(config),
  ...secretsInFolder(join(config.paths.data_dir, "secrets")),
]);
const known = new KnownHosts(null);
const sent = new Set<string>();
const ctx: TripContext = {
  secrets: scanner,
  known,
  allowed: () => false,
  secretSentBefore: (secret, site) => sent.has(`${secret}>${site}`),
  operatorChat: true,
};
// A transcript folder is named after its sandbox, which is named after the chat.
const operatorDigits = operatorHandles(config).map((h) => h.replace(/\D/g, "").slice(-10));
const isOperatorChat = (folder: string) =>
  /-dm-/.test(folder) && operatorDigits.some((d) => d.length === 10 && folder.includes(d));

const files = transcripts(args.dir, sinceMs);
let turns = 0;
let calls = 0;
let turnsTripped = 0;
const byKind = new Map<
  string,
  { trips: number; turns: Set<string>; hold: number; block: number; samples: string[] }
>();
const byDay = new Map<string, number>();
const toolCounts = new Map<string, number>();
const hostCounts = new Map<string, number>();

function note(trip: Trip, flight: Flight, summary: string, day: string): void {
  const k = byKind.get(trip.kind) ?? { trips: 0, turns: new Set(), hold: 0, block: 0, samples: [] };
  k.trips++;
  k.turns.add(`${flight.session}#${flight.turn}`);
  if (trip.action === "hold") k.hold++;
  if (trip.action === "block") k.block++;
  if (k.samples.length < args.samples)
    k.samples.push(`${day} [${trip.action}] ${trip.why}\n        ${summary.slice(0, 150)}`);
  byKind.set(trip.kind, k);
  byDay.set(day, (byDay.get(day) ?? 0) + 1);
}

for (const file of files) {
  const session = file.split("/").slice(-2, -1)[0] ?? file;
  ctx.operatorChat = isOperatorChat(file);
  let flight: Flight | null = null;
  let turnHadTrip = false;
  const pending = new Map<string, { tool: string; input: Record<string, unknown> }>();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const line of text.split("\n")) {
    if (
      !line.includes('"type":"user"') &&
      !line.includes('"type":"assistant"') &&
      !line.includes('"type": "')
    )
      continue;
    let rec: {
      type?: string;
      timestamp?: string;
      message?: { content?: unknown };
      isSidechain?: boolean;
    };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const at = rec.timestamp ? Date.parse(rec.timestamp) : 0;
    if (at && at < sinceMs) continue;
    const day = (rec.timestamp ?? "").slice(0, 10);
    const content = rec.message?.content;
    if (rec.type === "user") {
      const blocks = Array.isArray(content) ? (content as Block[]) : [];
      const results = blocks.filter((b) => b?.type === "tool_result");
      if (results.length === 0) {
        // A new message from outside starts a turn.
        const ask = typeof content === "string" ? content : textOf(content);
        if (ask.trim()) {
          if (flight && turnHadTrip) turnsTripped++;
          turns++;
          turnHadTrip = false;
          const tier = ctx.operatorChat ? "operator" : "contact";
          flight = newFlight(session, `t${turns}`, ask, { handle: null, tier }, at);
          pending.clear();
        }
        continue;
      }
      if (!flight) continue;
      for (const result of results) {
        const call = pending.get(result.tool_use_id ?? "");
        if (!call) continue;
        pending.delete(result.tool_use_id ?? "");
        const meaning = meaningOf(call.tool, call.input, { downloaded: flight.downloads });
        for (const host of meaning.hosts) {
          if (!isLocalHost(host)) hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
        }
        // What was sent is now somewhere that has been sent it.
        for (const hit of scanner.find(meaning.outbound)) {
          for (const host of meaning.hosts) sent.add(`${hit.name}>${siteOf(host)}`);
        }
        for (const trip of recordResult(
          flight,
          call.tool,
          meaning,
          textOf(result.content),
          ctx,
          at,
        )) {
          note(trip, flight, meaning.summary, day);
          turnHadTrip = true;
        }
      }
    } else if (rec.type === "assistant" && flight) {
      const blocks = Array.isArray(content) ? (content as Block[]) : [];
      for (const block of blocks) {
        if (block?.type !== "tool_use" || !block.name) continue;
        calls++;
        toolCounts.set(block.name, (toolCounts.get(block.name) ?? 0) + 1);
        const input = block.input ?? {};
        const meaning = meaningOf(block.name, input, { downloaded: flight.downloads });
        const trips = tripsBefore(flight, block.name, meaning, ctx, at);
        recordCall(flight, block.name, meaning, trips, at);
        for (const trip of trips) {
          note(trip, flight, meaning.summary, day);
          turnHadTrip = true;
        }
        if (block.id) pending.set(block.id, { tool: block.name, input });
      }
    }
  }
  if (flight && turnHadTrip) turnsTripped++;
}

const pct = (n: number, d: number) => (d === 0 ? "0%" : `${((100 * n) / d).toFixed(1)}%`);
console.log(
  `transcripts: ${files.length}   turns: ${turns}   tool calls: ${calls}   secrets known: ${scanner.names.length}`,
);
console.log(`turns that tripped anything: ${turnsTripped} (${pct(turnsTripped, turns)})`);
const holds = [...byKind.values()].reduce((n, k) => n + k.hold, 0);
const blocks = [...byKind.values()].reduce((n, k) => n + k.block, 0);
console.log(
  `calls that would have waited for a judge: ${holds} (${pct(holds, calls)})   refused outright: ${blocks}`,
);
console.log("");
for (const [kind, k] of [...byKind].sort((a, b) => b[1].trips - a[1].trips)) {
  console.log(
    `${kind}: ${k.trips} trips in ${k.turns.size} turns (hold ${k.hold}, block ${k.block})`,
  );
  for (const sample of k.samples) console.log(`    ${sample}`);
}
const days = [...byDay].sort();
if (days.length > 0) {
  const total = days.reduce((n, [, c]) => n + c, 0);
  console.log(
    `\ntrips per day: ${(total / Math.max(1, args.days)).toFixed(1)} on average, most ${Math.max(...days.map(([, c]) => c))}`,
  );
}
console.log(`sites reached: ${known.size}`);
if (args.seed) {
  known.flush();
  const seeded = new KnownHosts(args.seed);
  for (const [host] of hostCounts) seeded.note(host, sinceMs);
  seeded.flush();
  atomicWriteFileSync(`${args.seed}.sent`, `${JSON.stringify([...sent].sort())}\n`);
  console.log(
    `seed written: ${args.seed} (${seeded.size} sites), ${args.seed}.sent (${sent.size} pairs)`,
  );
}
