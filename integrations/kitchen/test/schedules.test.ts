/**
 * Standing dinner texts. Each failure here reaches a real phone at a specific
 * minute, in rough order of harm:
 *
 *   - texting somebody outside the household (`to` is untrusted input from a
 *     public callback endpoint);
 *   - sending twice inside the 75-minute window;
 *   - sending late after the machine slept through the window;
 *   - claiming food the house does not have.
 */

import type { Recipe } from "../src/recipes.ts";
import {
  type Dinner,
  GRACE_MIN,
  type Pick,
  clock,
  composeText,
  describe as describeDinner,
  dueNow,
  nextFire,
  normalize,
  owed,
  recipients,
} from "../src/schedules.ts";
import type { Account } from "../src/types.ts";

import { check, section } from "./harness.ts";

const HUNTER = "imessage:dm:+15550100001";
const KAYLA = "imessage:dm:+15550100004";
const GROUP = "imessage:group:any;+;abc";

const house: Account = {
  name: "test",
  created: "2026-01-01T00:00:00+00:00",
  members: [HUNTER, KAYLA, GROUP],
  people: { [HUNTER]: "Alex", [KAYLA]: "Sam" },
};
const solo: Account = {
  name: "solo",
  created: "2026-01-01T00:00:00+00:00",
  members: ["imessage:dm:+15550100003"],
  people: { "imessage:dm:+15550100003": "Jordan" },
};

const at4 = (over: Partial<Dinner> = {}): Dinner =>
  normalize({ at: "16:00", days: [], to: [], meal: "dinner", on: true, ...over }, house);

/* ── validation ──────────────────────────────────────────────────────────── */

section("what a schedule will not accept");
let threw = false;
try {
  normalize({ at: "half four" }, house);
} catch {
  threw = true;
}
check("a time that is not a time is refused", threw);
threw = false;
try {
  normalize({ at: "25:00" }, house);
} catch {
  threw = true;
}
check("and so is 25 o'clock", threw);
threw = false;
try {
  normalize({ at: "16:00", to: ["imessage:dm:+15550000000"] }, house);
} catch {
  threw = true;
}
check("texting somebody who does not live here is refused", threw);
check(
  "a group chat is not a recipient",
  !recipients(at4(), house).some((r) => r.principal.startsWith("imessage:group:")),
);
check(
  "no recipients means everybody who eats here",
  recipients(at4(), house)
    .map((r) => r.label)
    .join(",") === "Alex,Sam",
);
check(
  "one recipient means one",
  recipients(at4({ to: [KAYLA] }), house)
    .map((r) => r.label)
    .join(",") === "Sam",
);
check(
  "junk days are dropped rather than stored",
  normalize({ at: "16:00", days: [1, 9, -2, 1] }, house).days.join(",") === "1",
);
check(
  "a nonsense meal falls back to dinner",
  normalize({ at: "16:00", meal: "brunch" as Dinner["meal"] }, house).meal === "dinner",
);
check("times are stored padded", normalize({ at: "9:05" }, house).at === "09:05");
check("and shown the way people say them", clock("16:00") === "4pm" && clock("09:05") === "9:05am");

section("a single-person household still works");
check(
  "one member is the whole recipient list",
  recipients(normalize({ at: "17:00" }, solo), solo)
    .map((r) => r.label)
    .join(",") === "Jordan",
);
check(
  "and it reads as one person, not a list",
  /to Jordan$/.test(describeDinner(normalize({ at: "17:00" }, solo), solo)),
);

/* ── firing ──────────────────────────────────────────────────────────────── */

// 2026-08-16 is a Sunday.
const sun = (h: number, m = 0) => new Date(2026, 7, 16, h, m);
const mon = (h: number, m = 0) => new Date(2026, 7, 17, h, m);

section("when it fires");
check("not before the time", !dueNow(at4(), sun(15, 59)));
check("on the minute", dueNow(at4(), sun(16, 0)));
check("still inside the grace window", dueNow(at4(), sun(16, GRACE_MIN - 1)));
// A machine that slept through the window must not text about a dinner already past.
check("not once the evening has gone", !dueNow(at4(), sun(21, 0)));
check("a paused schedule never fires", !dueNow(at4({ on: false }), sun(16, 5)));
check("a weekday schedule skips Sunday", !dueNow(at4({ days: [1, 2, 3, 4, 5] }), sun(16, 5)));
check("and fires on Monday", dueNow(at4({ days: [1, 2, 3, 4, 5] }), mon(16, 5)));
check(
  "once it has fired today it will not fire again",
  !dueNow(at4({ fired: "2026-08-16" }), sun(16, 30)),
);
check("but tomorrow it will", dueNow(at4({ fired: "2026-08-16" }), mon(16, 30)));

section("when it fires next");
const nxt = nextFire(at4(), sun(17, 0));
check("after today's has gone, tomorrow", nxt !== null && nxt.getDate() === 17);
const wknd = nextFire(at4({ days: [0, 6] }), mon(9, 0));
check("a weekend schedule on a Monday waits for Saturday", wknd !== null && wknd.getDay() === 6);
check("a paused schedule has no next fire", nextFire(at4({ on: false })) === null);

/* ── the text ────────────────────────────────────────────────────────────── */

const dish = (over: Partial<Recipe> = {}): Recipe => ({
  id: "x",
  name: "Roast pork loin with onions",
  desc: "",
  minutes: 90,
  needs: [],
  cat: "dinner",
  ...over,
});
const pick = (over: Partial<Pick> = {}): Pick => ({
  recipe: dish(),
  ready: true,
  missing: [],
  written: false,
  lastMade: null,
  ...over,
});

section("what the text says");
const ready = composeText(pick(), at4(), house, null, 0, true);
check("it names the dish", /roast pork loin with onions/.test(ready));
check("and says the house can cook it", /Everything it needs is in the house/.test(ready));
check("no written page means it promises one", /Writing it out now/.test(ready));
// A site rendered to disk but served to nobody means the page request reaches no one,
// so the text must not promise one.
check(
  "but only when a page could actually follow",
  !/Writing it out now/.test(composeText(pick(), at4(), house, null, 0, false)),
);
check(
  "and a household with no served site promises nothing",
  !/Writing it out now/.test(composeText(pick(), at4(), solo, null, 0)),
);
const withUrl = composeText(
  pick({ written: true }),
  at4(),
  house,
  "https://x/recipe/x.html?key=1",
  0,
  true,
);
check(
  "a written page is linked instead of promised",
  withUrl.includes("https://x/recipe/x.html?key=1") && !/Writing it out/.test(withUrl),
);

// The one claim this system must never make unsupervised.
const short = composeText(
  pick({ ready: false, missing: ["chicken thighs", "rice"] }),
  at4(),
  house,
  null,
  0,
  true,
);
check(
  "a shortfall is stated, never glossed",
  /short chicken thighs and rice/.test(short) && !/Everything it needs/.test(short),
);
const many = composeText(
  pick({ ready: false, missing: ["a", "b", "c", "d", "e"] }),
  at4(),
  house,
  null,
  0,
);
check("a long shortfall is counted rather than listed", /5 things you do not have/.test(many));

const nothing = composeText(null, at4(), house, null, 4);
check("nothing cookable says exactly that", /nothing honest to suggest/.test(nothing));
check("and points at the list it can see", /4 things on the shopping list/.test(nothing));
check("it never invents a dish when there is none", !/Tonight: /.test(nothing));

section("it is a text message, not a document");
for (const body of [ready, short, nothing, withUrl]) {
  if (/[*_#•]|^- /m.test(body)) check(`no markdown in "${body.slice(0, 40)}"`, false);
}
check("no markdown anywhere in the composed texts", true);
check("no em-dashes either", ![ready, short, nothing, withUrl].some((b) => b.includes("—")));

section("plain English");
check("every day reads as every day", /every day/.test(describeDinner(at4(), house)));
check("weekdays collapse", /weekdays/.test(describeDinner(at4({ days: [1, 2, 3, 4, 5] }), house)));
check("two people read as two", /to Alex and Sam/.test(describeDinner(at4(), house)));
check("a paused one says so", /\(paused\)/.test(describeDinner(at4({ on: false }), house)));

/* ── one failed send must not cost that person the day ───────────────────── */

// Receipts are per person: a transient failure texting one person must not mark the
// schedule delivered for them. `owed` is what the retry reads.
section("partial delivery");

const today = new Date(2026, 7, 17, 16, 5);
const key = (p: string, d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}|${p}`;

check("with nothing sent, everybody is owed", owed(at4(), house, today).length === 2);

check(
  "the person who already has it is not texted again",
  owed({ ...at4(), sent: [key(HUNTER, today)] }, house, today)
    .map((p) => p.principal)
    .join() === KAYLA,
);

check(
  "but the one whose send failed still is",
  owed({ ...at4(), sent: [key(HUNTER, today)] }, house, today).length === 1,
);

check(
  "once everyone has it, nobody is owed",
  owed({ ...at4(), sent: [key(HUNTER, today), key(KAYLA, today)] }, house, today).length === 0,
);

// Yesterday's receipts must not suppress today's text.
const yesterday = new Date(2026, 7, 16, 16, 5);
check(
  "yesterday's receipts do not suppress today",
  owed({ ...at4(), sent: [key(HUNTER, yesterday), key(KAYLA, yesterday)] }, house, today).length ===
    2,
);

check(
  "and normalize drops them rather than growing the registry forever",
  normalize({ at: "16:00", days: [], to: [], sent: [key(HUNTER, yesterday)] }, house, today).sent!
    .length === 0,
);

// A schedule addressed only to people who have left says so, instead of re-picking a
// dinner every minute for nobody.
check(
  "a schedule whose recipients all left has nobody to text",
  recipients({ ...at4(), to: ["imessage:dm:+19999999999"] }, house).length === 0,
);
