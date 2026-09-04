/**
 * Getting somebody from "what can I make with chicken" to a real kitchen.
 *
 * The people already using this were set up by hand, one tool call at a time,
 * by me, over an evening. That does not scale past the people I do it for, and
 * worse, a half-finished setup is the failure mode: an account with no shelves
 * gives worse answers than no account at all, because now every reply is
 * hedged against a ledger that knows nothing. Somebody who opts in and finds a
 * page saying their kitchen is empty has learned that this does not work.
 *
 * So the shape here is: nothing is created until everything can be, and what a
 * person is asked for is only what cannot be derived.
 *
 * WHAT MUST BE ASKED. Two things, and they are both facts about the world that
 * no amount of cleverness recovers: who eats here, and what is on the shelves.
 * The second is a photograph, not a questionnaire, because a person will point
 * a camera at a fridge and will not type in forty items.
 *
 * WHAT MUST NOT BE ASKED. Everything else. When they eat, how often they cook,
 * what they spend, what they like, how many meals a week — every one of those
 * is a fold over the log once there is a log, and asking for it up front trades
 * a minute of a stranger's patience for an answer that is worse than the one
 * the system would have worked out by itself. This is the same rule the rest of
 * the integration runs on and the reason there is no settings form anywhere in
 * it. The optional arguments below exist to CAPTURE those when somebody
 * volunteers them in conversation, never to prompt for them.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { createAccount, getAccount, idOk, listAccounts, updateAccount } from "./accounts.ts";
import { loadCookbook } from "./cookbook.ts";
import { openrouterKey } from "./openrouter.ts";
import { append, live, readLog, slug } from "./store.ts";
import { type Account, CATEGORIES, type Category, LOCATIONS, type Location } from "./types.ts";

/* ── is this person even a candidate ─────────────────────────────────────── */

/**
 * Whether a principal already has a kitchen, without throwing.
 *
 * `resolveAccount` deliberately fails hard for an unknown caller, which is
 * right when a tool is about to read or write food. It is wrong as the thing
 * that decides whether to make an offer, because "no account" is the entire
 * population this feature is for.
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
  /** What this step is for, in the words I would use saying it out loud. */
  what: string;
  /** The next concrete move when it is not done. */
  next: string;
};

export type State = {
  account: string | null;
  /** True once the parts that make the system usable are all in place. */
  ready: boolean;
  steps: Step[];
  /** One line I can say verbatim. */
  summary: string;
};

/**
 * How far along a household is, derived rather than stored.
 *
 * A stored "onboarding_complete" flag is a claim that can outlive the thing it
 * describes: delete every item and the flag still says finished. Each of these
 * reads the actual artifact, so a household that empties its ledger correctly
 * goes back to needing shelves.
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
  // The first three are what make it work. A meal is the thing that makes it
  // get better, and holding "ready" hostage to it would mean telling somebody
  // their setup is incomplete when the only thing missing is dinner.
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
 * Every precondition is checked before anything is written, because the whole
 * point is that there is no half-provisioned state to be stuck in. Calling it
 * twice is safe and is how the optional details get added later, when somebody
 * mentions them in conversation rather than when a form demanded them.
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

/* ── reading a first stock-up out of photographs ─────────────────────────── */

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

export type FirstStock = {
  proposals: Proposal[];
  /** What the photographs could not show. Said out loud, never inferred past. */
  note: string;
};

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".gif": "image/gif",
};

/**
 * What is in these pictures, as things to add.
 *
 * The deliberate opposite of `readShelves`, and the difference is the ledger.
 * That one hands the model a checklist and forbids it from naming anything new,
 * because against an established kitchen "what food do you see" produces a
 * shopping catalogue that would bury real corrections. Here there is no ledger
 * yet — the checklist would be empty, every real item would come back as an
 * unactionable `unknown`, and the household would finish onboarding with an
 * empty fridge.
 *
 * Still proposals, never writes. A photo is a sample, not an audit; the whole
 * output goes in front of a person before a single event is appended.
 */
export async function firstStock(files: string[], where?: string | null): Promise<FirstStock> {
  if (!files.length) return { proposals: [], note: "no photographs were given" };
  const images = files.map((f) => {
    const mime = MIME[extname(f).toLowerCase()] ?? "image/jpeg";
    return {
      type: "image_url" as const,
      image_url: { url: `data:${mime};base64,${readFileSync(f).toString("base64")}` },
    };
  });

  const prompt = [
    `These are photographs of a kitchen${where ? `, specifically the ${where}` : ""} belonging to somebody who is setting up a food ledger for the first time.`,
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
    `5. loc is one of: ${LOCATIONS.join(", ")} — where it is in THIS photo.`,
    "6. One entry per distinct food. Do not list the same thing twice because it",
    "   appears on two shelves.",
    "",
    `Return JSON: {"items":[{"name":"...","cat":"...","loc":"...","qty":number-or-null,`,
    `"unit":"ct|lb|oz|bag|box|jar|can|bottle|pack|null","because":"what in the photo shows this"}],`,
    `"note":"one sentence on what these photographs could not show"}`,
  ].join("\n");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openrouterKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4.5",
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...images] }],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const parsed = JSON.parse(data.choices[0]!.message.content) as {
    items?: Array<Record<string, unknown>>;
    note?: string;
  };

  // Everything below is coercion, not trust. The model is answering about a
  // photograph and its category guesses land in a typed ledger.
  const seen = new Set<string>();
  const proposals: Proposal[] = [];
  for (const raw of parsed.items ?? []) {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name) continue;
    const id = slug(name);
    if (seen.has(id)) continue;
    seen.add(id);
    const qty =
      typeof raw.qty === "number" && Number.isFinite(raw.qty) && raw.qty > 0 ? raw.qty : null;
    proposals.push({
      id,
      name,
      cat: (CATEGORIES as readonly string[]).includes(raw.cat as string)
        ? (raw.cat as Category)
        : "other",
      loc: (LOCATIONS as readonly string[]).includes(raw.loc as string)
        ? (raw.loc as Location)
        : "pantry",
      qty,
      unit:
        qty === null ? null : typeof raw.unit === "string" && raw.unit !== "null" ? raw.unit : "ct",
      because: typeof raw.because === "string" ? raw.because : "visible in the photo",
    });
  }
  return {
    proposals,
    note:
      typeof parsed.note === "string" && parsed.note.trim()
        ? parsed.note
        : "a photograph shows one angle; anything behind something else is not in this list",
  };
}

/**
 * Put accepted proposals on the shelves, as one batch.
 *
 * One batch so a bad reading is one retraction rather than forty, which is the
 * same property that lets the automatic cleanup guess at all. Anything the
 * ledger already has is skipped rather than doubled — running this twice on the
 * same photograph is a thing a person will do.
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

/**
 * A directory this household's site can live in, made before it is recorded.
 *
 * Here rather than in the tool so that "provisioned" means the folder exists,
 * not that a path was written into the registry and might not.
 */
export function siteDir(account: string, base: string): string {
  const dir = join(base, `kitchen-${account}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
