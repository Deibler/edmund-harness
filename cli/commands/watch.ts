/**
 * `edmund watch` and `edmund lockdown`: the security watch from the command
 * line (src/watch/).
 *
 *   edmund watch                 what the watch is doing: mode, counts, open incidents
 *   edmund watch incidents       the incidents on record, newest first
 *   edmund watch ok <id>         it was fine: reverse what was done and do not raise it again
 *   edmund watch undo <id>       reverse what was done, this once
 *   edmund watch resume [chat]   let a paused chat (or every paused chat) take turns again
 *   edmund watch drill           run the fire drill now: four scenarios through the live watch
 *   edmund lockdown              close every quick tunnel and share, take the shell from
 *                                workers, message nobody but the operator, turn the web off
 *   edmund lockdown off          put all of that back
 *
 * These ask the running daemon to act, over the same loopback listener the
 * workers report to. `lockdown` also works with the daemon down: the flag is
 * a file every process reads, and the tunnels are closed from here.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readWatchAddress } from "../../src/security/watch/address.ts";
import { readWatchState, updateWatchState, watchDir } from "../../src/security/watch/state.ts";
import type { Incident } from "../../src/watch/incidents.ts";
import { lockdownOff, lockdownOn } from "../../src/watch/lockdown.ts";
import { askWatch } from "../../src/watch/server.ts";
import type { Parsed } from "../args.ts";
import { REPO } from "../services/paths.ts";
import { color, fail, info, ok, print, section, table } from "../ui.ts";

const dataDir = (): string => resolve(process.env.EDMUND_DATA_DIR ?? resolve(REPO, "data"));

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129_600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
};

function incidentsOnDisk(): Incident[] {
  try {
    const byId = new Map<string, Incident>();
    for (const line of readFileSync(join(watchDir(dataDir()), "incidents.jsonl"), "utf8").split(
      "\n",
    )) {
      if (!line.trim()) continue;
      try {
        const incident = JSON.parse(line) as Incident;
        byId.set(incident.id, incident);
      } catch {}
    }
    return [...byId.values()].sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

type Status = {
  ok: boolean;
  mode: string;
  counts: { calls: number; trips: number; held: number; refused: number; judged: number };
  slowest_ms: number;
  open: { id: string; at: number; kind: string; what: string }[];
};

export async function watchCommand(p: Parsed): Promise<void> {
  const [sub, arg] = p.positional;
  const address = readWatchAddress(dataDir());
  const state = readWatchState(dataDir());

  if (!sub || sub === "status") {
    const status = (await askWatch(address, "status", {}, 5_000)) as Status | null;
    section("security watch");
    if (!status?.ok) {
      info("the daemon's watch is not answering (the daemon is down, or [watch] mode is off).");
    } else {
      print(`  mode        ${status.mode}`);
      print(
        `  since start ${status.counts.calls} tool calls, ${status.counts.trips} trips, ` +
          `${status.counts.held} held for the judge, ${status.counts.refused} refused, ` +
          `${status.counts.judged} judged`,
      );
      print(`  slowest     ${status.slowest_ms} ms for one call (a held call waits for the judge)`);
    }
    print(
      `  lockdown    ${state.lockdown ? color.red(`ON since ${ago(state.lockdown.since)}, by ${state.lockdown.by}`) : "off"}`,
    );
    const paused = Object.entries(state.paused);
    print(`  paused      ${paused.length === 0 ? "no chats" : ""}`);
    for (const [chat, why] of paused) print(`    ${chat}  ${ago(why.since)}: ${why.why}`);
    print(`  allowed     ${Object.keys(state.allowed).length} shapes the operator said are fine`);
    const open = incidentsOnDisk().filter((i) => i.status === "open");
    print(
      `  open        ${open.length} incidents${open.length > 0 ? " (edmund watch incidents)" : ""}`,
    );
    return;
  }

  if (sub === "incidents") {
    const all = incidentsOnDisk().slice(0, 40);
    if (all.length === 0) {
      info("no incidents on record.");
      return;
    }
    table(
      ["id", "when", "tier", "status", "what"],
      all.map((i) => [
        i.id,
        ago(i.at),
        i.tier,
        i.status,
        `${i.what.slice(0, 90)}${i.what.length > 90 ? "…" : ""}`,
      ]),
    );
    return;
  }

  if (sub === "ok" || sub === "undo") {
    if (!arg) return fail(`which incident? edmund watch ${sub} <id>`);
    const res = (await askWatch(address, "answer", { id: arg, word: sub })) as {
      ok: boolean;
      did?: string[];
      error?: string;
    } | null;
    if (!res) return fail("the daemon's watch is not answering.");
    if (!res.ok) return fail(res.error ?? "that did not work.");
    ok(
      `${sub.toUpperCase()} ${arg.toUpperCase()}: ${(res.did ?? []).join("; ") || "nothing needed reversing"}`,
    );
    return;
  }

  if (sub === "drill") {
    info(
      "running four scenarios through the live watch; the stray listener can take half a minute…",
    );
    const res = (await askWatch(address, "drill", { by: "the command line" }, 180_000)) as {
      ok: boolean;
      mode: string;
      results: {
        scenario: string;
        raised: boolean;
        contained: boolean;
        ms: number;
        detail: string;
      }[];
    } | null;
    if (!res?.ok) return fail("the daemon's watch is not answering.");
    const enforcing = res.mode === "enforce";
    let failed = 0;
    for (const r of res.results) {
      const good = r.raised && (r.contained || !enforcing) && r.ms <= 60_000;
      if (!good) failed++;
      print(
        `  ${good ? color.green("ok  ") : color.red("FAIL")} ${r.scenario}: ${r.detail} (${(r.ms / 1000).toFixed(1)} s)`,
      );
    }
    if (!enforcing) info("observe mode: raised is all that is asked of it; nothing is stopped.");
    if (failed > 0) {
      fail(`${failed} of ${res.results.length} failed. A drill that fails is a bug.`);
      process.exitCode = 1;
    } else
      ok(
        `${res.results.length} of ${res.results.length} passed. The operator was texted the result.`,
      );
    return;
  }

  if (sub === "resume") {
    const targets = arg ? [arg] : Object.keys(state.paused);
    if (targets.length === 0) {
      info("no chat is paused.");
      return;
    }
    // The flag is a file every process reads, so this works with the daemon down too.
    updateWatchState(dataDir(), (s) => {
      for (const t of targets) delete s.paused[t];
    });
    ok(`resumed: ${targets.join(", ")}`);
    return;
  }

  fail("usage: edmund watch [status | incidents | ok <id> | undo <id> | resume [chat] | drill]");
  process.exitCode = 2;
}

export async function lockdownCommand(p: Parsed): Promise<void> {
  const word = p.positional[0];
  if (word !== undefined && word !== "off" && word !== "on") {
    fail("usage: edmund lockdown [off]");
    process.exitCode = 2;
    return;
  }
  const off = word === "off";
  const address = readWatchAddress(dataDir());
  type Result = { ok?: boolean; changed: boolean; did: string[] };
  let result = (await askWatch(address, off ? "lockdown-off" : "lockdown", {
    by: "the command line",
  })) as Result | null;
  if (!result) {
    // No daemon: set the flag and close the tunnels from here. There are no
    // warm workers to empty, and the next daemon reads the flag at start.
    const deps = { dataDir: dataDir(), repoRoot: REPO };
    result = off
      ? await lockdownOff(deps, "the command line")
      : await lockdownOn(deps, "the command line");
  }
  section(off ? "lockdown off" : "lockdown");
  for (const line of result.did) print(`  ${line}`);
  if (!off && result.changed) info("`edmund lockdown off` puts it back.");
}
