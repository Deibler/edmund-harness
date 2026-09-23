/**
 * The ranking terms beyond cookability: urgency (spend what is expiring), novelty
 * (not what was eaten lately) and regard (stars and ratings).
 *
 * The assertions are about order, not scores: a dish that spends the expiring beef
 * must beat one that could be cooked any night.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "kitchen-fit-"));
process.env.KITCHEN_DIR = BASE;
mkdirSync(join(BASE, "tenants", "hh"), { recursive: true });
writeFileSync(
  join(BASE, "tenants.json"),
  JSON.stringify({
    version: 1,
    tenants: {
      hh: { name: "Test", created: "2026-08-01T00:00:00Z", members: ["imessage:dm:+15550000000"] },
    },
  }),
);

const { urgency, novelty, regard, fitScore, fitReason, onTheClock } = await import("../src/fit.ts");
import type { MadeIndex } from "../src/made.ts";
import type { ProfileState } from "../src/profile.ts";
import type { Recipe } from "../src/recipes.ts";
import type { Item } from "../src/types.ts";
import { check, section } from "./harness.ts";

const NOW = new Date("2026-08-20T18:00:00");
const day = (offset: number): string =>
  new Date(NOW.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

const item = (id: string, cat: string, expires: string | null): Item => ({
  id,
  name: id.replace(/-/g, " "),
  cat: cat as never,
  loc: "fridge" as never,
  qty: 1,
  unit: "ct",
  level: null,
  expires,
  opened: false,
  aliases: [],
  added: day(-10),
  updated: day(-10),
  used_since_check: 0,
  uses_since_check: 0,
  use_unit: null,
  gone: false,
});

const dish = (id: string, needs: string[]): Recipe =>
  ({
    id,
    name: id.replace(/-/g, " "),
    desc: "",
    cat: "dinner",
    minutes: 30,
    needs: needs.map((n) => [n, null] as [string, number | null]),
  }) as Recipe;

const NO_PROF: ProfileState = { favorites: {}, notes: {}, skips: [] };
const NO_MADE: MadeIndex = new Map();

const shelf = (...its: Item[]): Record<string, Item> =>
  Object.fromEntries(its.map((i) => [i.id, i]));

/* ── urgency ──────────────────────────────────────────────────────────────── */

section("spending what is about to be thrown out");

const fridge = shelf(
  item("ground-beef", "meat", day(-1)), // a day past date
  item("spaghetti", "pantry", null), // keeps forever
  item("onion", "produce", null),
  item("green-beans", "produce", day(4)),
);

const beefDish = dish("beef-skillet", ["ground-beef", "onion"]);
const pantryDish = dish("spaghetti-marinara", ["spaghetti", "onion"]);

check("a dish that spends the expiring protein scores", urgency(beefDish, fridge) > 0);
check(
  "a dish built only from things with no clock scores nothing",
  urgency(pantryDish, fridge) === 0,
);
check(
  "and so it ranks below the one that saves the beef",
  fitScore(beefDish, fridge, NO_MADE, NO_PROF, NOW) >
    fitScore(pantryDish, fridge, NO_MADE, NO_PROF, NOW),
);

// Urgency must be large enough to overturn a tie broken on ingredient count, not
// merely present.
check(
  "a long recipe using the urgent thing beats a short one that does not",
  urgency(dish("long", ["ground-beef", "onion", "spaghetti", "green-beans"]), fridge, NOW) >
    urgency(dish("short", ["spaghetti"]), fridge, NOW),
);

check(
  "an ingredient the ledger has never heard of is not an opinion",
  urgency(dish("mystery", ["never-logged-this"]), fridge, NOW) === 0,
);

check(
  "nor is one that has run out",
  urgency(
    dish("gone", ["vanished"]),
    shelf({ ...item("vanished", "meat", day(0)), gone: true }),
    NOW,
  ) === 0,
);

// Food well past its date still scores a little, but must not lead the page.
check(
  "something long past date stops leading",
  urgency(dish("old", ["ancient"]), shelf(item("ancient", "meat", day(-6))), NOW) <
    urgency(dish("today", ["fresh"]), shelf(item("fresh", "meat", day(0))), NOW),
);

check(
  "meat outranks produce on the same clock",
  urgency(dish("m", ["beefy"]), shelf(item("beefy", "meat", day(0))), NOW) >
    urgency(dish("p", ["leafy"]), shelf(item("leafy", "produce", day(0))), NOW),
);

/* ── novelty ──────────────────────────────────────────────────────────────── */

section("not eating the same thing twice");

const madeIdx = (id: string, when: string): MadeIndex => new Map([[id, when]]);

check(
  "a dinner eaten last night is pushed down hard",
  novelty(beefDish, madeIdx("beef-skillet", day(-1)), NOW) <= -40,
);
check(
  "one from last week is only nudged",
  novelty(beefDish, madeIdx("beef-skillet", day(-5)), NOW) > -40 &&
    novelty(beefDish, madeIdx("beef-skillet", day(-5)), NOW) < 0,
);
check(
  "one from two months ago is a positive",
  novelty(beefDish, madeIdx("beef-skillet", day(-60)), NOW) > 0,
);
check("never cooked here is a mild boost, not a penalty", novelty(beefDish, NO_MADE, NOW) > 0);

// Repetition must be able to beat urgency, or the same dish leads every night until
// the food runs out.
check(
  "eating it last night outweighs the beef going off",
  fitScore(beefDish, fridge, madeIdx("beef-skillet", day(-1)), NO_PROF, NOW) <
    fitScore(pantryDish, fridge, NO_MADE, NO_PROF, NOW),
);

/* ── regard ───────────────────────────────────────────────────────────────── */

section("what people actually said about it");

const starred: ProfileState = { favorites: { "beef-skillet": ["me"] }, notes: {}, skips: [] };
const rated = (n: number): ProfileState => ({
  favorites: {},
  skips: [],
  notes: { "beef-skillet": [{ who: "me", text: "", at: day(-3), rating: n }] },
});

check("a star lifts it", regard(beefDish, starred) > 0);
check(
  "two people starring is not twice as good",
  regard(beefDish, { favorites: { "beef-skillet": ["a", "b"] }, notes: {}, skips: [] }) ===
    regard(beefDish, starred),
);
check("a five lifts it", regard(beefDish, rated(5)) > 0);
check("a two sinks it", regard(beefDish, rated(2)) < 0);
check("no rating is zero, not a punishment", regard(beefDish, NO_PROF) === 0);
check(
  "words with no rating do not move it",
  regard(beefDish, {
    favorites: {},
    skips: [],
    notes: { "beef-skillet": [{ who: "me", text: "nice", at: day(-3), rating: null }] },
  }) === 0,
);

/* ── the sentence on the card ─────────────────────────────────────────────── */

section("saying why it is at the top");

check(
  "the reason names the food that is on a clock",
  (fitReason(beefDish, fridge, NO_MADE, NO_PROF, NOW) ?? "").includes("ground beef"),
);
check(
  "a dish with nothing urgent and no history says nothing",
  fitReason(pantryDish, fridge, NO_MADE, NO_PROF, NOW) === null,
);
check(
  "a long-unmade dish says so",
  fitReason(pantryDish, fridge, madeIdx("spaghetti-marinara", day(-60)), NO_PROF, NOW) !== null,
);

/* ── the clock list the page offers to cook around ────────────────────────── */

section("what is running out");

check(
  "only things actually on a clock are listed",
  onTheClock(fridge, 1, NOW)
    .map((c) => c.item.id)
    .join() === "ground-beef",
);
check(
  "worst first",
  (() => {
    const l = onTheClock(shelf(item("a", "meat", day(1)), item("b", "meat", day(-1))), 1, NOW);
    return l[0]?.item.id === "b";
  })(),
);
check(
  "something six days past date is not offered as dinner",
  onTheClock(shelf(item("rotten", "meat", day(-6))), 1, NOW).length === 0,
);
check(
  "nor is an item that is gone",
  onTheClock(shelf({ ...item("used-up", "meat", day(0)), gone: true }), 1, NOW).length === 0,
);

/* ── the plural that hid a repeat ─────────────────────────────────────────── */

section("a dish logged in the plural is the same dish");

const { lastMade } = await import("../src/made.ts");

// A dish logged in the plural ("Wraps") is the same dish as its singular card.
const wrap = dish("buffalo-chicken-wrap", ["ground-beef"]);
wrap.name = "Buffalo Chicken Wrap";
const pluralLog: MadeIndex = new Map([["buffalo-chicken-wraps", day(-3)]]);

check("the plural in the ledger matches the singular card", lastMade(pluralLog, wrap) === day(-3));
check(
  "so it is penalised as a repeat rather than boosted as untried",
  novelty(wrap, pluralLog, NOW) < 0,
);

// Only a trailing "s" on the last segment is folded; anything looser lets dishes that
// share a first word claim each other's nights.
const soup = dish("beef-quesadilla-soup", ["ground-beef"]);
soup.name = "Beef Quesadilla Soup";
check(
  "a different dish sharing a word does not claim the night",
  lastMade(new Map([["beef-quesadillas", day(-3)]]), soup) === undefined,
);
