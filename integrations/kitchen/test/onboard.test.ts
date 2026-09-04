/**
 * Getting a stranger from "what can I make with chicken" to a working kitchen.
 *
 * The failure this guards is not a crash, it is a half-provisioned household:
 * an account that exists with nothing on its shelves answers every food
 * question worse than having no account at all, because now the replies are
 * hedged against a ledger that knows nothing, and the person has learned that
 * this does not work. So the properties asserted here are about refusing to
 * start rather than about finishing.
 *
 * The photo reading itself is a model call and is not tested here; what IS
 * tested is everything around it, because that is where a bad reading turns
 * into a bad ledger.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "kitchen-onboard-"));
process.env.KITCHEN_DIR = BASE;
mkdirSync(join(BASE, "tenants"), { recursive: true });
writeFileSync(join(BASE, "tenants.json"), JSON.stringify({ version: 1, tenants: {} }));

const { accountOf, acceptStock, provision, state } = await import("../src/onboard.ts");
const { getAccount, listAccounts } = await import("../src/accounts.ts");
const { live, readLog } = await import("../src/store.ts");
import type { Proposal } from "../src/onboard.ts";
import { check, section } from "./harness.ts";

const NEW = "imessage:dm:+15551230000";
const OTHER = "imessage:dm:+15551231111";

/* ── deciding whether to offer at all ────────────────────────────────────── */

// This is the one question that must answer for somebody with no kitchen.
// `resolveAccount` throws for an unknown caller, which is correct when food is
// about to be read or written and useless as the thing that decides whether to
// make an offer, since "no account" is the entire population being offered to.
section("is there anything here yet");

check("a stranger resolves to no household rather than an error", accountOf(NEW) === null);
check("and so does a caller with no identity at all", accountOf(null) === null);
check(
  "with a checklist that still says what to do next",
  state(null).steps[0]!.next.includes("start"),
);
check("and is not called ready", state(null).ready === false);

/* ── nothing half-built ──────────────────────────────────────────────────── */

section("provisioning");

check(
  "a bad id is refused before anything is written",
  (() => {
    try {
      provision("Not An Id", { principal: NEW });
      return false;
    } catch {
      return listAccounts().length === 0;
    }
  })(),
);

check(
  "so is a household with nobody in it",
  (() => {
    try {
      provision("morgan", { principal: "" });
      return false;
    } catch {
      return listAccounts().length === 0;
    }
  })(),
);

const first = provision("morgan", { principal: NEW, person: "Morgan" });
check("a good one creates the household", first.created && getAccount("morgan") !== null);
check("with the person in it", getAccount("morgan")!.members.includes(NEW));
check(
  "and named, because the page is titled from that",
  getAccount("morgan")!.people?.[NEW] === "Morgan",
);
check("which is what accountOf now returns", accountOf(NEW) === "morgan");

// Running it twice is what happens when somebody mentions their budget three
// messages after setup. It must fill in, not fail and not duplicate.
const again = provision("morgan", { principal: NEW, budget: 120 });
check(
  "running it again does not create a second household",
  !again.created && listAccounts().length === 1,
);
check("it fills in what was volunteered later", getAccount("morgan")!.budget === 120);
check("without dropping what was already there", getAccount("morgan")!.people?.[NEW] === "Morgan");

// One person, one kitchen. The registry enforces this on join and create; this
// is the third door into it.
check(
  "somebody else's kitchen cannot be silently joined",
  (() => {
    provision("bailey", { principal: OTHER });
    try {
      provision("bailey", { principal: NEW });
      return false;
    } catch {
      return getAccount("bailey")!.members.length === 1;
    }
  })(),
);

check(
  "and a second kitchen cannot be opened for the same person",
  (() => {
    try {
      provision("morgan-two", { principal: NEW });
      return false;
    } catch {
      return getAccount("morgan-two") === null;
    }
  })(),
);

/* ── the checklist is derived, not stored ────────────────────────────────── */

// A stored "setup complete" flag is a claim that outlives what it describes:
// empty the ledger and the flag still says finished. Every step here reads the
// real artifact, so this cannot go stale.
section("readiness");

const st0 = state("morgan");
check("a fresh household is not ready", !st0.ready);
check("because it has no shelves", !st0.steps.find((s) => s.id === "shelves")!.done);
check("and no page", !st0.steps.find((s) => s.id === "site")!.done);
check("but it does know who lives there", st0.steps.find((s) => s.id === "people")!.done);

/* ── photographs propose, humans decide ──────────────────────────────────── */

section("first stock-up");

const props: Proposal[] = [
  {
    id: "eggs",
    name: "Eggs",
    cat: "dairy",
    loc: "fridge",
    qty: 12,
    unit: "ct",
    because: "open carton",
  },
  {
    id: "rice",
    name: "Rice",
    cat: "pantry",
    loc: "pantry",
    qty: null,
    unit: null,
    because: "a bag",
  },
  {
    id: "milk",
    name: "Milk",
    cat: "dairy",
    loc: "fridge",
    qty: 1,
    unit: "gal",
    because: "door shelf",
  },
];
const put = acceptStock("morgan", props);
check("accepted items land on the shelves", live("morgan").length === 3);
check(
  "as one batch, so a bad reading is one retraction",
  new Set(
    readLog("morgan")
      .filter((e) => e.src === "onboard")
      .map((e) => e.batch),
  ).size === 1,
);
check(
  "a bag keeps its unknown quantity rather than being invented as one",
  live("morgan").find((i) => i.id === "rice")!.qty === null,
);
check("a counted thing keeps its count", live("morgan").find((i) => i.id === "eggs")!.qty === 12);
check("and the batch is reported so it can be undone", Boolean(put.batch));

// Somebody will photograph the same fridge twice. Doubling their eggs because
// of it would be exactly the kind of quiet wrongness this ledger exists to
// avoid.
const twice = acceptStock("morgan", props);
check("running the same photo again adds nothing", twice.added.length === 0);
check("and says what it skipped instead of staying silent", twice.skipped.length === 3);
check("with the shelves unchanged", live("morgan").length === 3);

check(
  "five things is enough to call the shelves done",
  (() => {
    acceptStock("morgan", [
      {
        id: "butter",
        name: "Butter",
        cat: "dairy",
        loc: "fridge",
        qty: 1,
        unit: "ct",
        because: "",
      },
      {
        id: "onions",
        name: "Onions",
        cat: "produce",
        loc: "pantry",
        qty: 3,
        unit: "ct",
        because: "",
      },
    ]);
    return state("morgan").steps.find((s) => s.id === "shelves")!.done;
  })(),
);

// Ready means usable, and a household that has not cooked yet is usable.
// Holding it hostage to a logged meal would tell somebody their setup is broken
// when the only thing missing is dinner.
check(
  "a stocked, named, published kitchen is ready even before its first meal",
  (() => {
    const { updateAccount } = require("../src/accounts.ts");
    updateAccount("morgan", { site: { artifact: BASE, url: "https://example.test/?key=x" } });
    const s = state("morgan");
    return s.ready && !s.steps.find((x) => x.id === "cooked")!.done;
  })(),
);
