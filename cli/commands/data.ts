/**
 * `edmund data audit` and `edmund data clean [--apply]`.
 *
 * The data folder holds every subsystem's state. `audit` lists what is at the
 * top of it against the declared layout (src/util/data-layout.ts): what each
 * entry is and who writes it, what belongs to a removed feature, what is a
 * backup somebody made by hand, and what nothing accounts for.
 *
 * `clean` shows what it would move aside; `--apply` does it. Retired entries,
 * stale ones (undeclared, and empty or a log, and long untouched) and backups
 * older than 30 days go to `data/.trash/<day>/`, where they stay
 * 30 days; old files in a declared cache are removed. An entry the layout
 * does not know is listed and left alone, and so is a file a process has open.
 */
import { resolve } from "node:path";
import { type Finding, applyClean, auditDataDir, planClean } from "../../src/util/data-layout.ts";
import type { Parsed } from "../args.ts";
import { hasFlag } from "../args.ts";
import { REPO } from "../services/paths.ts";
import { color, fail, info, ok, print, table } from "../ui.ts";

const dataDir = (): string => process.env.EDMUND_DATA_DIR ?? resolve(REPO, "data");

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export async function dataCommand(p: Parsed): Promise<void> {
  const sub = p.positional[0] ?? "audit";
  if (sub === "audit") return audit(hasFlag(p, "all", "a"));
  if (sub === "clean") return clean(hasFlag(p, "apply"));
  fail("usage: edmund data audit [--all] | edmund data clean [--apply]");
  process.exit(1);
}

function row(f: Finding): string[] {
  const name = f.isFolder ? `${f.name}/` : f.name;
  const what =
    f.status === "known"
      ? `${f.entry!.note} ${color.dim(`(${f.entry!.owner})`)}`
      : f.status === "unknown"
        ? color.yellow("nothing in the code reads or writes this name")
        : (f.why ?? "");
  return [name, bytes(f.bytes), day(f.modifiedMs), what];
}

function audit(all: boolean): void {
  const findings = auditDataDir(dataDir());
  const of = (status: Finding["status"]) => findings.filter((f) => f.status === status);
  const total = (list: Finding[]) => list.reduce((sum, f) => sum + f.bytes, 0);
  const groups: [string, Finding["status"]][] = [
    ["Not accounted for", "unknown"],
    ["Left by something removed", "retired"],
    ["Stale and undeclared", "stale"],
    ["Backups made by hand", "backup"],
  ];
  for (const [title, status] of groups) {
    const list = of(status);
    if (list.length === 0) continue;
    print(color.bold(`${title}: ${list.length}, ${bytes(total(list))}`));
    table(["name", "size", "last written", "what"], list.map(row));
    print();
  }
  const known = of("known");
  if (all) {
    print(color.bold(`Declared: ${known.length}, ${bytes(total(known))}`));
    table(
      ["name", "size", "last written", "what"],
      [...known].sort((a, b) => b.bytes - a.bytes).map(row),
    );
  } else {
    const largest = [...known].sort((a, b) => b.bytes - a.bytes).slice(0, 8);
    print(color.bold(`Declared: ${known.length}, ${bytes(total(known))}. The largest:`));
    table(["name", "size", "last written", "what"], largest.map(row));
    print(color.dim("edmund data audit --all lists every one"));
  }
  print();
  print(`${bytes(total(findings))} in ${dataDir()}`);
  print(color.dim("edmund data clean shows what would be moved aside; --apply does it"));
}

function clean(apply: boolean): void {
  const dir = dataDir();
  const steps = planClean(dir);
  if (steps.length === 0) {
    ok("nothing to clean");
    return;
  }
  if (!apply) {
    const moves = steps.filter((s) => s.action === "trash");
    const expiries = steps.filter((s) => s.action === "expire");
    if (moves.length > 0) {
      print(color.bold(`Would move to ${resolve(dir, ".trash")}:`));
      table(
        ["name", "size", "why"],
        moves.map((s) =>
          s.action === "trash" ? [s.finding.name, bytes(s.finding.bytes), s.why] : [],
        ),
      );
      print();
    }
    if (expiries.length > 0) {
      const size = expiries.reduce((sum, s) => sum + (s.action === "expire" ? s.bytes : 0), 0);
      print(color.bold(`Would delete ${expiries.length} expired file(s), ${bytes(size)}:`));
      const reasons = new Map<string, number>();
      for (const s of expiries) reasons.set(s.why, (reasons.get(s.why) ?? 0) + 1);
      for (const [why, n] of reasons) print(`  ${n} × ${why}`);
      print();
    }
    info("nothing was changed; run edmund data clean --apply to do it");
    return;
  }
  const result = applyClean(dir, steps);
  const moved = result.trashed.reduce((sum, t) => sum + t.bytes, 0);
  const expired = result.expired.reduce((sum, e) => sum + e.bytes, 0);
  if (result.trashed.length > 0) {
    ok(`moved ${result.trashed.length} entries (${bytes(moved)}) to ${resolve(dir, ".trash")}`);
    for (const t of result.trashed) print(`  ${t.name}  ${color.dim(bytes(t.bytes))}`);
  }
  if (result.expired.length > 0)
    ok(`deleted ${result.expired.length} expired file(s), ${bytes(expired)}`);
  for (const s of result.skipped) info(`left ${s.name}: ${s.reason}`);
}
