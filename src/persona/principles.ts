import { existsSync, readFileSync } from "node:fs";
import { personFilePath } from "../claude/persona.ts";
import { atomicWriteFileSync } from "../util/atomic-write.ts";

/**
 * Operating principles: the rules for working with one person.
 *
 * A person file is an append-only log of observations, and it is good at
 * that — Chris's had 105 dated entries, specific and well-grounded. But
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

function note(observedAt: number, scope: PrincipleScope): string {
  const subject =
    scope === "group"
      ? "how this room works and how I behave in it — including where my own register has drifted"
      : "working with this person, including what they will reject";
  return (
    `_(Distilled from the observations below — the rules for ${subject}. ` +
    `Revised when a conversation contradicts one. Derived at ${observedAt} observations.)_`
  );
}

/** Reads back the observation count stamped by the last pass; 0 if absent. */
export function principlesDerivedAt(body: string): number {
  const m = body.match(/Derived at (\d+) observations/);
  return m ? Number(m[1]) : 0;
}

/** Render the section body. */
export function renderPrinciples(
  principles: Principle[],
  observedAt = 0,
  scope: PrincipleScope = "person",
): string {
  const lines = [PRINCIPLES_HEADING, note(observedAt, scope), ""];
  for (const p of principles.slice(0, MAX_PRINCIPLES)) {
    const ev = p.evidence.length ? ` _(${p.evidence.join(", ")})_` : "";
    lines.push(`- ${p.rule.trim()}${ev}`);
  }
  return lines.join("\n");
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
): string {
  const path = pathFor(handle);
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const rendered = renderPrinciples(principles, observedAt, scope);
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
