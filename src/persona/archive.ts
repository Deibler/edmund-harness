import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { GROUPS_DIR, PEOPLE_DIR, PERSONA_DIR } from "../claude/persona.ts";
import { easternDate } from "../util/clock.ts";
import { log } from "../util/log.ts";
import { readPrinciples } from "./principles.ts";

/**
 * Person-file size gate: the "dynamic person file" design's mover.
 *
 * Person files are injected WHOLE into the system prompt — the right
 * pattern (a curated always-in-context core is the single most validated
 * memory design in the field), but only while the file stays small. The
 * biggest file hit 96KB (~24k tokens EVERY turn in that DM). This sweep
 * moves the OLDEST dated bullets from the history-heavy sections into
 * `persona/people/archive/<handle>.md` until the live file is back under
 * target — so the live file (still injected whole, unchanged code path)
 * becomes the core: identity + dynamic + open items + the most recent
 * history. NOTHING IS DELETED: the archive is append-only, chunk-indexed
 * for per-turn recall, and readable by the model on demand.
 *
 * Deterministic code, not an LLM pass — destructive-looking operations
 * in memory maintenance must be mechanical and auditable (research:
 * write-path LLM deletion is how systems silently lose facts).
 */

export const ARCHIVE_TRIGGER_BYTES = 8 * 1024;
export const ARCHIVE_TARGET_BYTES = 6 * 1024;
/** Never archive a section below this many most-recent dated bullets. */
export const KEEP_RECENT_BULLETS = 15;
/**
 * The retrospective floors are counts of notes the size the maintainer is
 * told to write ("Each note ≤ 140 chars"), so what such a floor protects is
 * that many notes' worth of BYTES, not that many bullets. Counted in
 * bullets, the floors outgrew the gate: notes now run 235-625 bytes on
 * average, so the protected tail alone was about five times the target, the
 * live files sat at 20-54 KB, and every pass archived a bullet or two while
 * the file stayed where it was. Those sections are history: what they
 * taught is distilled into principles, and the archive is recalled.
 */
export const NOTE_BYTES = 140;
/**
 * Open Items is not history. Each bullet may be a commitment still owed, and
 * nothing marks one closed (46 of 437 live items on 2026-10-23 used a word
 * like "done" or "shipped", mostly in passing), so size is the wrong reason
 * to drop one from the prompt. An item stays live while it is this recent,
 * up to the section's count floor; older ones go however small they are.
 * The cap keeps the busiest chat (about 4.4 items a day) where it was rather
 * than growing it, and expiry is what keeps the tail bounded.
 */
export const OPEN_ITEM_DAYS = 14;
/** Sections protected by age instead of by bytes. */
const AGE_PROTECTED_SECTIONS = new Map([["Open Items", OPEN_ITEM_DAYS]]);
/** However long they are, a section's newest few bullets stay live. */
export const MIN_RECENT_BULLETS = 3;
/** Per-section overrides of the recency floor. Open Items reads as history
 *  but each bullet may still be a live commitment, so it keeps a much
 *  deeper tail in the live file than the purely retrospective sections. */
export const SECTION_KEEP_RECENT = new Map<string, number>([
  // Open Items reads as history but each bullet may still be a live
  // commitment, and nothing ever closes one — it keeps a much deeper tail.
  ["Open Items", 40],
  // Our Dynamic keeps a short tail: the durable half is already a principle
  // by the time this section becomes archivable, and what is left is the
  // recent texture that has not been distilled yet.
  ["Our Dynamic", 8],
]);

/** The append-heavy sections. Open Items sits here despite naming itself
 *  curated: nothing ever closes an item, so it grew to ~66% of the largest
 *  person files and pinned them 7-8x above ARCHIVE_TARGET_BYTES — the gate
 *  could never reach its target while the dominant section was exempt.
 *  Identity and dynamic still always stay live. */
const PERSON_ARCHIVABLE_SECTIONS = new Set([
  "What I've Learned",
  "Shared History",
  "Open Items",
]);

/**
 * The archivable sections for a person file, given its current contents.
 *
 * "Our Dynamic" is the principles in undistilled form — "he pings until
 * answered", "his own cut ships", "gives targeted edit notes" are all rules
 * once consolidation has run, and keeping both the rule and the observations
 * it was derived from pays twice for the same knowledge in a file that is
 * injected whole on every turn.
 *
 * But it is only safe to archive once those rules actually exist. Before
 * consolidation has run for someone there is nothing carrying that knowledge
 * forward, so the section stays live and this returns the base set. The
 * ordering that guarantees it — consolidate, then archive — lives in the
 * maintainer.
 *
 * "Who They Are" is never archivable at all. Identity, medical history and
 * methodology are not things a behavioural rule encodes, and losing them from
 * the live file would cost exactly the specificity the person file exists for.
 */
export function personArchivableSections(body: string): Set<string> {
  const sections = new Set(PERSON_ARCHIVABLE_SECTIONS);
  if (readPrinciples(body).length > 0) sections.add("Our Dynamic");
  return sections;
}

/** Group files: dated observations pile up in Group Dynamic and Shared
 *  History. Open Items joined them for the reason it did in person files:
 *  nothing closes an item, and it was the largest section of the biggest
 *  group files (87 bullets, 46% of one; 55% of another) while exempt from
 *  the gate. Who's In It and Recurring Topics stay live. */
const GROUP_ARCHIVABLE_SECTIONS = new Set(["Group Dynamic", "Shared History", "Open Items"]);

/** SOUL.md's evolving-character subsections: Edmund's notes about HIMSELF,
 *  appended by `appendSelfNote` and pruned by nothing. The same unbounded
 *  append shape as Open Items, but injected on every turn of every
 *  conversation rather than in one DM. "Other durable context" is the
 *  catch-all and grew fastest — 6 entries in May, 95 in August alone. */
const SELF_ARCHIVABLE_SECTIONS = new Set([
  "Other durable context",
  "Opinions and positions you hold",
  "Tastes you've developed",
  "Things that annoy you",
  "Running bits and shorthand",
]);

const DATED_BULLET_RE = /^- \*\*(\d{4}-\d{2}-\d{2})\*\* — /;

const ARCHIVE_NOTE_RE = /older entries archived/;

export type ArchiveResult = { moved: number; liveBytes: number };

/**
 * Move aged bullets out of one oversized live file. Returns null when the
 * file is under the trigger (the common case — most files never archive).
 * `baseDir` is injectable for tests; production uses PEOPLE_DIR (people)
 * or GROUPS_DIR (groups, via archiveGroupFile / sweepGroupArchives).
 */
export function archivePersonFile(
  liveName: string,
  baseDir = PEOPLE_DIR,
  archivableSections: Set<string> = PERSON_ARCHIVABLE_SECTIONS,
  nowMs = Date.now(),
): ArchiveResult | null {
  const livePath = join(baseDir, liveName);
  if (!existsSync(livePath)) return null;
  const raw = readFileSync(livePath, "utf8");
  if (Buffer.byteLength(raw, "utf8") <= ARCHIVE_TRIGGER_BYTES) return null;

  const lines = raw.split("\n");

  // Map every line to its section, and collect dated bullets in
  // archivable sections.
  type Bullet = { line: number; date: string; section: string };
  const bullets: Bullet[] = [];
  let section = "";
  const sectionOf: string[] = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    // 2+ hashes. SOUL.md's evolving-character sections are `###` under a
    // `## Your evolving character` parent, and `^##\s+` silently skips them:
    // it matches the first two hashes and then wants whitespace where the
    // third hash is. Those subsections were invisible to this sweep, which is
    // how "Other durable context" reached 20.5k tokens — half of Edmund's
    // entire system prompt, on every turn of every conversation — while the
    // size gate reported nothing to do.
    const h = lines[i]!.match(/^#{2,}\s+(.+?)\s*$/);
    if (h) section = h[1]!;
    sectionOf[i] = section;
    if (archivableSections.has(section)) {
      const m = lines[i]!.match(DATED_BULLET_RE);
      if (m) bullets.push({ line: i, date: m[1]!, section });
    }
  }
  if (bullets.length === 0) return null;

  // Per-section recency floor: the newest bullets of each section are never
  // candidates, whatever the size pressure — up to `keep` of them, as long as
  // they fit in `keep` notes' worth of bytes (NOTE_BYTES) or, for Open Items,
  // are younger than OPEN_ITEM_DAYS; never fewer than MIN_RECENT_BULLETS.
  // Every floor is bounded (a count, and bytes or age), so whatever is not in
  // one can always move. For a busy chat the protected tails alone sit above
  // ARCHIVE_TARGET_BYTES; the gate then archives everything else and the
  // file holds at that bound instead of growing.
  const today = easternDate(new Date(nowMs));
  const bySection = new Map<string, Bullet[]>();
  for (const b of bullets) {
    const list = bySection.get(b.section) ?? [];
    list.push(b);
    bySection.set(b.section, list);
  }
  const protectedLines = new Set<number>();
  for (const [sec, list] of bySection) {
    const keep = SECTION_KEEP_RECENT.get(sec) ?? KEEP_RECENT_BULLETS;
    const newestFirst = [...list].sort((a, b) => (a.date < b.date ? 1 : -1));
    let used = 0;
    const maxAgeDays = AGE_PROTECTED_SECTIONS.get(sec);
    for (const [i, b] of newestFirst.entries()) {
      if (i >= keep) break;
      const size = Buffer.byteLength(lines[b.line]!, "utf8") + 1;
      const fits =
        maxAgeDays === undefined
          ? used + size <= keep * NOTE_BYTES
          : daysBetween(b.date, today) <= maxAgeDays;
      if (i >= MIN_RECENT_BULLETS && !fits) break;
      protectedLines.add(b.line);
      used += size;
    }
  }

  // Oldest-first candidates across both sections; move until the live
  // file projects under target.
  const candidates = bullets
    .filter((b) => !protectedLines.has(b.line))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  let liveBytes = Buffer.byteLength(raw, "utf8");
  const movedLines = new Set<number>();
  for (const b of candidates) {
    if (liveBytes <= ARCHIVE_TARGET_BYTES) break;
    movedLines.add(b.line);
    liveBytes -= Buffer.byteLength(lines[b.line]!, "utf8") + 1;
  }
  if (movedLines.size === 0) return null;

  // Archive append: moved bullets grouped under their section headings,
  // original order preserved (they're chronological already).
  const bySectionMoved = new Map<string, string[]>();
  for (const sec of archivableSections) {
    const moved = [...movedLines].filter((i) => sectionOf[i] === sec).sort((a, b) => a - b);
    if (moved.length > 0) bySectionMoved.set(sec, moved.map((i) => lines[i]!));
  }
  appendToArchive(livePath, raw, bySectionMoved, "archived");

  // Rewrite the live file without the moved lines; leave one pointer note
  // per section that actually LOST bullets, so the model knows the deep
  // history exists. Keyed on what moved rather than on what is archivable:
  // a section that kept everything has no archive to point at, and saying
  // otherwise sends the model looking for history that isn't there.
  const movedSections = new Set([...movedLines].map((i) => sectionOf[i]!));
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (movedLines.has(i)) continue;
    kept.push(lines[i]!);
    const h = lines[i]!.match(/^#{2,}\s+(.+?)\s*$/);
    if (h && movedSections.has(h[1]!)) {
      // Insert the pointer right under the heading if not already there.
      const next = lines[i + 1] ?? "";
      if (!ARCHIVE_NOTE_RE.test(next)) {
        kept.push(
          `_(older entries archived to archive/${liveName} — auto-recalled when relevant; searchable via memory_search)_`,
        );
      }
    }
  }
  writeFileSync(livePath, kept.join("\n"));

  log.info("persona-archive", `archived aged bullets from ${liveName}`, {
    moved: movedLines.size,
    live_bytes: liveBytes,
  });
  return { moved: movedLines.size, liveBytes };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The archive file that belongs to a live file: `<dir>/archive/<name>`. */
export function archivePathFor(livePath: string): string {
  return join(dirname(livePath), "archive", basename(livePath));
}

/** Dated observations already moved out of a live file into its archive. */
export function archivedObservationCount(livePath: string): number {
  return archivedBullets(livePath).length;
}

function archivedBullets(livePath: string): string[] {
  const p = archivePathFor(livePath);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => DATED_BULLET_RE.test(l));
}

/**
 * Archived observations dated on or after `since` (all of them when null),
 * newest first up to `maxBytes`, returned oldest first. What the size gate
 * moved out before the consolidator could read it.
 */
export function archivedObservationsSince(
  livePath: string,
  since: string | null,
  maxBytes: number,
): string[] {
  const dated = archivedBullets(livePath)
    .map((line) => ({ line, date: line.match(DATED_BULLET_RE)![1]! }))
    .filter((b) => since === null || b.date >= since)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const out: string[] = [];
  let used = 0;
  for (const b of dated) {
    used += Buffer.byteLength(b.line, "utf8") + 1;
    if (used > maxBytes) break;
    out.push(b.line);
  }
  return out.reverse();
}

function appendToArchive(
  livePath: string,
  liveBody: string,
  bySection: Map<string, string[]>,
  verb: string,
): void {
  if (bySection.size === 0) return;
  const title =
    liveBody.match(/^#\s+(.+?)\s*$/m)?.[1] ?? basename(livePath).replace(/\.md$/, "");
  const archivePath = archivePathFor(livePath);
  mkdirSync(dirname(archivePath), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const parts: string[] = [];
  if (!existsSync(archivePath)) {
    parts.push(
      `# ${title} — archived history`,
      "",
      "_Aged out of the live profile by the size gate. Append-only — nothing is ever deleted. Indexed for recall; also readable directly._",
    );
  }
  for (const [sec, bullets] of bySection) {
    parts.push("", `## ${sec} (${verb} ${stamp})`, ...bullets);
  }
  parts.push("");
  appendFileSync(archivePath, `${parts.join("\n")}\n`);
}

/**
 * Fit a rewrite to the file as it is NOW.
 *
 * The maintainer's model call takes 30-180 s, and the live turn can append a
 * note meanwhile (`remember_about_person`). The rewrite was produced from the
 * snapshot, so those notes are not in it. Bullets appended since the
 * snapshot are merged into the rewrite under their section. Any other change
 * (an edit or a removal, e.g. the model honouring "forget that") makes the
 * rewrite stale: null, and the caller must not write it.
 */
export function reconcileRewrite(snapshot: string, latest: string, rewrite: string): string | null {
  const meaningful = (body: string) =>
    body.split("\n").filter((l) => l.trim() && !/^_\(.*\)_$/.test(l.trim()));
  const before = meaningful(snapshot);
  const known = new Set(before);
  const appended: { line: string; section: string }[] = [];
  const rest: string[] = [];
  let section = "";
  for (const line of meaningful(latest)) {
    const h = line.match(/^#{2,}\s+(.+?)\s*$/);
    if (h) section = h[1]!;
    if (DATED_BULLET_RE.test(line) && !known.has(line)) appended.push({ line, section });
    else rest.push(line);
  }
  if (rest.length !== before.length || rest.some((l, i) => l !== before[i])) return null;

  const lines = rewrite.split("\n");
  for (const a of appended) {
    const heading = lines.findIndex((l) => l.match(/^#{2,}\s+(.+?)\s*$/)?.[1] === a.section);
    if (heading === -1) {
      lines.push("", `## ${a.section}`, a.line);
      continue;
    }
    let end = heading + 1;
    while (end < lines.length && !/^#{1,6}\s/.test(lines[end]!)) end++;
    while (end > heading + 1 && !lines[end - 1]!.trim()) end--;
    lines.splice(end, 0, a.line);
  }
  return lines.join("\n");
}

/**
 * Archive the dated observations a full rewrite is about to drop.
 *
 * The maintainer's full rewrite replaced the file wholesale and kept the old
 * version only as `<file>.bak`, which the next rewrite overwrites. On
 * 2026-10-22 two rewrites dropped 45 of 98 and 41 of 91 bullets that were
 * then in neither the live file nor the archive. A bullet the rewrite kept
 * verbatim stays where it is; anything else that was a dated observation
 * goes to the archive under its old section, so recall can still reach it.
 * Matching is by exact line, so a bullet the rewrite reworded is archived in
 * its old wording beside the new one: a near-duplicate in recall, never a
 * loss. `oldBody` must be the file as it is when the rewrite is written (see
 * reconcileRewrite), not the snapshot the model was shown.
 *
 * Only for the maintainer's housekeeping rewrite. A model-requested write
 * (`write_person_file`) may be removing something the person asked it to
 * forget, and archiving that would bring it back through recall.
 */
export function archiveRewriteDrops(livePath: string, oldBody: string, newBody: string): number {
  const kept = new Set(newBody.split("\n"));
  const dropped = new Map<string, string[]>();
  let section = "";
  let count = 0;
  for (const line of oldBody.split("\n")) {
    const h = line.match(/^#{2,}\s+(.+?)\s*$/);
    if (h) section = h[1]!;
    if (!DATED_BULLET_RE.test(line) || kept.has(line)) continue;
    const list = dropped.get(section) ?? [];
    list.push(line);
    dropped.set(section, list);
    count++;
  }
  appendToArchive(livePath, oldBody, dropped, "removed by rewrite");
  if (count > 0) {
    log.info("persona-archive", `archived bullets a rewrite dropped from ${basename(livePath)}`, {
      moved: count,
    });
  }
  return count;
}

/** Group-file variant: same mover, group section names, GROUPS_DIR. */
export function archiveGroupFile(
  liveName: string,
  baseDir = GROUPS_DIR,
  nowMs = Date.now(),
): ArchiveResult | null {
  return archivePersonFile(liveName, baseDir, GROUP_ARCHIVABLE_SECTIONS, nowMs);
}

/**
 * Archive SOUL.md's evolving-character sections.
 *
 * SOUL.md is not a person file: it is injected into EVERY turn of EVERY
 * conversation, so a token spent here is spent everywhere. It had reached
 * 25.3k tokens, 20.5k of which was a single "Other durable context" section
 * of 90 bullets averaging 940 characters — self-notes written as essays.
 * That is roughly 13% of a median turn's context, permanently, describing
 * project detail from months earlier.
 *
 * Archived bullets go to `persona/archive/SOUL.md`, which the recall indexer
 * indexes globally (see indexSelfFiles) so nothing becomes unreachable — the
 * live file keeps the recent tail and a pointer, and the rest stays
 * searchable. Nothing is deleted.
 */
export function archiveSelfFile(
  liveName = "SOUL.md",
  baseDir = PERSONA_DIR,
): ArchiveResult | null {
  return archivePersonFile(liveName, baseDir, SELF_ARCHIVABLE_SECTIONS);
}

/** Boot/idle sweep across every live person file. */
export function sweepPersonArchives(
  baseDir = PEOPLE_DIR,
  archivableSections: Set<string> = PERSON_ARCHIVABLE_SECTIONS,
): { files: number; moved: number } {
  if (!existsSync(baseDir)) return { files: 0, moved: 0 };
  let files = 0;
  let moved = 0;
  for (const f of readdirSync(baseDir)) {
    if (!f.endsWith(".md")) continue;
    const p = join(baseDir, f);
    try {
      if (!statSync(p).isFile()) continue;
      const r = archivePersonFile(f, baseDir, archivableSections);
      if (r) {
        files++;
        moved += r.moved;
      }
    } catch (err) {
      log.warn("persona-archive", "sweep failed for file", {
        file: f,
        err: (err as Error).message,
      });
    }
  }
  return { files, moved };
}

/** Boot/idle sweep across every live group file. */
export function sweepGroupArchives(baseDir = GROUPS_DIR): { files: number; moved: number } {
  return sweepPersonArchives(baseDir, GROUP_ARCHIVABLE_SECTIONS);
}

/**
 * The boot sweep: person files, group files and SOUL.md. One entry point so
 * the daemon cannot run two of the three again. It ran people and groups
 * only, archiveSelfFile had no caller outside its tests, and SOUL.md went
 * from 31 KB to 43 KB of every system prompt in the month after the gate for
 * it was written.
 */
export function sweepAllArchives(
  dirs: { people: string; groups: string; persona: string } = {
    people: PEOPLE_DIR,
    groups: GROUPS_DIR,
    persona: PERSONA_DIR,
  },
): { files: number; moved: number } {
  const people = sweepPersonArchives(dirs.people);
  const groups = sweepGroupArchives(dirs.groups);
  const self = archiveSelfFile("SOUL.md", dirs.persona);
  return {
    files: people.files + groups.files + (self ? 1 : 0),
    moved: people.moved + groups.moved + (self?.moved ?? 0),
  };
}
