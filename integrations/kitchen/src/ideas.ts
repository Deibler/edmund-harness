/**
 * The household's own ideas: dishes written for what is in this kitchen now.
 *
 * The shared catalog goes stale, so the site carries a second layer of dishes
 * written for this house and retired when the food they need is gone or they
 * sit unmade for three weeks. Ideas are written in conversation through
 * `kitchen_ideas`: `ideasBrief` is the material to write from and `saveIdeas`
 * validates each dish against the ledger, the household's avoid list and the
 * rule that a dinner is not built around lunch food.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { eaters, getAccount } from "./accounts.ts";
import { type Evidence, evidence } from "./evidence.ts";
import { PANTRY_BASICS, avoidedBy, isConvenience, isPantryBasic, onHand } from "./foods.ts";
import { meals } from "./insights.ts";
import { METHOD_LABEL, type Recipe, loadRecipes, overlayPath } from "./recipes.ts";
import { fold, live } from "./store.ts";
import type { Account, Item } from "./types.ts";

export const IDEAS_TARGET = 10;
/** Days an unmade idea stays on the site. */
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
 * Drop ideas built on food that is gone, or unmade for `IDEA_MAX_AGE_DAYS`, and
 * say how many more the page could use.
 *
 * A pantry basic never retires a dish, tracked or not: running out of salt is a
 * line on the shopping list, not a reason to forget every salted dinner.
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
    const missing = r.needs.filter(
      ([s]) => !s.startsWith("leftover-") && !isPantryBasic(s) && !have.has(s),
    );
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

/** How many recent meals the brief lists, so new ideas vary from them. */
const RECENT_MEALS = 10;

/**
 * Everything needed to write this house's ideas well.
 *
 * Ingredients come with the kitchen's confidence in them, because a dinner
 * built on grapes bought two weeks ago is a dinner nobody can cook. Recent
 * meals are listed so the new ones differ in shape, not only in name. Lunch
 * and snack food is listed separately so it never anchors a dinner.
 */
export function ideasBrief(account: string, acct: Account, want: number): string {
  const ev = evidence(account).filter((e) => e.estimate !== "doubtful");
  // The same test cooking uses, so the brief never promises a basic the ledger
  // says has run out.
  const stock = fold(account);
  const basics = [...PANTRY_BASICS].filter((s) => onHand(stock, s));
  const mains = ev.filter((e) => !isConvenience(e.item));
  const convenience = ev.filter((e) => isConvenience(e.item));
  const slugList = (xs: Evidence[]) =>
    xs
      .map((e) => `${e.item.id}${e.estimate === "unsure" ? " (unsure)" : ""}`)
      .sort()
      .join(", ") || "(none)";

  const perishable = mains
    .filter((e) => e.shelf && e.estimate !== "unsure" && e.age >= e.shelf.life.low * 0.6)
    .map((e) => e.item.id);
  const recent = meals(account)
    .slice(-RECENT_MEALS)
    .map((m) => m.name)
    .reverse();
  const shared = loadRecipes().recipes.map((r) => r.name);
  const own = readOverlay(account).recipes.map((r) => r.name);
  const who = eaters(acct)
    .map((e) => e.label)
    .join(", ");
  const avoidMethods = (acct.prefs?.avoid_methods ?? []).map(
    (m) => METHOD_LABEL[m as keyof typeof METHOD_LABEL] ?? m,
  );

  return [
    `Write ${want} new dinner or lunch idea${want === 1 ? "" : "s"} for ${who || "this house"}, from what is in the kitchen now.`,
    "",
    "Ingredients, by ledger slug. Use these slugs exactly. Items marked (unsure) may be",
    "gone: build around them only if nothing else works, and never as the main.",
    slugList(mains),
    "",
    `Lunch and snack food. Never the centre of a dinner: ${slugList(convenience)}`,
    basics.length ? `Always available without tracking: ${basics.join(", ")}.` : "",
    "",
    perishable.length ? `Worth using soon: ${perishable.join(", ")}.` : "",
    recent.length
      ? `Cooked recently (vary the shape, not just the name): ${recent.join("; ")}.`
      : "",
    acct.diet?.avoid?.length
      ? `Never use (dishes with these are rejected): ${acct.diet.avoid.join(", ")}.`
      : "",
    acct.diet?.style ? `How they eat: ${acct.diet.style}.` : "",
    acct.prefs?.vibe ? `Current vibe setting: ${acct.prefs.vibe}.` : "",
    acct.prefs?.mode && acct.prefs.mode !== "normal" ? `Mode: ${acct.prefs.mode}.` : "",
    avoidMethods.length ? `Not cooking with: ${avoidMethods.join(", ")}.` : "",
    "",
    `Do not repeat or lightly rename: ${[...shared, ...own].join(", ")}`,
    "",
    "Write the dinners a person would actually cook for this house: a real main, sides",
    "that belong with it, a sauce or seasoning that makes it worth eating. List the main",
    "ingredient first in needs. Use what you know about these people from this chat.",
    "",
    `Then kitchen_ideas action:"save" with recipes:[{id: kebab-case, name, desc (one`,
    `plain sentence), minutes, cat: dinner|lunch|side|dessert|snack, health: 1-5,`,
    `needs: [[slug, qty-or-null]], effort?, method?}]. A null qty means "some".`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Validate and append written ideas. Rejection is per dish with a reason. An id
 * already on the overlay is replaced; one in the shared catalog is refused.
 */
export function saveIdeas(
  account: string,
  raw: unknown[],
  now = new Date(),
): { saved: Idea[]; rejected: Array<{ id: string; why: string }> } {
  const stock = live(account);
  const have = new Set(stock.map((i) => i.id));
  const items = new Map(stock.map((i) => [i.id, i]));
  const avoid = getAccount(account)?.diet?.avoid;
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
      .filter(
        ([s]) =>
          !(
            typeof s === "string" &&
            (have.has(s) || isPantryBasic(s) || s.startsWith("leftover-"))
          ),
      )
      .map(([s]) => String(s));
    if (unknown.length) {
      rejected.push({ id, why: `unknown ingredient ${unknown.join(", ")}` });
      continue;
    }
    const avoided = avoidedBy(avoid, { name: r.name, needs: r.needs });
    if (avoided) {
      rejected.push({ id, why: `uses ${avoided}, which this house avoids` });
      continue;
    }
    const main = items.get(String(r.needs[0]?.[0]));
    if ((r.cat ?? "dinner") === "dinner" && main && isConvenience(main)) {
      rejected.push({ id, why: `a dinner is not built around ${main.name.toLowerCase()}` });
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
