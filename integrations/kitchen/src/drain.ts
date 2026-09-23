/**
 * Settles site taps that need no judgement.
 *
 * The watch pass runs this every few seconds. Taps that are arithmetic over
 * existing state (confirming or calling off a meal, stars, notes, undoing a
 * cleanup, ticking off the list, preferences, schedules, shelf-check verdicts)
 * are applied here. Anything that needs writing or judgement (a recipe, a
 * variant, a question, what a dish needs from the store) is left in the queue
 * for `wake.ts` to bring to the right session.
 *
 * Nothing here messages anybody about their own tap.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eaters, getAccount, updateAccount } from "./accounts.ts";
import { getRecipe, loadCookbook } from "./cookbook.ts";
import { readExplore } from "./explore.ts";
import { addToList, removeFromList, setAmount } from "./list.ts";
import { VIBES, refreshWeather } from "./mood.ts";
import { requestNoteUpdate } from "./notelist.ts";
import { confirmPlan, cookedRecently, planFor, useLines } from "./plans.ts";
import { addNote, skipPair, toggleFavorite, unskipPair } from "./profile.ts";
import { METHOD_LABEL, loadRecipes } from "./recipes.ts";
import { type Verdict, answer as answerSession, applySession, ensureSession } from "./reconcile.ts";
import { type MakeRequest, markHandled, pending, requestKey } from "./requests.ts";
import { setDisposition, skip, unskip } from "./restock.ts";
import {
  type Dinner,
  carriedOver,
  describe,
  dinnersOf,
  normalize,
  recipeUrl,
  saveDinners,
  sendTo,
} from "./schedules.ts";
import { settleAfterPurchase, tripCount } from "./shopping.ts";
import { append, fold, live, openPlans, readLog, slug } from "./store.ts";
import { contained, positive, safeId } from "./util.ts";

/** Kinds this module may settle. Some settle only for certain inputs; see `needsPerson`. */
const AUTO = new Set([
  "plan",
  "favorite",
  "note",
  "unsweep",
  "shopped",
  // Only an empty pick; a real pick is a shopping decision for a person.
  "addlist",
  "pairskip",
  "photo",
  "reconcile",
  "cooked",
  "restock",
  "pref",
  "idealist",
  "sched",
  "keep",
  "notes",
  // Only when the dish is already written out; otherwise it needs a person.
  "make",
]);

export type DrainResult = {
  /** One line per request actually acted on, for the log. */
  done: string[];
  /** Requests that need a person, left in the queue untouched. */
  left: MakeRequest[];
  failed: string[];
};

/**
 * Resolve one request. Returns a log line, an empty string for "handled, not
 * worth logging", or null for "leave it for a person". Returning null for a
 * silently handled request would leave it queued and re-processed forever.
 */
async function handleOne(account: string, r: MakeRequest): Promise<string | null> {
  switch (r.kind) {
    case "plan": {
      if (!r.plan) return null;
      const p = openPlans(account)[r.plan];
      // Already resolved (a double tap or a retry): the state is what was asked.
      if (!p) return `plan ${r.plan}: already settled`;
      // Only "made" consumes. Anything else calls the meal off, the safe default:
      // wrongly consuming food empties shelves that are still full.
      if (r.note === "made") {
        return `plan ${r.plan} "${p.meal}": confirmed, ${confirmPlan(account, r.plan, p).summary}`;
      }
      append(account, [
        {
          op: "plan_void" as const,
          item: null,
          plan_id: r.plan,
          why: "called off from the site",
          src: "plan",
        },
      ]);
      return `plan ${r.plan} "${p.meal}": called off, nothing consumed`;
    }

    case "favorite": {
      if (!r.recipe || !r.profile) return null;
      let on = toggleFavorite(account, r.recipe, r.profile);
      // The page sends the wanted state; flip again if a stale tab disagreed.
      if (typeof r.on === "boolean" && on !== r.on) {
        on = toggleFavorite(account, r.recipe, r.profile);
      }
      // Report the stored state, not the requested one.
      return `favorite ${r.recipe}: ${on ? "starred" : "unstarred"}`;
    }

    case "note": {
      if (!r.text?.trim()) return null;
      const key = r.recipe ?? r.name ?? "";
      if (!key) return null;
      addNote(account, key, { who: r.profile ?? "unknown", text: r.text.trim() });
      return `note on ${r.name ?? key}: filed`;
    }

    case "unsweep": {
      if (!r.batch) return null;
      const already = readLog(account).some((e) => e.op === "undo" && e.batch_target === r.batch);
      if (already) return `unsweep ${r.batch}: already put back`;
      append(account, [
        {
          op: "undo" as const,
          batch_target: r.batch,
          why: "still here, said so on the site",
          src: "site",
        },
      ]);
      return `unsweep ${r.batch}: retracted`;
    }

    // An answer about a list line or tray suggestion. These are preferences, not
    // facts about food, so none touch the event log ("I already have this" is
    // posted as a `restock` instead).
    case "keep": {
      const id = r.id ?? "";
      const name = r.name ?? id;
      if (!id) return null;
      switch (r.note) {
        case "always":
          setDisposition(account, [id], "always", r.profile);
          unskip(account, [id]);
          return `keep ${name}: stocked from now on`;
        case "never":
          setDisposition(account, [id], "never", r.profile);
          removeFromList(account, [id]);
          return `keep ${name}: never suggesting it again`;
        case "skip":
          skip(account, [id], tripCount(account));
          return `keep ${name}: skipped for this trip`;
        case "once":
          // A one-time yes: listed now, no standing disposition.
          addToList(account, [
            {
              name,
              item: id,
              why: "you picked this off the suggestions",
              by: r.profile,
            },
          ]);
          return `keep ${name}: on this list only`;
        case "drop": {
          const n = removeFromList(account, [id]);
          return n ? `keep ${name}: taken off` : `keep ${name}: was not on the list`;
        }
        case "amount": {
          const amount = (r.text ?? "").trim();
          if (!amount) return `keep ${name}: no amount given`;
          addToList(account, [{ name, item: id, amount, by: r.profile }]);
          setAmount(account, id, amount);
          return `keep ${name}: buy ${amount}`;
        }
        default:
          return `keep ${name}: "${r.note}" is not something I know how to do`;
      }
    }

    case "notes": {
      // Nothing writes the note but Edmund on screen, so a tap asks for him:
      // the next watch pass wakes the household's session without waiting
      // for the list to settle.
      requestNoteUpdate(account);
      return "apple notes: asked Edmund to bring the note up to date";
    }

    case "shopped": {
      // A tick is evidence of presence, not of quantity or price: each known
      // item is added back with a null qty, and the receipt refines it later.
      // Without the add, derived staple lines would stay on the list.
      const ticked = (r.items ?? []).filter(Boolean);
      const n = removeFromList(account, ticked);
      const stock = fold(account);
      const known = ticked.filter((id) => stock[id]);
      if (known.length) {
        append(
          account,
          known.map((id) => ({
            op: "add" as const,
            item: id,
            qty: null,
            fields: {},
            why: `ticked off on the shopping list${r.profile ? ` (${r.profile})` : ""}`,
            src: "shopped",
          })),
        );
      }
      settleAfterPurchase(account, ticked);
      return (
        `shopping trip: ${known.length} back on the shelves, ` +
        `${n} written line${n === 1 ? "" : "s"} cleared. Quantities wait for the receipt.`
      );
    }

    case "pairskip": {
      // Declining one half of a cook-once-eat-twice pair: the suggestion stops.
      if (!r.recipe || !r.note) return null;
      if (r.note === "undo") {
        unskipPair(account, r.recipe);
        return `pair ${r.recipe}: back on`;
      }
      const leg = r.note === "parent" ? ("parent" as const) : ("child" as const);
      skipPair(account, r.recipe, leg, r.profile ?? null);
      return `pair ${r.recipe}: skipping the ${leg === "parent" ? "first" : "second"} half`;
    }

    // "Make this" for a dish already written out: send the existing page. A dish
    // with no page falls through to a person.
    case "make": {
      if (!r.recipe) return null;
      const acct = getAccount(account);
      const built = getRecipe(account, r.recipe);
      const url = acct ? recipeUrl(acct, r.recipe) : null;
      if (!acct || !built || !url) return null;
      const dir = acct.site?.artifact;
      if (!dir || !existsSync(join(dir, "recipe", `${r.recipe}.html`))) return null;

      // Marked served before sending, unlike other kinds: a lost send costs a
      // link they can still reach, while a replay texts a person twice.
      markHandled(account, [requestKey(r)]);
      const who = (r.users?.length ? r.users : eaters(acct).map((e) => e.principal)).filter(
        (p) => acct.members.includes(p) && !p.startsWith("imessage:group:"),
      );
      const body = `${built.name} is already written out, so here it is: ${url}`;
      const sent: string[] = [];
      for (const p of who) {
        try {
          sendTo(p, body);
          sent.push(p);
        } catch {
          /* reported below */
        }
      }
      return `make ${r.recipe}: already written, sent the page to ${sent.length ? `${sent.length} of ${who.length}` : "nobody, every send failed"}`;
    }

    case "cooked": {
      // "We made it" from a recipe page: the same fact as confirming a plan.
      if (!r.recipe) return null;
      // The one kind that is not naturally idempotent, so its writes carry the
      // request key and a replay can see it already ran.
      const key = requestKey(r);
      if (readLog(account).some((e) => e.req === key)) {
        return `cooked ${r.recipe}: already taken off the shelves`;
      }
      // An open plan wins: it holds tonight's agreed quantities, and confirming
      // it closes the plan so the meals page cannot charge the dinner again.
      const open = planFor(account, r.recipe, r.name);
      if (open) {
        return (
          `cooked "${open.plan.meal}" from its recipe page: ` +
          `${confirmPlan(account, open.id, open.plan, { req: key }).summary}`
        );
      }
      const { recipes } = loadRecipes(account);
      const cat = recipes.find((x) => x.id === r.recipe);
      const book = loadCookbook(account).find((x) => x.id === r.recipe);
      // The written recipe beats the catalog card with the same id: it was
      // written for this house around what was actually in the fridge.
      const needs = book?.needs ?? cat?.needs ?? [];
      if (!needs.length) return `cooked ${r.recipe}: no ingredient list, nothing to take off`;
      const meal = book?.name ?? cat?.name ?? r.name ?? r.recipe;
      // Two genuine taps have two keys; catch the second press separately.
      const already = cookedRecently(account, meal);
      if (already) {
        return `cooked "${meal}": already came off the shelves at ${already.at}, so this tap changed nothing`;
      }
      const stock = Object.fromEntries(live(account).map((i) => [i.id, i]));
      const used = needs.filter(([slug]) => stock[slug]);
      const yields = cat?.yields ?? [];
      if (!used.length && !yields.length) {
        return `cooked "${meal}": nothing it needs is on the shelves, so nothing came off`;
      }
      append(account, [
        ...useLines(
          account,
          used.map(([slug, q]) => ({ item: slug, qty: q })),
          meal,
          { req: key },
        ),
        ...yields.map(([slug]) => ({
          op: "add" as const,
          item: slug,
          qty: 1,
          unit: "container",
          fields: {
            name: `Leftover ${slug.replace(/^leftover-/, "").replace(/-/g, " ")}`,
            cat: "other" as const,
            loc: "fridge" as const,
          },
          why: `from ${meal}`,
          src: "cooked",
          req: key,
        })),
      ]);
      return `cooked "${meal}" from its recipe page: ${used.length} items off the shelves`;
    }

    case "restock": {
      // "I do have that": a person's word beats anything inferred.
      if (!r.items?.length) return null;
      const stock = Object.fromEntries(live(account).map((i) => [i.id, i]));
      const want = typeof r.qty === "number" ? r.qty : 1;
      // Covers both "marked gone but here" and "here but counted too low".
      const fix = r.items.filter((id) => {
        const it = stock[id];
        return !it || it.gone || (typeof it.qty === "number" && it.qty < want);
      });
      if (!fix.length) return `restock: the ledger already agrees`;
      append(
        account,
        fix.map((id) => ({
          op: "set" as const,
          item: id,
          qty: want,
          fields: {},
          why: `on the shelf after all${r.profile ? ` (${r.profile})` : ""}`,
          src: "reconcile",
        })),
      );
      return `corrected on the shelves: ${fix.map((id) => `${id} -> ${want}`).join(", ")}`;
    }

    case "reconcile": {
      // One shelf-check verdict, saved as it arrives so a dead phone loses
      // nothing. The ledger changes only when the pass is applied.
      if (!r.session) return null;
      if (r.note === "apply") {
        const res = applySession(account, r.session);
        if (!res) return `shelf check ${r.session}: nothing to save`;
        return (
          `shelf check by ${r.profile ?? "someone"}: ${res.confirmed} confirmed, ` +
          `${res.removed.length} gone, ${res.corrected.length} recounted (batch ${res.batch})`
        );
      }
      if (!r.item || !r.note) return null;
      ensureSession(account, r.session, r.profile ?? null);
      const verdict: Verdict =
        r.note === "gone"
          ? { kind: "gone" }
          : r.note === "amount" && typeof r.qty === "number"
            ? { kind: "amount", qty: r.qty, unit: r.unit ?? null }
            : { kind: "have" };
      answerSession(account, r.session, r.item, verdict, r.profile ?? null);
      // Handled but not logged: they arrive dozens at a time.
      return "";
    }

    case "photo": {
      // A real photo of the plate replaces the generated one, which is moved
      // aside rather than overwritten.
      if (!r.file || !r.recipe) return null;
      const dir = getAccount(account)?.site?.artifact;
      if (!dir) return null;
      // Both values come from a public endpoint, and the move below is a read
      // and a delete of `file`: confine it to the upload directory and require a
      // real recipe id.
      if (!safeId(r.recipe)) return `photo: "${r.recipe}" is not a recipe id`;
      const src = contained(dir, r.file, "img/upload");
      if (!src) return `photo for ${r.recipe}: refused, "${r.file}" is not an upload`;
      if (!existsSync(src)) return `photo for ${r.recipe}: upload had gone`;

      const step = Number(r.step);
      const dest =
        Number.isFinite(step) && step > 0
          ? join(dir, "img", "steps", `${r.recipe}-${step}.jpg`)
          : join(dir, "img", "meals", `${r.recipe}.jpg`);
      mkdirSync(dirname(dest), { recursive: true });
      if (!Number.isFinite(step) || step <= 0) {
        const keep = join(dir, "img", "meals-generated", `${r.recipe}.jpg`);
        if (existsSync(dest) && !existsSync(keep)) {
          mkdirSync(dirname(keep), { recursive: true });
          renameSync(dest, keep);
        }
      }
      renameSync(src, dest);
      return (
        `photo for ${r.recipe}${step > 0 ? ` step ${step}` : ""}: ` +
        `${Math.round(statSync(dest).size / 1024)}kb, now the picture on the card`
      );
    }

    case "addlist": {
      // An empty pick settles here. A real pick is a shopping decision for a
      // person (`kitchen_shopping add`); `needsPerson` must agree.
      if (!r.recipe) return `add to list: no recipe named, dropped`;
      if (!r.items?.length && !r.missing?.length)
        return `add to list for ${r.name ?? r.recipe}: nothing picked`;
      return null;
    }

    // Household preferences: an account write, no food changes.
    case "pref": {
      const acct = getAccount(account);
      if (!acct) return null;
      if (r.text === "vibe") {
        const id = r.note && VIBES.some((v) => v.id === r.note) ? r.note : null;
        updateAccount(account, { prefs: { ...(acct.prefs ?? {}), vibe: id } });
        return `vibe set to ${id ?? "whatever the day says"}`;
      }
      if (r.text === "settings") {
        const mode = ["prep", "normal", "ballout"].includes(r.note ?? "")
          ? (r.note as "prep" | "normal" | "ballout")
          : "normal";
        const methods = (r.items ?? []).filter((m) => m in METHOD_LABEL);
        // Zero or anything that is not a positive number (e.g. the string "50")
        // is stored as absent: no opinion.
        const budget = positive(r.qty);
        const perMeal = positive(r.amount);
        updateAccount(account, {
          budget,
          prefs: { ...(acct.prefs ?? {}), mode, per_meal: perMeal, avoid_methods: methods },
        });
        return `preferences: ${mode}${budget ? `, $${budget}/week` : ""}${perMeal ? `, $${perMeal}/dinner ceiling` : ""}${methods.length ? `, avoiding ${methods.join(", ")}` : ""}`;
      }
      return null;
    }

    // Shopping for an explore dish. Its buy list is already in plain shopping
    // words, so this is just a write.
    case "idealist": {
      const set = readExplore(account);
      const dish = set?.dishes.find((d) => d.id === r.recipe);
      if (!dish) return `add to list: idea ${r.recipe ?? ""} is no longer on the explore page`;
      const buy = dish.buy.length ? dish.buy : (r.missing ?? []);
      if (!buy.length) return `add to list for ${dish.name}: nothing to buy`;
      const { added, merged } = addToList(
        account,
        buy.map((name) => ({
          name,
          // No ledger slug: the house has never owned these.
          item: null,
          why: `to try ${dish.name}`,
          by: r.profile ?? null,
        })),
      );
      return `add to list for ${dish.name} (idea): +${added.length}${merged.length ? `, ${merged.length} already on it` : ""}`;
    }

    // A standing dinner text set from the page, validated against the household
    // by `normalize` because the body comes from a public endpoint.
    case "sched": {
      const acct = getAccount(account);
      if (!acct) return null;
      const list = dinnersOf(acct);
      if (r.note === "delete") {
        if (!r.recipe) return null;
        const left = list.filter((d) => d.id !== r.recipe);
        if (left.length === list.length) return `schedule ${r.recipe}: already gone`;
        saveDinners(account, left);
        return `schedule ${r.recipe}: deleted`;
      }
      if (r.note === "pause" || r.note === "resume") {
        if (!r.recipe) return null;
        const on = r.note === "resume";
        if (!list.some((d) => d.id === r.recipe)) return `schedule ${r.recipe}: no longer there`;
        saveDinners(
          account,
          list.map((d) => (d.id === r.recipe ? { ...d, on } : d)),
        );
        return `schedule ${r.recipe}: ${on ? "back on" : "paused"}`;
      }
      // An edit keeps only the old row's firing state; every visible field comes
      // from the body.
      const was = list.find((x) => x.id === r.recipe);
      const d = normalize(
        {
          id: r.recipe,
          at: r.at,
          days: r.days,
          to: r.users ?? [],
          meal: r.meal as Dinner["meal"],
          note: r.text ?? null,
          on: true,
          ...carriedOver(was),
        },
        acct,
      );
      const rest = list.filter((x) => x.id !== d.id);
      saveDinners(account, [...rest, d]);
      return `schedule ${d.id}: ${describe(d, acct)}`;
    }

    default:
      return null;
  }
}

/**
 * Settle everything on this household's site that needs no person.
 *
 * Each request is acted on and then marked served, one at a time. A crash
 * between the two replays the request, so every kind handled here must be
 * idempotent (`cooked` achieves that with a request stamp). Keep that property
 * when adding a kind to AUTO.
 */
export async function drain(account: string): Promise<DrainResult> {
  const out: DrainResult = { done: [], left: [], failed: [] };
  const acct = getAccount(account);
  const dir = acct?.site?.artifact;
  if (!dir) return out;

  // Also keeps the page's weather current. Best-effort: a stale reading is
  // simply not shown.
  try {
    await refreshWeather(account, acct);
  } catch {
    // The cache ages out on its own.
  }

  for (const r of pending(account, dir)) {
    if (!AUTO.has(r.kind)) {
      out.left.push(r);
      continue;
    }
    try {
      const line = await handleOne(account, r);
      if (line === null) {
        out.left.push(r);
        continue;
      }
      markHandled(account, [requestKey(r)]);
      if (line) out.done.push(line);
    } catch (e) {
      // Left in the queue: retried next pass, and surfaces as still waiting.
      out.failed.push(`${r.kind} ${r.recipe ?? r.plan ?? ""}: ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * Whether a request is waiting on a person rather than on the next pass. This
 * decides who gets woken, so it must match `handleOne` exactly per kind: `make`
 * settles only when the page exists, `addlist` only when nothing was picked.
 * The drain test pins the two together.
 */
export function needsPerson(account: string, dir: string, r: MakeRequest): boolean {
  if (!AUTO.has(r.kind)) return true;
  if (r.kind === "make") {
    return !(
      r.recipe &&
      getRecipe(account, r.recipe) &&
      existsSync(join(dir, "recipe", `${r.recipe}.html`))
    );
  }
  if (r.kind === "addlist") return Boolean(r.recipe && (r.items?.length || r.missing?.length));
  return false;
}

/** Unserved requests for this household that are waiting on a person. */
export function stillWaiting(account: string): MakeRequest[] {
  const acct = getAccount(account);
  const dir = acct?.site?.artifact;
  if (!dir) return [];
  return pending(account, dir).filter((r) => needsPerson(account, dir, r));
}

/** The queue file published after each pass. */
export type Queue = {
  /** When the pass finished; a stale value means the loop is down. */
  at: string;
  account: string;
  waiting: Array<{ key: string; kind: string; recipe?: string; name?: string }>;
  /** Anything that failed this pass, so a broken render is not silent. */
  trouble?: string;
};

/**
 * Publish what is still waiting on a person, after the pass has settled what
 * it can, so the file never lists a request already taken.
 *
 * Rewritten every pass, changed or not: `at` is the heartbeat, and a stale one
 * is the only signal of a loop that died at import time. Written atomically so
 * a poller never reads a half-written file as an empty queue.
 */
export function publishQueue(account: string, trouble?: string): void {
  const dir = getAccount(account)?.site?.artifact;
  if (!dir || !existsSync(dir)) return;
  const q: Queue = {
    at: new Date().toISOString(),
    account,
    waiting: stillWaiting(account).map((r) => ({
      key: requestKey(r),
      kind: r.kind,
      ...(r.recipe ? { recipe: r.recipe } : {}),
      ...(r.name ? { name: r.name } : {}),
    })),
    ...(trouble ? { trouble } : {}),
  };
  const dest = join(dir, "pending.json");
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, JSON.stringify(q));
  renameSync(tmp, dest);
}
