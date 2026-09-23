/**
 * Onboarding: nothing is half-built, the checklist is derived from real data, and
 * photographs only propose.
 *
 * The photo reading itself happens in the household's main session; what is tested is
 * everything around it.
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

// `accountOf` must answer for somebody with no kitchen, unlike `resolveAccount`,
// which throws.
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

// Provisioning again fills in details without failing or duplicating.
const again = provision("morgan", { principal: NEW, budget: 120 });
check(
  "running it again does not create a second household",
  !again.created && listAccounts().length === 1,
);
check("it fills in what was volunteered later", getAccount("morgan")!.budget === 120);
check("without dropping what was already there", getAccount("morgan")!.people?.[NEW] === "Morgan");

// One person, one kitchen, enforced on this path too.
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

// The checklist reads real data, so it cannot go stale the way a stored flag would.
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

// Accepting the same photograph twice must not double the stock.
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

// Ready means usable; a household that has not cooked yet is usable.
check(
  "a stocked, named, published kitchen is ready even before its first meal",
  (() => {
    const { updateAccount } = require("../src/accounts.ts");
    updateAccount("morgan", { site: { artifact: BASE, url: "https://example.test/?key=x" } });
    const s = state("morgan");
    return s.ready && !s.steps.find((x) => x.id === "cooked")!.done;
  })(),
);
