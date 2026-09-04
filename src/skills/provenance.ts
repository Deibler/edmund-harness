/**
 * Where a skill came from — the single classifier.
 *
 * Provenance decides what a reader may assume and what a caller may do: a
 * system skill shipped with Edmund and was reviewed; a curated one he wrote
 * himself from a pattern across conversations, unreviewed; a public one
 * belongs to a person and needs their reader's agreement; a chat's own skill
 * is the only kind that chat may rewrite or publish.
 *
 * It lives here rather than in either consumer because it has two of them —
 * the model's `list_skills` and the portal's browse page — and a
 * classification that disagrees between what the model is told and what the
 * person is shown is worse than no classification at all. `categoryOf` in
 * installer.ts answers "what kind of record is this"; this answers the
 * question that depends on WHO is asking.
 */

import type { SessionKey } from "../sessions/key.ts";
import { type InstallRecord, categoryOf } from "./installer.ts";

export type SkillGroup = "yours" | "public" | "curated" | "system";

export const SKILL_GROUPS: SkillGroup[] = ["yours", "public", "curated", "system"];

/** What the model is told each group means, in `list_skills`. */
export const GROUP_BLURB: Record<SkillGroup, string> = {
  yours:
    "written in THIS conversation — the only ones you may rewrite with update_skill or offer to publish",
  public:
    "another person published these; the first use in a chat needs their reader's agreement unless the author is present",
  curated:
    "you wrote these yourself from a job that kept recurring across unrelated conversations — no permission needed",
  system: "the standard kit that ships with Edmund",
};

/**
 * Classify one skill for one conversation.
 *
 * `sessionKey` is load-bearing: the same published skill is "yours" to its
 * author and "public" to everyone else, and that difference is exactly what
 * decides whether a consent ask is coming.
 */
export function skillGroupOf(
  record: InstallRecord | undefined,
  sessionKey: SessionKey,
): SkillGroup {
  const category = categoryOf(record);
  // No record at all means it was in skills/ before any of this existed —
  // the pre-shipped catalogue.
  if (!record || !category) return "system";

  const owner = record.origin_scope ?? record.scope;
  if (category === "public") return owner === sessionKey ? "yours" : "public";
  if (category === "curated") return "curated";
  if (category === "self") return owner === sessionKey ? "yours" : "system";
  return "system";
}
