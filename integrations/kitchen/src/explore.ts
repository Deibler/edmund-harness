/**
 * The explore shelf: dishes deliberately unlike anything this house cooks.
 *
 * Every other surface is anchored to the ledger, which over time proposes only
 * what the household already knows. Explore dishes are chosen for distance from
 * that history and are not checked against stock. They are labelled as ideas to
 * shop for, never as things the house can make, and nothing here writes to the
 * ledger.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountDir } from "./accounts.ts";
import { loadCookbook } from "./cookbook.ts";
import { type Effort, type Method, loadRecipes } from "./recipes.ts";
import { live, slug } from "./store.ts";

export type ExploreDish = {
  id: string;
  name: string;
  desc: string;
  /** Where it comes from. Required: distance is the point of the shelf. */
  cuisine: string;
  /** Why it is far from what this house cooks, in a sentence. */
  why: string;
  /** Plain-English shopping. NOT ledger slugs: the house does not own these. */
  buy: string[];
  /** Things it needs that this kitchen already has, by name. */
  have: string[];
  minutes: number;
  effort: Effort;
  method: Method;
  spend: 1 | 2 | 3;
  health: number;
};

export type ExploreSet = {
  generated: string;
  /** What the set was asked for, so the page can say why these appeared. */
  theme: string | null;
  dishes: ExploreDish[];
};

function explorePath(account: string): string {
  return join(accountDir(), account, "explore.json");
}

export function readExplore(account: string): ExploreSet | null {
  const p = explorePath(account);
  if (!existsSync(p)) return null;
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as ExploreSet;
    return Array.isArray(s.dishes) ? s : null;
  } catch {
    return null;
  }
}

const EFFORTS = new Set<string>(["quick", "weeknight", "project", "allday"]);
const METHODS = new Set<string>([
  "stovetop",
  "oven",
  "sheetpan",
  "crockpot",
  "instantpot",
  "grill",
  "airfryer",
  "nocook",
]);

/**
 * The brief for writing the shelf. Built around a negative list (every dish the
 * house already cooks), which is what produces distance, plus everything owned,
 * so the shopping line does not ask for food already in the house.
 */
export function exploreBrief(account: string, theme?: string | null): string {
  const { recipes } = loadRecipes(account);
  const book = loadCookbook(account);
  const known = [...new Set([...recipes.map((r) => r.name), ...book.map((b) => b.name)])];
  const cuisines = [...new Set(recipes.map((r) => r.cuisine).filter(Boolean))] as string[];
  const owned = live(account).map((i) => i.name);
  return [
    "Every dish this household already cooks. This is the list to get AWAY from:",
    known.map((n) => `- ${n}`).join("\n"),
    cuisines.length ? `\nCuisines already represented: ${cuisines.join(", ")}.` : "",
    "",
    "EVERYTHING THEY ALREADY OWN. Nothing on this list belongs in `buy`; if a dish uses",
    "one, it goes in `have` instead (anything you get wrong is moved across on save):",
    owned.join(", ") || "(nothing tracked)",
    "",
    theme ? `They asked specifically for: ${theme}.` : "No theme: surprise them.",
    "",
    "Write eight dishes RADICALLY different from the list above: different cuisines,",
    "different techniques, different shopping. Not a variation on anything up there.",
    "Real food a competent home cook can make in a normal American kitchen with",
    "ordinary supermarket shopping, not restaurant projects that need a smoker or",
    "three days of fermentation. Vary the effort: some fast weeknight ones, at least",
    "one weekend project, at least one slow cooker. `buy` is what they must go and",
    "get, in plain shopping words; `have` is what it uses that they already own.",
    "",
    `Then kitchen_explore action:"save" with dishes:[{name, desc (one sentence, what it`,
    `is and why it is good), cuisine, why (one sentence on how it differs from what they`,
    `cook), buy:[...], have:[...], minutes, effort: quick|weeknight|project|allday,`,
    `method: stovetop|oven|sheetpan|crockpot|instantpot|grill|airfryer|nocook,`,
    `spend: 1|2|3, health: 1-5}]`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Validate and write a set. Fields are coerced because they land on a public
 * page; a dish the house already cooks is dropped, and anything on a shopping
 * line that the house owns is moved to `have`.
 */
export function saveExplore(
  account: string,
  raw: unknown[],
  theme?: string | null,
): { set: ExploreSet; dropped: string[] } {
  const { recipes } = loadRecipes(account);
  const book = loadCookbook(account);
  const known = [...new Set([...recipes.map((r) => r.name), ...book.map((b) => b.name)])];
  const owned = new Set(live(account).map((i) => slug(i.name)));

  const seen = new Set<string>();
  const dishes: ExploreDish[] = [];
  const dropped: string[] = [];
  for (const item of raw) {
    const d = (item ?? {}) as Record<string, unknown>;
    if (typeof d.name !== "string" || !d.name.trim()) continue;
    const id = slug(d.name);
    if (seen.has(id) || known.some((n) => slug(n) === id)) {
      dropped.push(d.name.trim());
      continue;
    }
    seen.add(id);
    const effort = EFFORTS.has(String(d.effort)) ? (String(d.effort) as Effort) : "weeknight";
    const method = METHODS.has(String(d.method)) ? (String(d.method) as Method) : "stovetop";
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const arr = (v: unknown) =>
      (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []).slice(0, 14);
    const buy: string[] = [];
    const have = arr(d.have);
    for (const line of arr(d.buy)) (owned.has(slug(line)) ? have : buy).push(line);
    dishes.push({
      id,
      name: d.name.trim(),
      desc: str(d.desc),
      cuisine: str(d.cuisine) || "somewhere else",
      why: str(d.why),
      buy,
      have,
      minutes: typeof d.minutes === "number" ? Math.round(d.minutes) : 45,
      effort,
      method,
      spend: d.spend === 1 || d.spend === 3 ? d.spend : 2,
      health: typeof d.health === "number" ? Math.max(1, Math.min(5, Math.round(d.health))) : 3,
    });
  }
  if (!dishes.length) throw new Error("explore: nothing usable to save");

  const set: ExploreSet = {
    generated: new Date().toISOString(),
    theme: theme ?? null,
    dishes,
  };
  mkdirSync(join(accountDir(), account), { recursive: true });
  writeFileSync(explorePath(account), JSON.stringify(set, null, 2));
  return { set, dropped };
}
