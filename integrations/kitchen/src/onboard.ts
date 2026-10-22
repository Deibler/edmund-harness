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
 *
 * The offer is made on the first food question, after it is answered, and the
 * first week after setup has three check-ins (see `CHECKINS`).
 */

import type { JobInput } from "../../../src/cron/types.ts";
import {
  createAccount,
  eaters,
  getAccount,
  householdTitle,
  idOk,
  listAccounts,
  updateAccount,
} from "./accounts.ts";
import { loadCookbook } from "./cookbook.ts";
import { siteStatus } from "./host.ts";
import type { Decision } from "./prospects.ts";
import { siteOrigin } from "./settings.ts";
import { append, droppedBatches, live, readLog } from "./store.ts";
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

/* ── the offer ───────────────────────────────────────────────────────────── */

/** Who is asking, as far as the offer is concerned. */
export type Caller = {
  /** Other people in a group chat, by name. Absent in a direct message. */
  group?: string[] | null;
  /** People in that group who already have a kitchen. */
  housed?: Array<{ name: string; account: string }>;
};

/** A group bigger than this is not offered a kitchen at all. */
export const MAX_GROUP = 3;

/** What the service is, for the model to say in its own words. */
export const PITCH = [
  "What to get across, briefly, in your own words, tied to what they just asked:",
  "- What it is: you keep track of what is in their kitchen, so food answers come from what they actually have instead of from nothing.",
  '- What they get: "what can I make tonight" answered from their own shelves, a heads-up before something goes off, a shopping list that fills itself as things run out, and their own page with what is in the kitchen, recipes written for them and what they spend. Dinner texted at a time they pick, if they want it.',
  "- What it takes: a photo of the fridge and one of a cupboard now, then a photo of the receipt when they shop. No logging and no forms; you work out the rest and ask a quick yes or no when unsure.",
  "Two or three sentences, not a brochure, ending on an easy yes or no. If they want detail, give it.",
].join("\n");

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/**
 * What a chat with no kitchen is told on a food question. The answer always
 * comes first: holding it back until setup was done once cost somebody a
 * meatloaf time for 46 minutes.
 */
export function offerBrief(c: Caller, d: Decision, asks: string[] = []): string {
  const head =
    "No kitchen is set up for this chat yet. Answer what they asked in full, from what you know. Never hold an answer back for setup.";
  if (c.group && c.group.length > MAX_GROUP) {
    return `${head}\n\nThis group has ${c.group.length} people, too many to share one kitchen. Do not offer one here.`;
  }
  if (d.kind === "stop") {
    const why =
      d.why === "declined"
        ? `They said no to a kitchen on ${day(d.since)}.`
        : `They were offered a kitchen twice, last on ${day(d.since)}, and never took it up.`;
    return `${head}\n\n${why} Do not bring it up again. If they raise it themselves, kitchen_onboard action:"start".`;
  }
  if (d.kind === "wait") {
    return `${head}\n\nYou offered them a kitchen on ${day(d.since)}. Do not offer it again yet. If this message answers it, a yes is kitchen_onboard action:"start" and a no is kitchen_onboard action:"decline".`;
  }

  const lines = [head, ""];
  if (c.group?.length) {
    lines.push(
      `This is a group chat with ${c.group.length > 1 ? `${c.group.slice(0, -1).join(", ")} and ${c.group.at(-1)}` : c.group[0]}. Offer only if they plausibly share one kitchen: a couple, or people who live together. You know them; if you are not sure, do not offer, just answer.`,
    );
    for (const h of c.housed ?? []) {
      lines.push(
        `${h.name} already has a kitchen ("${h.account}"). If this group eats from it, ask whether to link this chat to it instead, and on a yes: kitchen_accounts action:"join" account:"${h.account}".`,
      );
    }
    lines.push("");
  }
  if (asks.length > 1) {
    lines.push(`They have asked you about food ${asks.length} times since ${day(asks[0]!)}.`);
  }
  lines.push(
    d.again
      ? "They heard this offer once and did not answer. Make it one more time, in the same message as your answer, from a different angle: how what you just answered would have gone with their kitchen tracked. After this it stops."
      : "Then, in the same message as your answer, offer to keep track of their kitchen.",
    "",
    PITCH,
    "",
    'On a yes: kitchen_onboard action:"start" id:"<short-name>" person:"<their name>". On a no: kitchen_onboard action:"decline", and that is final.',
  );
  return lines.join("\n");
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
  const unnamed = eaters(acct).filter((e) => !acct.people?.[e.principal]);
  // With a permanent address the site counts only once it answers there; a
  // recorded URL alone is how a dead link passed for set up.
  const site = siteOrigin() ? siteStatus({ ...acct, id: account }) : null;
  const siteDone = site ? site.state === "live" : Boolean(acct.site?.url);
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
      done: unnamed.length === 0,
      what: "who eats here, so the page is titled for them and calories are per person",
      next: `no name for ${unnamed.map((e) => e.label).join(", ")}, and contacts had none; ask what to call them, then kitchen_onboard action:"start" person:"<name>" from their chat`,
    },
    {
      id: "site",
      done: siteDone,
      what: "their own page, which is where every button lives",
      next:
        site?.state === "down"
          ? `published but not answering (${site.why}); kitchen_site re-publishes it, and if that fails the kitchen host is down`
          : "kitchen_site renders it, publishes it and returns the link once it answers",
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
  if (!had) patch.onboarded = { at: new Date().toISOString(), via: opts.principal };
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

/**
 * What to tell somebody when their page goes out. The first setup through this
 * file ended with a bare link: three receipts that week, none after.
 */
export const HOW_IT_WORKS = [
  "When you send the link, say in a few short lines how it works from here. This message decides whether they use it:",
  "- When they shop: a photo of the receipt. That is the one habit, and it keeps the kitchen true.",
  "- When they wonder what to cook: just ask. You answer from what they have and the recipe lands on their page.",
  "- Nothing to keep up: no logging. You work out what got used and ask a quick yes or no when unsure.",
  "- The page: what is in the kitchen, their recipes, the shopping list and what they spend. Worth saving to the home screen.",
  "- Offer once, at the end: dinner texted at a time they pick (kitchen_schedule).",
].join("\n");

/* ── the first week ──────────────────────────────────────────────────────── */

/**
 * Three check-ins after setup, because a new kitchen gets used for about a week
 * and then forgotten: the two households set up for other people both went
 * quiet after their first week. Each is a wake-up in the chat where setup happened,
 * and what it asks for is decided from the ledger when it fires, so one that
 * is no longer needed ends quietly.
 */
export const CHECKINS = [
  { kind: "dinner", day: 1, hour: 16, minute: 0 },
  { kind: "receipt", day: 4, hour: 17, minute: 30 },
  { kind: "recap", day: 7, hour: 16, minute: 0 },
] as const;

export type CheckinKind = (typeof CHECKINS)[number]["kind"];

/** A check-in this late is skipped: a dinner idea at nine at night helps nobody. */
export const CHECKIN_GRACE_MS = 2 * 3_600_000;

const NOTHING = "Nothing to send. Reply with exactly KEEP_QUIET.";
const SKIP = "reply with exactly KEEP_QUIET instead";

/** Queue the first week's check-ins in local time, counted in days from `from`. */
export function scheduleCheckins(
  account: string,
  via: string,
  create: (input: JobInput) => { id: string },
  from = new Date(),
): Array<{ kind: CheckinKind; atMs: number; job: string }> {
  const acct = getAccount(account);
  if (!acct) throw new Error(`No household "${account}".`);
  return CHECKINS.map((c) => {
    const at = new Date(from);
    at.setDate(at.getDate() + c.day);
    at.setHours(c.hour, c.minute, 0, 0);
    const job = create({
      sessionKey: via,
      systemEvent: `[Kitchen · ${householdTitle(acct)}] Day ${c.day} since setup. Call kitchen_onboard action:"checkin" kind:"${c.kind}" and do what it says.`,
      schedule: { kind: "once", atMs: at.getTime() },
      gracePeriodMs: CHECKIN_GRACE_MS,
      harnessWritten: true,
    });
    return { kind: c.kind, atMs: at.getTime(), job: job.id };
  });
}

/** What a check-in asks for, from what the household has done since setup. */
export function checkinBrief(account: string | null, kind: CheckinKind): string {
  const acct = account ? getAccount(account) : null;
  if (!account || !acct) return `This chat has no kitchen any more. ${NOTHING}`;
  const since = acct.onboarded?.at ?? acct.created;
  // Parsed, not compared as text: the ledger writes whole seconds and "+00:00",
  // this has milliseconds and "Z".
  const t0 = Math.floor(Date.parse(since) / 1000) * 1000;
  const log = readLog(account);
  const undone = droppedBatches(log);
  const after = log.filter((e) => Date.parse(e.ts) >= t0 && !undone.has(e.batch));
  const receipts = new Set(
    after.filter((e) => /^(receipt|trip):/.test(e.src ?? "")).map((e) => e.src),
  ).size;
  const cooked = new Set(after.filter((e) => e.src === "cooked").map((e) => e.batch)).size;
  const planned = after.filter((e) => e.op === "plan").length;

  if (kind === "dinner") {
    if (cooked || planned) {
      return `They have already ${cooked ? "cooked" : "planned a meal"} with it since setup. ${NOTHING}`;
    }
    return [
      "First full day with their kitchen tracked. Show them what it is for:",
      "one dinner idea for tonight built from what is on their shelves (kitchen_status, then kitchen_plan so every ingredient is checked against stock).",
      "One short text ending in a yes or no, like asking whether they want it tonight. No recipe until they say yes.",
      `If you already talked food with them today, ${SKIP}.`,
    ].join("\n");
  }

  if (kind === "receipt") {
    if (receipts) return `A receipt has come in since setup. ${NOTHING}`;
    return [
      `No receipt since setup on ${day(since)}, so the kitchen still only knows the first photos.`,
      "One line: if they have been shopping, a photo of the receipt keeps the kitchen current. Nothing more.",
      `If they have said they have not shopped yet, or you already talked food with them today, ${SKIP}.`,
    ].join("\n");
  }

  const stock = live(account);
  const low = stock.filter((i) => i.level === "low" || i.level === "out").map((i) => i.name);
  return [
    `One week in: ${stock.length} things tracked, ${receipts} receipt${receipts === 1 ? "" : "s"} and ${cooked} meal${cooked === 1 ? "" : "s"} logged since setup.`,
    low.length ? `Running low: ${low.slice(0, 6).join(", ")}.` : "",
    "A short text: one useful thing from their kitchen right now (what to use up first, or a dinner it can make tonight).",
    acct.dinners?.length
      ? ""
      : "Then offer once to text them dinner at a time they pick (kitchen_schedule).",
    receipts || cooked
      ? ""
      : 'They have not used it yet this week, so make the easiest next step obvious: "just ask me what to make".',
    "Your reply goes to them as a text.",
  ]
    .filter(Boolean)
    .join("\n");
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
