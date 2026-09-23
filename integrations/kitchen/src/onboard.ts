/**
 * Onboarding: from "what can I make with chicken" to a working household.
 *
 * Nothing is created until everything needed can be, because a half-set-up
 * household (an account with empty shelves) gives worse answers than none.
 *
 * Only two things are asked for, because nothing can derive them: who eats
 * here, and what is on the shelves (from photographs, not a questionnaire).
 * Everything else (meal times, spend, tastes) is folded from the log once one
 * exists. The optional arguments below capture those details when somebody
 * volunteers them; they are never prompted for.
 */

import { createAccount, getAccount, idOk, listAccounts, updateAccount } from "./accounts.ts";
import { loadCookbook } from "./cookbook.ts";
import { append, live, readLog } from "./store.ts";
import { type Account, CATEGORIES, type Category, LOCATIONS, type Location } from "./types.ts";

/* ── is this person a candidate ──────────────────────────────────────────── */

/**
 * The household a principal belongs to, or null. Unlike `resolveAccount`, an
 * unknown caller is a normal answer here: it is who onboarding is for.
 */
export function accountOf(principal: string | null): string | null {
  if (!principal) return null;
  for (const a of listAccounts()) if (a.members.includes(principal)) return a.id;
  return null;
}

/* ── the checklist ───────────────────────────────────────────────────────── */

export type Step = {
  id: "shelves" | "people" | "site" | "cooked";
  done: boolean;
  /** What this step is for, in plain words. */
  what: string;
  /** The next concrete move when it is not done. */
  next: string;
};

export type State = {
  account: string | null;
  /** True once the parts that make the system usable are all in place. */
  ready: boolean;
  steps: Step[];
  /** One line that can be said verbatim. */
  summary: string;
};

/**
 * How far along a household is, derived from its data rather than stored, so a
 * household that empties its ledger goes back to needing shelves.
 */
export function state(account: string | null): State {
  if (!account) {
    return {
      account: null,
      ready: false,
      summary: "no kitchen yet",
      steps: [
        {
          id: "shelves",
          done: false,
          what: "a kitchen of their own",
          next: 'kitchen_onboard action:"start" once they have said yes',
        },
      ],
    };
  }
  const acct = getAccount(account);
  if (!acct) throw new Error(`No household "${account}".`);
  const stock = live(account);
  const named = Object.keys(acct.people ?? {}).length > 0;
  const steps: Step[] = [
    {
      id: "shelves",
      done: stock.length >= 5,
      what: "what is actually in the kitchen",
      next: stock.length
        ? `only ${stock.length} things tracked; ask for another photo of a shelf or cupboard`
        : 'ask them to photograph the fridge and one cupboard, then kitchen_onboard action:"stock"',
    },
    {
      id: "people",
      done: named,
      what: "who eats here, so the page is titled for them and calories are per person",
      next: 'kitchen_onboard action:"start" again with `people`, or kitchen_accounts',
    },
    {
      id: "site",
      done: Boolean(acct.site?.url),
      what: "their own page, which is where every button lives",
      next: acct.site?.artifact
        ? "the site is rendered but has no public link yet; share it and record the url"
        : "kitchen_site to render it, then share it",
    },
    {
      id: "cooked",
      done: readLog(account).some((e) => e.src === "cooked"),
      what: "one meal actually logged, which is what starts every derived answer",
      next: "not a blocker; it happens on its own the first time they cook",
    },
  ];
  // A logged meal improves the kitchen but is not needed for it to work, so it
  // does not hold back "ready".
  const ready = steps.filter((s) => s.id !== "cooked").every((s) => s.done);
  const left = steps.filter((s) => !s.done && s.id !== "cooked");
  return {
    account,
    ready,
    steps,
    summary: ready
      ? `${account} is set up: ${stock.length} things tracked, ${loadCookbook(account).length} recipes written`
      : `${account} still needs ${left.map((s) => s.id).join(" and ")}`,
  };
}

/* ── provisioning ────────────────────────────────────────────────────────── */

export type Provisioned = { account: string; created: boolean; state: State };

/**
 * Create a household, or fill in what an existing one is missing.
 *
 * Every precondition is checked before anything is written, so there is no
 * half-provisioned state. Idempotent: calling it again is how optional details
 * are added later.
 */
export function provision(
  id: string,
  opts: {
    principal: string;
    /** Display name for that principal. The page is titled from these. */
    person?: string | null;
    name?: string | null;
    place?: { lat: number; lon: number; label?: string | null } | null;
    budget?: number | null;
    /** Only if volunteered. Never prompt for these. */
    avoid?: string[];
    stores?: string[];
  },
): Provisioned {
  if (!idOk(id)) {
    throw new Error(
      `"${id}" will not work as a household id: lowercase letters, digits and dashes, 2 to 32 characters. Something like "morgan" or "elm-street".`,
    );
  }
  if (!opts.principal?.trim()) {
    throw new Error("A household needs a principal, so there is somebody it belongs to.");
  }
  const existing = accountOf(opts.principal);
  if (existing && existing !== id) {
    throw new Error(
      `${opts.principal} already belongs to "${existing}". One person, one kitchen — ` +
        `two is how ledgers get mixed. Use "${existing}", or have them leave it first.`,
    );
  }

  const had = Boolean(getAccount(id));
  if (!had) {
    createAccount(id, { name: opts.name || id, members: [opts.principal] });
  } else if (!getAccount(id)!.members.includes(opts.principal)) {
    throw new Error(
      `"${id}" already exists and ${opts.principal} is not in it. Pick a different id, or join the existing household deliberately with kitchen_accounts.`,
    );
  }

  const patch: Partial<Account> = {};
  if (opts.person?.trim()) {
    patch.people = { ...(getAccount(id)!.people ?? {}), [opts.principal]: opts.person.trim() };
  }
  if (opts.name?.trim()) patch.name = opts.name.trim();
  if (opts.place) patch.place = opts.place;
  if (typeof opts.budget === "number" && opts.budget > 0) patch.budget = opts.budget;
  if (opts.stores?.length) patch.stores = opts.stores;
  if (opts.avoid?.length) patch.diet = { ...(getAccount(id)!.diet ?? {}), avoid: opts.avoid };
  if (Object.keys(patch).length) updateAccount(id, patch);

  return { account: id, created: !had, state: state(id) };
}

/* ── a first stock-up from photographs ───────────────────────────────────── */

export type Proposal = {
  /** Ledger slug this would create. */
  id: string;
  name: string;
  cat: Category;
  loc: Location;
  /** Countable things get a count; a jar of something does not. */
  qty: number | null;
  unit: string | null;
  /** What in the photo says so, shown to the person before they accept it. */
  because: string;
};

/**
 * The brief for reading a first set of kitchen photographs.
 *
 * The opposite of the shelf check: with no ledger yet there is no checklist to
 * verify, so the model lists what it can see. The result is only a proposal;
 * the person reviews the list before `acceptStock` writes anything.
 */
export function stockBrief(files: string[], where?: string | null): string {
  return [
    `Look at ${files.length === 1 ? "this photograph" : `these ${files.length} photographs`} of a kitchen${where ? `, specifically the ${where}` : ""}, for somebody setting up a food ledger for the first time:`,
    files.map((f) => `  ${f}`).join("\n"),
    "",
    "List the food you can actually see, so it can be put on their shelves.",
    "",
    "Rules:",
    "",
    "1. Only what is VISIBLE. Do not infer that a kitchen has salt because kitchens",
    "   have salt. If it is not in the picture it does not go in the list.",
    '2. Name things the way the person would say them: "chicken thighs", not',
    '   "poultry, boneless". If a brand is the only readable thing, use the food.',
    "3. Count only what is countable and fully visible. Six eggs in an open carton is",
    "   six. A bag of rice is not a number, it is a bag: give qty null.",
    `4. cat is one of: ${CATEGORIES.join(", ")}.`,
    `5. loc is one of: ${LOCATIONS.join(", ")}, where it is in THIS photo.`,
    "6. One entry per distinct food. Do not list the same thing twice because it",
    "   appears on two shelves.",
    "",
    "Show the person the list and say in a sentence what the photographs could not",
    `show. Drop what they say is wrong, then kitchen_onboard action:"accept" with`,
    "items:[{name, cat, loc, qty, unit}] for what survives.",
  ].join("\n");
}

/**
 * Put accepted proposals on the shelves as one batch, so a bad reading is a
 * single undo. Items the ledger already has are skipped, making a repeat run on
 * the same photograph harmless.
 */
export function acceptStock(
  account: string,
  proposals: Proposal[],
  why = "first stock-up from photos",
): { batch: string | null; added: Proposal[]; skipped: string[] } {
  const have = new Set(live(account).map((i) => i.id));
  const added = proposals.filter((p) => !have.has(p.id));
  const skipped = proposals.filter((p) => have.has(p.id)).map((p) => p.id);
  if (!added.length) return { batch: null, added: [], skipped };
  const batch = append(
    account,
    added.map((p) => ({
      op: "add" as const,
      item: p.id,
      qty: p.qty,
      unit: p.unit,
      fields: { name: p.name, cat: p.cat, loc: p.loc },
      why,
      src: "onboard",
    })),
  );
  return { batch, added, skipped };
}
