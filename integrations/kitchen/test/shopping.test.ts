/**
 * The shopping list, which is the part of this system that fails by being
 * ignored rather than by throwing.
 *
 * Every assertion here traces to a line somebody actually complained about on a
 * real list: leftovers you cannot buy, chicken thighs bought the previous day,
 * a jug of milk restocked two days earlier, and imitation crab legs that had
 * been on the list since the one sushi bake they were bought for. None of those
 * were crashes. All of them were the list quietly becoming something you scroll
 * past, which is the only way a list ever dies.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "kitchen-shopping-"));
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

const { append } = await import("../src/store.ts");
const { shopping, settleAfterPurchase, isBuyable } = await import("../src/shopping.ts");
const { setDisposition, skip, onRunOut, readBook } = await import("../src/restock.ts");
const { tripCount } = await import("../src/shopping.ts");
const { addToList, setAmount, readList } = await import("../src/list.ts");
import { check, section } from "./harness.ts";

const A = "hh";
/** Bought on `trips` separate shops, which is what makes something a staple. */
const stock = (id: string, name: string, cat: string, qty: number | null, trips = 2) => {
  for (let t = 1; t <= trips; t++) {
    append(A, [
      {
        op: "add" as const,
        item: id,
        qty,
        unit: "ct",
        fields: { name, cat: cat as never },
        why: "seed",
        src: `receipt:seed-2026-01-0${t}`,
      },
    ]);
  }
};
const useUp = (id: string) =>
  append(A, [{ op: "use" as const, item: id, qty: null, why: "ate it" }]);
const names = () => shopping(A).lines.map((l) => l.name);
const trayNames = () => shopping(A).suggestions.map((s) => s.name);

stock("milk", "Milk", "dairy", 1);
stock("chicken-broth", "Chicken broth", "pantry", 2);
stock("imitation-crab-legs", "Imitation crab legs", "seafood", 1);
stock("chicken-thighs", "Chicken thighs", "meat", 1);
stock("leftover-rice", "Leftover rice", "other", 1);

/* ── things that can never be bought ──────────────────────────────────────── */

section("what is even buyable");

check("a leftover is not a grocery", !isBuyable("leftover-rice"));
check("a normal item is", isBuyable("milk"));

useUp("leftover-rice");
check(
  "and running out of one puts nothing on any list",
  !names().includes("Leftover rice") && !trayNames().includes("Leftover rice"),
);

/* ── restocking a low item clears the flag ────────────────────────────────── */

// The bug: `add` cleared a stale "out" but carried a stale "low" straight
// through it, so a shelf check saying "running low on milk" outlived the jug
// bought two days later and milk never left the list again.
section("buying more of something stops it being low");

append(A, [
  { op: "set" as const, item: "milk", fields: { level: "low" as const }, why: "shelf check" },
]);
check("a shelf check saying low puts it on the list", names().includes("Milk"));

append(A, [{ op: "add" as const, item: "milk", qty: 1, why: "bought a jug" }]);
check("buying a jug takes it back off", !names().includes("Milk"));

append(A, [
  {
    op: "add" as const,
    item: "milk",
    qty: 1,
    fields: { level: "low" as const },
    why: "one left",
  },
]);
check("but an add that says low on purpose is still believed", names().includes("Milk"));
append(A, [{ op: "add" as const, item: "milk", qty: 2, why: "restocked properly" }]);

/* ── meat is suggested, never dictated ────────────────────────────────────── */

section("who decides about protein");

const bought = (trips: number, mealUses: number) => ({ trips, mealUses });
check(
  "meat is offered, never listed by default, however often it is bought",
  onRunOut(readBook(A), "chicken-thighs", "meat", bought(5, 5)) === "offer",
);
check(
  "something bought on two trips is a staple",
  onRunOut(readBook(A), "chicken-broth", "pantry", bought(2, 0)) === "list",
);
check(
  "something bought once and cooked with is offered",
  onRunOut(readBook(A), "tahini", "pantry", bought(1, 1)) === "offer",
);
check(
  "something bought once and never cooked with is dropped",
  onRunOut(readBook(A), "tahini", "pantry", bought(1, 0)) === "drop",
);

useUp("chicken-thighs");
check("so running out of thighs stays off the list", !names().includes("Chicken thighs"));
check("and shows up in the tray instead", trayNames().includes("Chicken thighs"));

check(
  "unless somebody says they always want them",
  (() => {
    setDisposition(A, ["chicken-thighs"], "always");
    return names().includes("Chicken thighs") && !trayNames().includes("Chicken thighs");
  })(),
);

/* ── the one-off, which is the whole crab legs story ──────────────────────── */

section("answering once, forever");

useUp("imitation-crab-legs");
check(
  "a one-off starts in the tray, not on the list",
  trayNames().includes("Imitation crab legs") && !names().includes("Imitation crab legs"),
);

setDisposition(A, ["imitation-crab-legs"], "never");
const afterNever = shopping(A);
check(
  "saying never takes it off both",
  !afterNever.lines.some((l) => l.name.includes("crab")) &&
    !afterNever.suggestions.some((s) => s.name.includes("crab")),
);
check(
  "and says out loud that it was held back rather than vanishing",
  afterNever.held.some((h) => h.name.includes("crab")),
);

/* ── not this trip ────────────────────────────────────────────────────────── */

// Distinct from "never" on purpose. Collapsing the two would teach the system
// that the household does not keep broth, when all they said was "not today".
section("not this trip");

useUp("chicken-broth");
check("broth is a staple so it lists itself", names().includes("Chicken broth"));

skip(A, ["chicken-broth"], tripCount(A));
check("skipping takes it off this list", !names().includes("Chicken broth"));
check("without claiming they stopped buying it", readBook(A).items["chicken-broth"] === undefined);

// Every one of these adds food and none of them is a shop. Each used to count
// as a trip, so putting dinner in the fridge spent a "not this trip".
append(A, [
  { op: "add" as const, item: "leftover-soup", qty: 1, fields: { name: "Soup" }, src: "cooked" },
]);
append(A, [{ op: "add" as const, item: "salt", qty: 1, fields: { name: "Salt" }, src: "photo" }]);
append(A, [{ op: "add" as const, item: "salt", qty: 1, fields: { name: "Salt" }, why: "has it" }]);
check(
  "a leftover, a shelf photo or a correction is not a trip",
  !names().includes("Chicken broth"),
);

append(A, [
  { op: "add" as const, item: "eggs", qty: 12, fields: { name: "Eggs" }, src: "receipt:giant-1" },
]);
check("and the next trip spends the skip, so it comes back", names().includes("Chicken broth"));

skip(A, ["chicken-broth"], tripCount(A));
append(A, [{ op: "trip" as const, item: null, fields: { price: 9 }, src: "receipt:giant-1" }]);
append(A, [
  { op: "add" as const, item: "eggs", qty: 12, fields: { name: "Eggs" }, src: "receipt:giant-1" },
]);
check(
  "one receipt logged again, or its total logged later, is still the one trip",
  !names().includes("Chicken broth"),
);
append(A, [
  { op: "add" as const, item: "bread", qty: 1, fields: { name: "Bread" }, src: "trip:aldi" },
]);
check("a shop logged without a receipt is a trip", names().includes("Chicken broth"));

/* ── lines a person wrote ─────────────────────────────────────────────────── */

section("written lines");

addToList(A, [{ name: "Paper towels", item: null, why: "we are out" }]);
check("a written line is on the list", names().includes("Paper towels"));
check(
  "in its own group, because nothing derived it",
  shopping(A).groups.find((g) => g.id === "asked")?.lines.length === 1,
);

check(
  "its amount can be corrected",
  (() => {
    setAmount(A, "paper-towels", "2 packs");
    return shopping(A).lines.find((l) => l.name === "Paper towels")?.amount === "2 packs";
  })(),
);
check(
  "correcting an amount that is not written down fails honestly",
  setAmount(A, "not-a-line", "3") === false,
);

/* ── a trip settles the list even when nobody ticked anything ─────────────── */

// The observed failure: the household shopped from their own note, came back
// with a full car, and the site's list was unchanged because nobody had the
// page open. A list that only settles by tapping is a list that goes stale the
// first time it is ignored.
section("settling against a receipt");

addToList(A, [{ name: "Chicken broth", item: "chicken-broth", why: "for soup" }]);
const settled = settleAfterPurchase(A, ["chicken-broth"]);
check("a receipt clears the written line it satisfied", settled.cleared.includes("Chicken broth"));
check("and the line is really gone", !readList(A).entries.some((e) => e.item === "chicken-broth"));
check("while reporting what is still outstanding", Array.isArray(settled.outstanding));
check(
  "a receipt for nothing on the list clears nothing",
  settleAfterPurchase(A, ["something-nobody-listed"]).cleared.length === 0,
);

/* ── every line can say why it is there ───────────────────────────────────── */

section("defensible lines");

check(
  "no line is ever reasonless",
  shopping(A).lines.every((l) => l.why.trim().length > 0),
);
check(
  "and every line belongs to exactly one group",
  (() => {
    const s = shopping(A);
    const keys = s.groups.flatMap((g) => g.lines.map((l) => l.key));
    return keys.length === new Set(keys).size;
  })(),
);
check(
  "nothing is on the list and in the tray at once",
  (() => {
    const s = shopping(A);
    const listed = new Set(s.lines.map((l) => l.key));
    return !s.suggestions.some((x) => listed.has(x.key));
  })(),
);

/* ── an answer lands on something real ────────────────────────────────────── */

// The model answers with the name it read on the list. A member's own lines get
// a prefix, so slugging that name missed the id, the answer was filed under a
// slug nothing uses, and the reply still said "Recorded".
section("answers");

const { answerTarget } = await import("../src/shopping.ts");
stock("guest-s-flour-tortillas", "Flour tortillas", "pantry", 1);
stock("a-s-corn", "Corn", "produce", 1);
stock("b-s-sweet-corn", "Sweet corn", "produce", 1);
stock("c-s-corn", "Corn on the cob", "produce", 1);

const hit = (said: string) => {
  const t = answerTarget(A, said);
  return t.ok ? t.id : null;
};
check("an exact id is taken as it is", hit("milk") === "milk");
check(
  "a slugged name finds the prefixed line",
  hit("flour-tortillas") === "guest-s-flour-tortillas",
);
check(
  "so does the name as the list shows it",
  hit("Flour tortillas") === "guest-s-flour-tortillas",
);
check("an exact name beats a looser ending", hit("corn") === "a-s-corn");
check("something nobody tracks is refused", hit("dragonfruit") === null);
check(
  "and two equally good matches are a question back, not a pick",
  (() => {
    const t = answerTarget(A, "s-corn");
    return !t.ok && t.why.includes("a-s-corn") && t.why.includes("c-s-corn");
  })(),
);

const { kitchenTools } = await import("../tools.ts");
const shoppingTool = kitchenTools({
  sessionKey: "imessage:dm:+15550000000",
  config: { kitchen: { enabled: true }, paths: { data_dir: BASE } },
} as never).find((t) => t.name === "kitchen_shopping");
const call = async (args: Record<string, unknown>) => {
  const r = (await shoppingTool?.handler(args as never)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { said: r.content.map((c) => c.text).join("\n"), error: r.isError === true };
};

const bookBefore = JSON.stringify(readBook(A));
const bad = await call({
  answer: { item: "dragonfruit", as: "never" },
  add: [{ name: "Coffee filters" }],
});
check("the tool reports an answer it could not place as an error", bad.error);
check("instead of saying it was recorded", !bad.said.includes("Recorded"));
check(
  "and writes nothing, the answer or anything else in the call",
  (() => {
    return JSON.stringify(readBook(A)) === bookBefore && !names().includes("Coffee filters");
  })(),
);

const good = await call({ answer: { item: "Flour tortillas", as: "never" } });
check("a name that resolves is recorded against the real id", good.said.includes("Recorded"));
check(
  "and the book holds it under that id",
  readBook(A).items["guest-s-flour-tortillas"]?.set === "never",
);
