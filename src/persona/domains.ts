import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PERSONA_DIR } from "../claude/persona.ts";
import { atomicWriteFileSync } from "../util/atomic-write.ts";
import { easternDate } from "../util/clock.ts";

/**
 * What Edmund knows about a SUBJECT, as opposed to about a person.
 *
 * Person files made him specific; nothing made him expert. Endurance-training
 * knowledge was whatever the base model already had plus whatever got searched
 * that morning, and it did not compound: an excellent piece of reasoning about
 * why a psoas that flares with mileage is weak rather than tight taught him
 * nothing he would still have in November, and the next runner starts from
 * scratch. Sixty conversations produced sixty fresh starts instead of a
 * practice.
 *
 * The shape follows ReasoningBank (Google Research, 2025), which stores
 * distilled strategy rather than transcripts and — the part that matters —
 * mines FAILED episodes for pitfalls, not just successes. So an entry records
 * what was tried, whether it worked, and with whom. "Told a runner to drop
 * lifting; ignored every time" is worth more than a citation, because it is
 * the thing an article will never tell you.
 *
 * Deliberately a TOOL rather than a background pass: a note is worth writing
 * when Edmund notices something, and only he is in a position to know that a
 * piece of advice landed or was quietly discarded.
 */

export const DOMAINS_DIR = join(PERSONA_DIR, "domains");

/** Kebab-case slug for a subject: "endurance-training", "short-form-content". */
export function domainSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function domainPath(slug: string): string {
  return join(DOMAINS_DIR, `${slug}.md`);
}

export function listDomains(): string[] {
  if (!existsSync(DOMAINS_DIR)) return [];
  return readdirSync(DOMAINS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

export function readDomain(slug: string): string {
  const p = domainPath(slug);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

export type DomainNote = {
  domain: string;
  /** The lesson, as a claim. "Psoas that flares with mileage is weak, not tight." */
  title: string;
  /** The conditions it holds under — when this applies and when it does not. */
  applies: string;
  /** What was actually observed: what was tried, and what happened. */
  learned: string;
  /** Did it work, get rejected, or is it still open? Failures are the point. */
  outcome: "worked" | "rejected" | "mixed" | "untested";
  /** Who it came from, so a claim built on one person is visible as such. */
  source?: string;
};

const OUTCOME_LABEL: Record<DomainNote["outcome"], string> = {
  worked: "WORKED",
  rejected: "REJECTED",
  mixed: "MIXED",
  untested: "UNTESTED",
};

/**
 * Append one lesson. Idempotent on the title within a domain, so restating a
 * lesson you are unsure you already recorded is safe.
 */
export function appendDomainNote(note: DomainNote): { path: string; appended: boolean } {
  const slug = domainSlug(note.domain);
  mkdirSync(DOMAINS_DIR, { recursive: true });
  const path = domainPath(slug);
  const current = existsSync(path)
    ? readFileSync(path, "utf8")
    : [
        `# ${note.domain}`,
        "",
        "_What I've learned about this subject in practice — what worked, what got",
        "rejected, and with whom. Indexed globally, so it surfaces in any conversation._",
        "",
      ].join("\n");

  const title = note.title.trim();
  if (current.includes(`### ${title}`)) return { path, appended: false };

  const block = [
    "",
    `### ${title}`,
    `- **When it applies:** ${note.applies.trim()}`,
    `- **What I learned:** ${note.learned.trim()}`,
    `- **Outcome:** ${OUTCOME_LABEL[note.outcome]}${note.source ? ` — ${note.source.trim()}` : ""}`,
    `- **Recorded:** ${easternDate()}`,
    "",
  ].join("\n");

  atomicWriteFileSync(path, `${current.trimEnd()}\n${block}`);
  return { path, appended: true };
}
