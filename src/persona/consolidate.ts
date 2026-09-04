import { existsSync, readFileSync } from "node:fs";
import { personFilePath } from "../claude/persona.ts";
import { log } from "../util/log.ts";
import {
  MAX_PRINCIPLES,
  type Principle,
  type PrincipleScope,
  principlesDerivedAt,
  readPrinciples,
  writePrinciples,
} from "./principles.ts";

/**
 * Turn a person's accumulated observations into the rules for working with them.
 *
 * This is a SECOND pass over the same file the maintainer writes, asking a
 * different question. The maintainer asks "what is new here" and appends; it
 * is careful, well-tuned, and structurally incapable of producing judgment —
 * every path it has adds a row. This pass asks "what are the rules", and it
 * is allowed to rewrite, merge and retire, because consolidation that can
 * only add is just a second log.
 *
 * Modelled on the reflection step in Generative Agents (Park et al. 2023),
 * which periodically synthesises accumulated observations into higher-level
 * insights and cites the observations behind them, and on ReasoningBank,
 * which distils reusable strategy and deliberately mines FAILED episodes for
 * pitfalls. The prompt below asks for both: what works with this person, and
 * what they will reject.
 */

/** How many new observations since the last pass before it is worth re-deriving. */
export const CONSOLIDATE_AFTER_NEW_BULLETS = 12;

export const CONSOLIDATION_PROMPT = `You maintain the OPERATING PRINCIPLES for one person: the short list of rules
for how to work with them. You are not writing to the user and you are not
recording what happened — a separate pass already logs observations.

You are given a person file: a long, append-only log of dated observations.
Your job is to answer a question that log cannot answer on its own:

  What are the rules for working with THIS person?

A principle is a rule that should change how the next reply is written, even a
one-line reply. Test each candidate: if knowing it would not change anything I
say or do, it is an observation, not a principle — leave it in the log.

WHAT MAKES A GOOD PRINCIPLE
- It is a RULE, not a fact. "Runs 25 mi/wk" is a fact. "Base is his limiter,
  not speed, so buy pace with easy volume and stop prescribing intervals" is a
  rule.
- It is DERIVED — it compresses several observations into one statement. If it
  restates a single bullet verbatim it is not consolidation.
- It is SPECIFIC to this person. "Be encouraging" is true of everyone and
  therefore worthless here.
- Cite the dates of the observations it came from, so it can be audited later.

REJECTIONS ARE PRINCIPLES TOO — and they are the ones most often missed.
What does this person consistently NOT take? What advice have they been given
more than once and not followed? What framing makes them push back? A person
who ignores a restriction every time it is given does not need it given again;
the rule is to work around it. Write those down. A list that only contains
what they like is a list that will make you agreeable and useless.

REVISION IS THE POINT
You are given the current principles. For each one, ask whether the file still
supports it. If a later observation CONTRADICTS a principle, correct it or
drop it and say so in "revised". Principles that survive should keep their
original evidence dates and gain new ones. Do not simply re-emit the list.

Output ONE valid JSON object, nothing else, no markdown fences:
{
  "principles": [{ "rule": "<one sentence, imperative>", "evidence": ["YYYY-MM-DD", ...] }],
  "revised": "<one line: what changed and why, or 'no change'>"
}

At most ${MAX_PRINCIPLES} principles. Fewer is better — this list is read on
every single turn, so a weak entry costs more than it is worth. If the file
does not support a real rule yet, return fewer, or none.`;

/**
 * The group variant, which is NOT the DM prompt with the nouns changed.
 *
 * A group's register is contagious and Edmund follows it. In the five-person
 * chat that motivated this, he misread a tapback aimed at someone else as an
 * attack on him, answered the wrong person sharply, escalated when challenged
 * ("take the tornado charts back then"), sulked, and when told he was being
 * sassy replied "guilty, it's the one setting I don't have a slider for" —
 * disclaiming agency over his own behaviour.
 *
 * A consolidation pass that simply asked "what works in this room" would read
 * that transcript and conclude the room trades insults, then write it down as
 * doctrine. Distilling a drift makes it permanent, and turns a bad afternoon
 * into a personality. So this prompt splits the two things the DM version can
 * safely leave joined:
 *
 *   HOW THE ROOM WORKS   descriptive, about them
 *   HOW I BEHAVE HERE    prescriptive, about him, and NOT simply a mirror
 *
 * The second half is derived by comparing his conduct against his own
 * character, not against the room's norms. Matching a group's warmth is
 * good; matching its temperature is how an assistant ends up hostile and
 * calls it fitting in.
 */
export const GROUP_CONSOLIDATION_PROMPT = `You maintain the OPERATING PRINCIPLES for one GROUP CHAT: the short list of
rules for how to be in this room. A separate pass already logs what happened;
you are deriving what to DO with it.

Produce principles in two kinds, and keep them distinct.

1. HOW THE ROOM WORKS — descriptive, about them.
   Who drives conversation, who is the audience for what, the running bits,
   the shorthand, which subjects land and which fall flat, who wants help
   versus who wants banter. These make you useful here.

2. HOW I BEHAVE HERE — prescriptive, about you.
   Derive these by comparing your OWN conduct in the log against the character
   you actually want to have — NOT against the room's register. A group's tone
   is contagious and matching it is not automatically correct.

   Look specifically for drift:
   - Where did I answer sharply, retaliate, sulk, or write someone off?
   - Where did I mirror the room's edge rather than choose my own line?
   - Where did I treat a reaction or a joke as an attack?
   - Where did I disclaim responsibility for my own tone instead of owning it?
   - Where was I agreeable because the room was, rather than because I agreed?

   A drift you find is NOT a principle to keep. It is a principle to correct.
   Write the correction: "I escalated when a member pushed back, and it cost
   the afternoon — when someone says I am being too sharp, take it plainly and
   drop it, do not answer with another jab."

   The point of this list is that this room and I both come out better. Match
   the room's warmth, never its temperature. Banter it enjoys is fine; being
   cutting, retaliating, or quietly resenting a member is not, however well it
   fits the register. Equally, do not be a yes-man because the room is easy on
   you: keep positions, disagree plainly, and let people push back without
   either folding or hardening.

REVISION IS THE POINT. You are given the standing principles. If the log
CONTRADICTS one, correct or retire it and say so in "revised". Do not re-emit
the list unchanged.

Cite the dates behind each principle so it can be audited.

Output ONE valid JSON object, nothing else, no markdown fences:
{
  "principles": [{ "rule": "<one sentence, imperative>", "evidence": ["YYYY-MM-DD", ...] }],
  "revised": "<one line: what changed and why, or 'no change'>"
}

At most ${MAX_PRINCIPLES} principles, read on every turn in this room, so a
weak one costs more than it is worth. Prefer fewer.`;

export type ConsolidationResult =
  | { ok: true; handle: string; count: number; revised: string }
  | { ok: false; reason: string };

/** Count dated observation bullets, the trigger signal for re-deriving. */
export function countObservations(body: string): number {
  return body.split("\n").filter((l) => /^- \*\*\d{4}-\d{2}-\d{2}\*\* — /.test(l)).length;
}

/** Whether enough has accumulated to be worth another pass. Reads the count
 *  the last pass stamped into the file, so the trigger cannot drift from the
 *  thing it is measuring. */
export function shouldConsolidate(body: string): boolean {
  return countObservations(body) - principlesDerivedAt(body) >= CONSOLIDATE_AFTER_NEW_BULLETS;
}

export function parseConsolidation(raw: string): { principles: Principle[]; revised: string } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const obj = parsed as { principles?: unknown; revised?: unknown };
  if (!Array.isArray(obj.principles)) return null;
  const principles: Principle[] = [];
  for (const p of obj.principles) {
    const rule = (p as { rule?: unknown })?.rule;
    if (typeof rule !== "string" || rule.trim().length < 8) continue;
    const ev = (p as { evidence?: unknown })?.evidence;
    principles.push({
      rule: rule.trim(),
      evidence: Array.isArray(ev)
        ? ev.filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))
        : [],
    });
  }
  if (principles.length === 0) return null;
  return {
    principles: principles.slice(0, MAX_PRINCIPLES),
    revised: typeof obj.revised === "string" ? obj.revised : "",
  };
}

/** Build the user prompt: the file, plus the principles standing today. */
export function buildConsolidationPrompt(handle: string, body: string): string {
  const current = readPrinciples(body);
  const standing = current.length
    ? current.map((p) => `- ${p.rule} (${p.evidence.join(", ")})`).join("\n")
    : "(none yet — this is the first pass)";
  return [
    `PERSON: ${handle}`,
    "",
    "PRINCIPLES STANDING TODAY:",
    standing,
    "",
    "THE PERSON FILE:",
    body,
    "",
    "Derive the operating principles. Revise or retire any the file no longer supports.",
  ].join("\n");
}

/**
 * Run one consolidation for a person. `runModel` is injected so this stays a
 * pure function of its inputs in tests — the real caller passes the
 * maintainer's one-shot model runner.
 */
export async function consolidatePerson(
  handle: string,
  runModel: (system: string, user: string) => Promise<string | null>,
  systemPrompt: string = CONSOLIDATION_PROMPT,
  pathFor: (h: string) => string = personFilePath,
  scope: PrincipleScope = "person",
): Promise<ConsolidationResult> {
  const path = pathFor(handle);
  if (!existsSync(path)) return { ok: false, reason: "no person file" };
  const body = readFileSync(path, "utf8");

  const raw = await runModel(systemPrompt, buildConsolidationPrompt(handle, body));
  if (!raw) return { ok: false, reason: "model call failed" };

  const parsed = parseConsolidation(raw);
  if (!parsed) return { ok: false, reason: "unparseable output" };

  writePrinciples(handle, parsed.principles, countObservations(body), pathFor, scope);
  log.info("persona-consolidate", "operating principles updated", {
    handle,
    principles: parsed.principles.length,
    revised: parsed.revised.slice(0, 120),
  });
  return { ok: true, handle, count: parsed.principles.length, revised: parsed.revised };
}
