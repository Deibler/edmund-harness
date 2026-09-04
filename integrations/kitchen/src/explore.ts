/**
 * Food this house does not make.
 *
 * Every other surface in this integration is anchored to the ledger: what is
 * on the shelves, what can be cooked tonight, what was cooked before. That is
 * the right anchor and it has one failure mode, which is that a kitchen
 * gradually proposes only the things it already knows. Ten weeks of correct
 * suggestions and you are eating the same eight dinners with better labelling.
 *
 * This is the deliberate exception. It generates dishes chosen for DISTANCE
 * from the household's own history: different cuisines, different techniques,
 * different shopping. Nothing here is checked against stock, because checking
 * it against stock is precisely what would drag it back to the same eight
 * dinners.
 *
 * The honesty rule still holds, it just moves: these are labelled as ideas you
 * would have to shop for, never as things you can make, and nothing here can
 * write to the ledger. A dish only becomes real when somebody asks for the
 * recipe, and the shopping only becomes real when somebody puts it on a list.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountDir } from "./accounts.ts";
import { loadCookbook } from "./cookbook.ts";
import { openrouterKey } from "./openrouter.ts";
import { loadRecipes } from "./recipes.ts";
import type { Effort, Method } from "./recipes.ts";
import { live, slug } from "./store.ts";
import type { Account } from "./types.ts";

export type ExploreDish = {
  id: string;
  name: string;
  desc: string;
  /** Where it comes from. The whole point of the shelf, so it is required. */
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
 * Generate a set of dishes deliberately unlike this household's own.
 *
 * The prompt is built around a NEGATIVE list, which is the part that matters.
 * Asking for "interesting dinners" returns the same weeknight chicken every
 * model returns; handing over the actual catalog and saying "not these, and not
 * anything that rhymes with these" is what produces distance. The staples list
 * goes in as well, not as a constraint but so the shopping line is honest about
 * what is already in the house.
 */
export async function generateExplore(
  account: string,
  acct: Account,
  opts: { theme?: string | null; count?: number } = {},
): Promise<ExploreSet> {
  const { recipes } = loadRecipes(account);
  const book = loadCookbook(account);
  const known = [...new Set([...recipes.map((r) => r.name), ...book.map((b) => b.name)])];
  const cuisines = [...new Set(recipes.map((r) => r.cuisine).filter(Boolean))] as string[];
  // Everything on the shelves, not just the pantry. Filtering this to staples
  // meant the meat and the produce they own were invisible here, so the first
  // set told them to buy chicken breasts they already had, which is exactly the
  // mistake the rest of this integration exists to avoid.
  const staples = live(account).map((i) => i.name);

  const prompt = [
    "You are helping a home cook break out of a rut.",
    "",
    "Here is every dish this household already cooks. This is the list to get AWAY from:",
    known.map((n) => `- ${n}`).join("\n"),
    cuisines.length ? `\nCuisines already represented: ${cuisines.join(", ")}.` : "",
    "",
    `EVERYTHING THEY ALREADY OWN. Nothing on this list may appear in \`buy\`; if a dish`,
    `uses one, put it in \`have\` instead:`,
    staples.join(", "),
    "",
    opts.theme ? `The person asked specifically for: ${opts.theme}.` : "",
    "",
    `Propose ${opts.count ?? 8} dishes that are RADICALLY different from the list above:`,
    "different cuisines, different techniques, different shopping. Not a variation on",
    "anything up there. Real food a competent home cook can actually make in a normal",
    "American kitchen with ordinary supermarket shopping, not restaurant projects that",
    "need a smoker or three days of fermentation. Vary the effort: some fast weeknight",
    "ones, at least one weekend project, at least one slow cooker.",
    "",
    "For each dish `buy` is what they must go and get, in plain shopping words, and",
    "`have` is what it uses that they already own from the staples list. Never put a",
    "staple they own into `buy`.",
    "",
    `Return JSON: {"dishes":[{"name":"","desc":"one sentence, what it is and why it is good",`,
    `"cuisine":"","why":"one sentence on how this differs from what they cook",`,
    `"buy":["..."],"have":["..."],"minutes":0,"effort":"quick|weeknight|project|allday",`,
    `"method":"stovetop|oven|sheetpan|crockpot|instantpot|grill|airfryer|nocook",`,
    `"spend":1,"health":3}]}`,
  ]
    .filter(Boolean)
    .join("\n");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openrouterKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4.5",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const parsed = JSON.parse(data.choices[0]!.message.content) as { dishes?: unknown[] };

  const seen = new Set<string>();
  const dishes: ExploreDish[] = [];
  for (const raw of parsed.dishes ?? []) {
    const d = raw as Record<string, unknown>;
    if (typeof d.name !== "string" || !d.name.trim()) continue;
    const id = slug(d.name);
    // A repeat of something they already cook is the one thing this shelf may
    // not contain, so it is dropped rather than shown as a near miss.
    if (seen.has(id) || known.some((n) => slug(n) === id)) continue;
    seen.add(id);
    const effort = EFFORTS.has(String(d.effort)) ? (String(d.effort) as Effort) : "weeknight";
    const method = METHODS.has(String(d.method)) ? (String(d.method) as Method) : "stovetop";
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const arr = (v: unknown) =>
      (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []).slice(0, 14);
    // Asking nicely is not enough. Anything on the shopping line that the house
    // demonstrably owns is moved across rather than trusted, because a list that
    // tells you to buy your own chicken is the exact failure this whole thing is
    // built to avoid, and it is one set-membership test away from impossible.
    const owned = new Set(live(account).map((i) => slug(i.name)));
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
  if (!dishes.length) throw new Error("explore: model returned nothing usable");

  const set: ExploreSet = {
    generated: new Date().toISOString(),
    theme: opts.theme ?? null,
    dishes,
  };
  mkdirSync(join(accountDir(), account), { recursive: true });
  writeFileSync(explorePath(account), JSON.stringify(set, null, 2));
  return set;
}
