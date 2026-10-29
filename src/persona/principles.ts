import { existsSync, readFileSync } from "node:fs";
import { personFilePath } from "../claude/persona.ts";
import { atomicWriteFileSync } from "../util/atomic-write.ts";

/**
 * Operating principles: the rules for working with one person.
 *
 * A person file is an append-only log of observations, and it is good at
 * that — one person's had 105 dated entries, specific and well-grounded. But
 * nothing ever turned them into judgment. Three separate entries circled
 * "his own cut always ships" without becoming it; two noted he trains
 * through restrictions without becoming "stop prescribing prohibitions".
 *
 * That distinction decides how a reply reads. Observations only enter a
 * turn through semantic recall, so the two thirds of turns that are short
 * reactions get none of them and sound generic. Principles are small enough
 * to sit in the prompt permanently, so they shape EVERY reply including the
 * one-liners — which is the difference between an assistant that accumulates
 * facts about someone and one that has learned how to talk to them.
 *
 * The shape follows the literature rather than being invented here:
 * Generative Agents (Park et al. 2023) generates periodic REFLECTIONS that
 * synthesise observations into higher-level insights and cites the
 * observations they came from; ablating reflection collapsed the agents'
 * emergent behaviour. Google's ReasoningBank stores distilled strategy as
 * title + content and, importantly, mines FAILURES for "counterfactual
 * signals and pitfalls" rather than only recording what worked. Both ideas
 * are load-bearing here: a principle carries its evidence dates so it can be
 * audited and revised, and principles about what someone will REJECT are
 * explicitly wanted — that is the structural opposite of a yes-man.
 */

export const PRINCIPLES_HEADING = "## Operating Principles";

/** Hard cap. The value of this section is that it is short enough to be read
 *  every turn; a long one is just the observation log again. */
export const MAX_PRINCIPLES = 10;

/**
 * Caps on what a count cannot bound. With only MAX_PRINCIPLES, a pass that
 * had a new rule and no free slot folded it into a standing one, and from
 * 10-25 to 10-29 2026 (13 passes for the operator) their ten rules grew from 300-550
 * characters each to 566-1,377, the section from 3.8 KB to 10.2 KB, against
 * a design of about 610 tokens. A rule they cared about ("never ask for a print
 * yes without a rendered mockup") ended up as the fifth clause of one
 * paragraph. One rule, one sentence. With the count and the dates shown also
 * capped, the section cannot pass about 3.2 KB, so no separate total is kept.
 */
export const MAX_RULE_CHARS = 240;
/** Evidence shown per rule: the newest dates. Enough to audit a rule and see
 *  that it is current; seventeen dates on one line was 207 characters. */
export const MAX_EVIDENCE_SHOWN = 6;

export type Principle = {
  /** The rule, imperative and specific. "His cut ships — give the note, skip the recut." */
  rule: string;
  /** Dates of the observations it was distilled from, for audit and revision. */
  evidence: string[];
};

/** The observation count is stamped into the note so the next pass can tell how
 *  much has accumulated since, without a schema change and without trusting a
 *  counter that could drift from the file it describes. */
export type PrincipleScope = "person" | "group";

function note(observedAt: number, scope: PrincipleScope, on: string | null): string {
  const subject =
    scope === "group"
      ? "how this room works and how I behave in it — including where my own register has drifted"
      : "working with this person, including what they will reject";
  const when = on ? ` on ${on}` : "";
  return (
    `_(Distilled from the observations below — the rules for ${subject}. ` +
    `Revised when a conversation contradicts one. Derived at ${observedAt} observations${when}.)_`
  );
}

/** Reads back the observation count stamped by the last pass; 0 if absent. */
export function principlesDerivedAt(body: string): number {
  const m = body.match(/Derived at (\d+) observations/);
  return m ? Number(m[1]) : 0;
}

/** The date the last pass ran, when it stamped one (stamps before 2026-10-23
 *  did not); else the newest evidence date it cited; else null. */
export function principlesDerivedOn(body: string): string | null {
  const m = body.match(/Derived at \d+ observations on (\d{4}-\d{2}-\d{2})/);
  if (m) return m[1]!;
  const dates = readPrinciples(body).flatMap((p) => p.evidence);
  return dates.length ? dates.sort().at(-1)! : null;
}

/** Render the section body. */
export function renderPrinciples(
  principles: Principle[],
  observedAt = 0,
  scope: PrincipleScope = "person",
  on: string | null = null,
): string {
  return [PRINCIPLES_HEADING, note(observedAt, scope, on), "", ...principleBullets(principles)].join(
    "\n",
  );
}

/** The section's bullets as they are written to the file. */
function principleBullets(principles: Principle[]): string[] {
  return principles.slice(0, MAX_PRINCIPLES).map((p) => {
    const dates = [...p.evidence].sort().slice(-MAX_EVIDENCE_SHOWN);
    const ev = dates.length ? ` _(${dates.join(", ")})_` : "";
    return `- ${p.rule.trim()}${ev}`;
  });
}

/**
 * What a candidate list breaks of the length rules, as sentences a retry can
 * be shown. Empty when it fits.
 */
export function principleViolations(principles: Principle[]): string[] {
  const out: string[] = [];
  principles.forEach((p, i) => {
    if (p.rule.length > MAX_RULE_CHARS) {
      out.push(
        `Principle ${i + 1} is ${p.rule.length} characters (limit ${MAX_RULE_CHARS}): "${p.rule.slice(0, 80)}…"`,
      );
    }
  });
  return out;
}

/** Parse the section back out of a person file. */
export function readPrinciples(body: string): Principle[] {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === PRINCIPLES_HEADING);
  if (start === -1) return [];
  const out: Principle[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#{1,6}\s/.test(line)) break;
    const m = line.match(/^-\s+(.*?)\s*(?:_\(([^)]*)\)_)?\s*$/);
    if (!m || !m[1]) continue;
    out.push({
      rule: m[1].trim(),
      evidence: (m[2] ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean),
    });
  }
  return out;
}

/**
 * Replace the principles section wholesale.
 *
 * Deliberately a REPLACE and not an append. Appending is what produced the
 * problem this section exists to solve: consolidation that only ever adds is
 * just a second observation log with a different heading.
 *
 * Placed directly after the file's title block so it is the first thing read,
 * before the history it was derived from.
 */
export function writePrinciples(
  handle: string,
  principles: Principle[],
  observedAt = 0,
  pathFor: (h: string) => string = personFilePath,
  scope: PrincipleScope = "person",
  on: string | null = null,
): string {
  const path = pathFor(handle);
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const rendered = renderPrinciples(principles, observedAt, scope, on);
  const lines = current.split("\n");

  const start = lines.findIndex((l) => l.trim() === PRINCIPLES_HEADING);
  if (start !== -1) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^#{1,6}\s/.test(lines[i]!)) {
        end = i;
        break;
      }
    }
    const next = [...lines.slice(0, start), rendered, "", ...lines.slice(end)];
    atomicWriteFileSync(path, next.join("\n"));
    return path;
  }

  // No section yet: insert above the first `## ` heading, so principles are
  // read before the observations they summarise.
  const firstHeading = lines.findIndex((l) => /^##\s/.test(l));
  const at = firstHeading === -1 ? lines.length : firstHeading;
  const next = [...lines.slice(0, at), rendered, "", ...lines.slice(at)];
  atomicWriteFileSync(path, next.join("\n"));
  return path;
}
