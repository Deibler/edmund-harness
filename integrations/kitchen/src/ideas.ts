/**
 * The household's own ideas: dinners built from what is on the shelves today.
 *
 * The shared catalog goes stale by construction, so the site carries a second
 * layer of dishes written for THIS kitchen this week and retired when the food
 * they were built on is gone. The morning pass prunes that layer; writing the
 * replacements is judgement about food and about these people, and it is mine.
 * Until 2026-09-19 a narrow model on OpenRouter wrote them from a slug list,
 * which is how a house that hates tomato paste got tomato-paste dinners.
 *
 * So the pass wakes me (see `wake.ts`) and I answer through `kitchen_ideas`:
 * `ideasBrief` is the exact material to write from and `saveIdeas` is the
 * validation, which is the part that does not trust me either. A dish naming
 * an ingredient the ledger does not hold would render as cookable and is not,
 * which is worse than proposing nothing, so it is rejected at the write.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { eaters } from "./accounts.ts";
import { METHOD_LABEL, type Recipe, loadRecipes, overlayPath } from "./recipes.ts";
import { daysLeft, live } from "./store.ts";
import type { Account, Item } from "./types.ts";

export const IDEAS_TARGET = 10;
/** An unmade idea is not worth keeping forever; the kitchen has moved on. */
export const IDEA_MAX_AGE_DAYS = 21;

export type Idea = Recipe & { created?: string; origin?: string };
export type Overlay = { recipes: Idea[] };

export function readOverlay(account: string): Overlay {
  const p = overlayPath(account);
  if (!existsSync(p)) return { recipes: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Overlay;
    return Array.isArray(raw?.recipes) ? raw : { recipes: [] };
  } catch {
    return { recipes: [] };
  }
}

export function writeOverlay(account: string, o: Overlay): void {
  const p = overlayPath(account);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(o, null, 2));
}

/**
 * Drop the ideas the kitchen has moved past, and say how many are wanted.
 *
 * An idea built on food that is gone is dropped, because a card that reads as
 * cookable and is not is the single most obvious way the site goes stale. An
 * idea nobody made in three weeks is dropped too: the household has voted.
 */
export function pruneIdeas(
  account: string,
  items: Item[] = live(account),
  now = Date.now(),
): { kept: Idea[]; dropped: Array<{ id: string; why: string }>; want: number } {
  const have = new Set(items.map((i) => i.id));
  const cutoff = now - IDEA_MAX_AGE_DAYS * 86_400_000;
  const dropped: Array<{ id: string; why: string }> = [];
  const kept = readOverlay(account).recipes.filter((r) => {
    const missing = r.needs.filter(([s]) => !s.startsWith("leftover-") && !have.has(s));
    if (missing.length) {
      dropped.push({ id: r.id, why: `no longer have ${missing.map(([s]) => s).join(", ")}` });
      return false;
    }
    if (r.created && new Date(r.created).getTime() < cutoff) {
      dropped.push({ id: r.id, why: `${IDEA_MAX_AGE_DAYS} days old and never made` });
      return false;
    }
    return true;
  });
  writeOverlay(account, { recipes: kept });
  return { kept, dropped, want: Math.max(0, IDEAS_TARGET - kept.length) };
}

/**
 * Everything I need in front of me to write this house's ideas.
 *
 * The slug list is the contract, not a courtesy: `saveIdeas` rejects any dish
 * naming a slug that is not on it. What expires soonest goes first because
 * that is the whole reason these exist. The names to avoid are the shared
 * catalog plus what is already on the overlay, so a new idea is new.
 */
export function ideasBrief(account: string, acct: Account, want: number): string {
  const items = live(account);
  const soon = items
    .filter((i) => {
      const d = daysLeft(i);
      return d !== null && d <= 6;
    })
    .sort((a, b) => (daysLeft(a) ?? 99) - (daysLeft(b) ?? 99))
    .map((i) => `${i.id} (${daysLeft(i)}d)`);
  const shared = loadRecipes().recipes.map((r) => r.name);
  const own = readOverlay(account).recipes.map((r) => r.name);
  const who = eaters(acct)
    .map((e) => e.label)
    .join(", ");
  const avoidMethods = (acct.prefs?.avoid_methods ?? []).map(
    (m) => METHOD_LABEL[m as keyof typeof METHOD_LABEL] ?? m,
  );
  return [
    `Write ${want} new dinner or lunch idea${want === 1 ? "" : "s"} for ${who || "this house"}, built strictly from what is on the shelves right now.`,
    "",
    "Use ONLY these ingredient slugs, exactly as written. Do not invent slugs, do not",
    "pluralise, do not substitute a similar word. Anything else is rejected on save:",
    items
      .map((i) => `${i.id}${i.qty !== null ? ` (${i.qty}${i.unit ? ` ${i.unit}` : ""})` : ""}`)
      .sort()
      .join(", ") || "(nothing tracked)",
    "",
    soon.length ? `Use these first, they expire soonest: ${soon.join(", ")}` : "",
    acct.diet?.avoid?.length ? `This house avoids: ${acct.diet.avoid.join(", ")}.` : "",
    acct.diet?.style ? `How they eat: ${acct.diet.style}.` : "",
    acct.prefs?.vibe ? `Current vibe setting: ${acct.prefs.vibe}.` : "",
    acct.prefs?.mode && acct.prefs.mode !== "normal" ? `Mode: ${acct.prefs.mode}.` : "",
    avoidMethods.length ? `Not cooking with: ${avoidMethods.join(", ")}.` : "",
    "",
    `Do NOT repeat or lightly rename any of these: ${[...shared, ...own].join(", ")}`,
    "",
    "Real cooking, no garnish-only dishes, nothing that needs equipment this house",
    "has not shown it owns. You know these people; write for them, not for a catalog.",
    "",
    `Then kitchen_ideas action:"save" with recipes:[{id: kebab-case, name, desc (one`,
    `plain sentence, no marketing), minutes, cat: dinner|lunch|side|dessert|snack,`,
    `health: 1-5, needs: [[slug, qty-or-null]], effort?, method?}]. A null qty means`,
    `"some", which is right for spices, oils and condiments.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Validate and append ideas I have written.
 *
 * Rejection is per dish and says why, so a bad slug costs one card and not the
 * batch. A dish whose id is already on the overlay replaces it rather than
 * doubling; one that shadows the shared catalog is refused, because the point
 * of this layer is dishes the catalog does not have.
 */
export function saveIdeas(
  account: string,
  raw: unknown[],
  now = new Date(),
): { saved: Idea[]; rejected: Array<{ id: string; why: string }> } {
  const have = new Set(live(account).map((i) => i.id));
  const shared = new Set(loadRecipes().recipes.map((r) => r.id));
  const overlay = readOverlay(account);
  const today = now.toISOString().slice(0, 10);
  const saved: Idea[] = [];
  const rejected: Array<{ id: string; why: string }> = [];
  for (const item of raw) {
    const r = (item ?? {}) as Partial<Recipe>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!id || typeof r.name !== "string" || !r.name.trim()) {
      rejected.push({ id: id || "?", why: "needs an id and a name" });
      continue;
    }
    if (shared.has(id)) {
      rejected.push({ id, why: "already in the shared catalog" });
      continue;
    }
    if (!Array.isArray(r.needs) || !r.needs.length) {
      rejected.push({ id, why: "needs an ingredient list" });
      continue;
    }
    const unknown = r.needs
      .filter(([s]) => !(typeof s === "string" && (have.has(s) || s.startsWith("leftover-"))))
      .map(([s]) => String(s));
    if (unknown.length) {
      rejected.push({ id, why: `unknown ingredient ${unknown.join(", ")}` });
      continue;
    }
    if (typeof r.minutes !== "number" || !(r.minutes > 0)) {
      rejected.push({ id, why: "needs minutes" });
      continue;
    }
    const idea: Idea = {
      id,
      name: r.name.trim(),
      desc: typeof r.desc === "string" ? r.desc : "",
      minutes: Math.round(r.minutes),
      needs: r.needs.map(([s, q]) => [s, typeof q === "number" ? q : null]),
      cat: typeof r.cat === "string" && r.cat ? r.cat : "dinner",
      ...(typeof r.health === "number"
        ? { health: Math.max(1, Math.min(5, Math.round(r.health))) }
        : {}),
      ...(r.effort ? { effort: r.effort } : {}),
      ...(r.method ? { method: r.method } : {}),
      created: today,
      origin: "daily",
    };
    overlay.recipes = overlay.recipes.filter((x) => x.id !== id);
    overlay.recipes.push(idea);
    saved.push(idea);
  }
  if (saved.length) writeOverlay(account, overlay);
  return { saved, rejected };
}
