/**
 * Taps that answer themselves.
 *
 * Every button on the site POSTs to a callback file and, until now, every one
 * of them waited for me. That is fine for "write this recipe out and text it
 * over", which genuinely needs somebody to write a recipe. It is absurd for
 * "we made it": the plan already knows what comes off the shelves, the answer
 * is arithmetic, and making a person wait on a round trip through a model to
 * hear that their dinner was logged is exactly the friction that ends with
 * nobody pressing the button again.
 *
 * The split this module draws is by whether an answer needs judgement:
 *
 *   DECIDED HERE — confirming or dropping an in-progress meal, starring,
 *   noting, undoing an automatic cleanup, ticking things off the shopping
 *   list. All deterministic folds over state that already exists.
 *
 *   ADDING TO THE LIST — needs a model, but a narrow one, and it runs right
 *   here rather than waiting for a session. Deciding what to buy for a dish is
 *   not a lookup: "chicken parm" needs breadcrumbs the ledger has never heard
 *   of, wants the 24 oz jar rather than "some sauce", and must not put mozzarella
 *   on the list when there is already mozzarella in the fridge. The model is
 *   handed the same three things I would read first — the recipe, everything on
 *   the shelves, and what is already on the list — so it answers with the same
 *   information rather than guessing from a name.
 *
 *   LEFT FOR ME — writing a recipe, building a variant, answering a question.
 *   Those are real writing, and pretending otherwise would put a worse version
 *   of my own work on the page under my name.
 *
 * Nothing here messages anybody. A confirmation text for a button somebody just
 * pressed is a notification about their own action.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eaters, getAccount, updateAccount } from "./accounts.ts";
import { getRecipe, loadCookbook } from "./cookbook.ts";
import { generateExplore, readExplore } from "./explore.ts";
import { addToList, readList, removeFromList, setAmount } from "./list.ts";
import { VIBES, refreshWeather } from "./mood.ts";
import { WAIT_MS, syncNote } from "./notesync.ts";
import { openrouterKey } from "./openrouter.ts";
import { confirmPlan, cookedRecently, planFor, useLines } from "./plans.ts";
import { addNote, skipPair, toggleFavorite, unskipPair } from "./profile.ts";
import { METHOD_LABEL, loadRecipes } from "./recipes.ts";
import { type Verdict, answer as answerSession, applySession, ensureSession } from "./reconcile.ts";
import { type MakeRequest, handled, markHandled, pending, requestKey } from "./requests.ts";
import { setDisposition, skip, unskip } from "./restock.ts";
import {
  type Dinner,
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
import { handleVoice } from "./voice.ts";

/** Kinds this module is willing to answer on its own. */
const AUTO = new Set([
  "plan",
  "favorite",
  "note",
  "unsweep",
  "shopped",
  "addlist",
  "voice",
  "pairskip",
  "photo",
  "reconcile",
  "cooked",
  "restock",
  "pref",
  "explore",
  "idealist",
  "sched",
  "keep",
  "notes",
  // "make" only when the dish is already written out; otherwise it falls
  // through to a person, which is what `handleOne` returning null means.
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
 * What to buy so this dish can be cooked, in a shopper's words.
 *
 * The prompt carries the whole kitchen rather than just the shortfall, because
 * the interesting mistakes are all things a shortfall list cannot see. A recipe
 * that calls for "cheese" when the fridge holds provolone needs nothing. A
 * recipe with no written ingredient list still needs eggs and breadcrumbs, and
 * the ledger will never say so, because the ledger only knows what the house
 * has owned before.
 */
async function askForList(
  account: string,
  recipe: { id: string; name: string; desc?: string },
  missingNames: string[],
): Promise<Array<{ name: string; amount?: string; cat?: string; item?: string }>> {
  const stock = live(account)
    .map((i) => `${i.name}${i.qty !== null ? ` (${i.qty}${i.unit ? ` ${i.unit}` : ""})` : ""}`)
    .sort();
  const already = readList(account).entries.map((e) => e.name);
  const built = getRecipe(account, recipe.id);
  const written = built?.ingredients?.length
    ? built.ingredients.map((i) => `${i.name}: ${i.amount}`).join("\n")
    : null;

  const prompt = [
    `Somebody wants to cook "${recipe.name}" and pressed "add what I need to the list".`,
    recipe.desc ? `The dish: ${recipe.desc}` : "",
    "",
    written
      ? `The written recipe calls for:\n${written}`
      : `There is no written recipe yet, so work out what this dish needs from its name.`,
    "",
    `ALREADY IN THE KITCHEN, do not put any of these on the list unless the recipe`,
    `needs meaningfully more than what is there:`,
    stock.join(", ") || "(nothing tracked)",
    "",
    already.length ? `ALREADY ON THE SHOPPING LIST, do not repeat: ${already.join(", ")}` : "",
    missingNames.length ? `The site thinks these are short: ${missingNames.join(", ")}` : "",
    "",
    `Return JSON: {"buy":[{"name":"what to look for on the shelf","amount":"how much,`,
    `as a shopper would say it","cat":"produce|meat|seafood|dairy|frozen|bakery|pantry|`,
    `condiment|spice|drink|snack|other"}]}`,
    "",
    "Rules. Only what is genuinely needed and not already owned. Real supermarket",
    "products, not recipe-speak: 'panko breadcrumbs, 8 oz' rather than 'breadcrumbs for",
    "coating'. Pantry staples like salt, pepper, oil and common dried spices are assumed",
    "present unless the kitchen list above proves otherwise. If nothing is needed, return",
    "an empty array. Never invent a substitute for something the kitchen already has.",
  ]
    .filter((l) => l !== "")
    .join("\n");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openrouterKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4.5",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const parsed = JSON.parse(data.choices[0]!.message.content) as {
    buy?: Array<{ name?: string; amount?: string; cat?: string; item?: string }>;
  };
  return (parsed.buy ?? []).filter(
    (b): b is { name: string; amount?: string; cat?: string } =>
      typeof b?.name === "string" && b.name.trim().length > 0,
  );
}

/**
 * Resolve one request.
 *
 * Returns a log line, an EMPTY STRING for "handled, not worth a log line", or
 * null for "not ours, leave it for a person". The empty-string case is not a
 * nicety: returning null for a silently-handled request meant every swipe of a
 * shelf check was left in the queue unmarked, re-processed on every pass
 * forever, and reported to me as work waiting for a human.
 */
async function handleOne(account: string, r: MakeRequest): Promise<string | null> {
  switch (r.kind) {
    case "plan": {
      if (!r.plan) return null;
      const p = openPlans(account)[r.plan];
      // Already resolved, most likely a double tap or a retry. Reporting it as
      // done is right: the world is in the state the person asked for.
      if (!p) return `plan ${r.plan}: already settled`;
      // "made" is the affirmative; anything else is the meal not happening.
      // Defaulting the unknown case to "did not happen" is the safe direction:
      // wrongly consuming food invents a meal in the history and empties shelves
      // that are still full, and only one of those two errors is visible.
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
      // The page sends the state it wants, not a toggle. If a stale tab and the
      // stored state disagree, one more flip lands on what was actually asked
      // for rather than inverting it.
      if (typeof r.on === "boolean" && on !== r.on) {
        on = toggleFavorite(account, r.recipe, r.profile);
      }
      // Report what the file now says, not what was requested. Reading back the
      // request meant a star that failed to take still logged as "starred".
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

    /**
     * Answering the tray, or taking a line off the list.
     *
     * Every branch here is a preference rather than a fact about food, which is
     * why none of them touch the event log — see `restock.ts`. The one option
     * on that sheet that IS a fact about food ("I already have this") is posted
     * as a `restock` and never reaches this handler.
     */
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
          // A one-time yes. No disposition is written, because saying "buy
          // this once" is not saying anything about next month.
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
      // Somebody tapped for this, so it queues behind a sync in flight
      // instead of colliding with one.
      const res = await syncNote(account, { wait: WAIT_MS });
      if (!res.ok) return `apple notes: ${res.error}`;
      return `apple notes: ${res.wrote ? "wrote" : "confirmed"} ${res.lines} line${res.lines === 1 ? "" : "s"} in "${res.title}" via ${res.via}${res.adopted.length ? `, took ${res.adopted.join(", ")} off the note` : ""}${res.invited.length ? `, invited ${res.invited.join(", ")}` : ""}`;
    }

    case "shopped": {
      // A tick is somebody saying "this is in the trolley". That is real
      // evidence of PRESENCE and no evidence at all of quantity or price, which
      // is exactly what an add carrying a null qty means: back in the house,
      // nobody counted it. A receipt refines it later with the real numbers.
      //
      // This used to clear the written lines and stop, on the grounds that only
      // a receipt could say what came home. True, and it left every derived
      // line sitting there after the trip — the staples are folded from stock,
      // so if nothing asserts they are back, the list still shows them as out.
      // Somebody ticked seven boxes, pressed finished, and watched nothing
      // happen. Refusing to guess a quantity is right; refusing to believe the
      // person in front of you is not.
      const ticked = (r.items ?? []).filter(Boolean);
      const n = removeFromList(account, ticked);
      const stock = Object.fromEntries(Object.entries(fold(account)));
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
      // "We are not doing the second night." Recorded rather than acted on:
      // nothing is consumed, nothing is bought, the suggestion simply stops.
      if (!r.recipe || !r.note) return null;
      if (r.note === "undo") {
        unskipPair(account, r.recipe);
        return `pair ${r.recipe}: back on`;
      }
      const leg = r.note === "parent" ? ("parent" as const) : ("child" as const);
      skipPair(account, r.recipe, leg, r.profile ?? null);
      return `pair ${r.recipe}: skipping the ${leg === "parent" ? "first" : "second"} half`;
    }

    // "Make this" for a dish that has already been written out.
    //
    // The original brief was "write the recipe page, or if it exists send it",
    // and only the first half was built: every tap posted a request that woke a
    // session, which then discovered the page already existed. That is the most
    // expensive possible way to open a link, and it is what somebody pressing a
    // button twice in a week would always hit. Serving the existing page is a
    // lookup, so it happens here. A dish with no page still falls through to a
    // person, because writing one is real writing.
    case "make": {
      if (!r.recipe) return null;
      const acct = getAccount(account);
      const built = getRecipe(account, r.recipe);
      const url = acct ? recipeUrl(acct, r.recipe) : null;
      if (!acct || !built || !url) return null;
      const dir = acct.site?.artifact;
      if (!dir || !existsSync(join(dir, "recipe", `${r.recipe}.html`))) return null;

      // Marked served BEFORE the sends, unlike everything else here. The two
      // failure modes are not symmetric: losing this costs somebody a link they
      // can still reach from the card they just tapped, while replaying it
      // texts a real person the same thing twice.
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
      // Finishing a recipe on its own page is the same fact as confirming a
      // plan on the meals page, so it consumes the same way and leaves the same
      // leftovers. Without this the last card could only say "go and tell the
      // other page", which is the sort of errand nobody runs.
      if (!r.recipe) return null;
      // This is the one auto-handled kind with no natural guard. Confirming a
      // plan consumes the plan, so a replay finds nothing to do; ticking a
      // shopping line off a list it has already left is a no-op; asserting a
      // count twice asserts the same count. Consuming a recipe's ingredients is
      // none of those — run it twice and the dinner comes off the shelves
      // twice. The stamp below is what makes the replay visible.
      const key = requestKey(r);
      if (readLog(account).some((e) => e.req === key)) {
        return `cooked ${r.recipe}: already taken off the shelves`;
      }
      // An open plan for this dish outranks every reconstruction below, because
      // it is the only list somebody actually agreed to: it was resolved against
      // the shelves at the moment it was made and scoped to tonight (four thighs,
      // not the package). Confirming it here is also what keeps the two screens
      // from double-charging the same dinner — deducting separately left the plan
      // open and armed to consume everything a second time.
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
      // The WRITTEN recipe wins over the catalog card. They share an id and can
      // disagree completely: the card is the general idea of the dish, while the
      // cookbook entry is the one that got written for this house, on this night,
      // around what was actually in the fridge. Preferring the card is how a tap
      // on a page built around raw chicken thighs took a package of deli buffalo
      // chicken off the shelf instead, and emptied a bottle of ranch the recipe
      // spends a tablespoon of.
      const needs = book?.needs ?? cat?.needs ?? [];
      if (!needs.length) return `cooked ${r.recipe}: no ingredient list, nothing to take off`;
      const meal = book?.name ?? cat?.name ?? r.name ?? r.recipe;
      // Two genuine taps, two request keys, one dinner. The stamp above only
      // recognises a REPLAY of a single tap; it cannot see a person pressing the
      // button again because the page gave them no receipt the first time, which
      // is the likelier story of the two. Once the first tap has closed the plan
      // there is nothing open left to protect the second one, so it would deduct
      // an entire second dinner from a reconstructed list.
      const already = cookedRecently(account, meal);
      if (already) {
        return `cooked "${meal}": already came off the shelves at ${already.at}, so this tap changed nothing`;
      }
      const stock = Object.fromEntries(live(account).map((i) => [i.id, i]));
      const used = needs.filter(([slug]) => stock[slug]);
      const yields = cat?.yields ?? [];
      if (!used.length && !yields.length) {
        // The ledger already believes none of this is in the house. Saying so is
        // the honest answer; writing an empty batch to record it is not.
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
      // "The ledger is wrong, I do have that." The most common reason a dish
      // looks un-makeable is a stale shelf, not an empty one, and being told so
      // is better evidence than anything this system can infer on its own.
      if (!r.items?.length) return null;
      const stock = Object.fromEntries(live(account).map((i) => [i.id, i]));
      const want = typeof r.qty === "number" ? r.qty : 1;
      // Two shapes of wrong, one correction. Either the shelf is empty and the
      // thing is actually there, or there is some and the count is too low. The
      // second was the case that silently did nothing: the item was present, so
      // an "is it missing" check said no and the count stayed exactly as wrong
      // as it was. Both are handled by asserting the count.
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
      // One card, one verdict. Recorded as it arrives rather than at the end,
      // so a phone that dies at item nine keeps the first eight; nothing
      // reaches the ledger until the pass is explicitly saved.
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
      // Handled, but deliberately unlogged: thirty of these arrive in ninety
      // seconds and one line each would bury everything else that happened.
      return "";
    }

    case "photo": {
      // The share server wrote the bytes to a quarantine directory and told us
      // where. Deciding what the picture MEANS is this side's job, which is why
      // the public endpoint does not do it.
      //
      // A photo of the actual plate always beats the generated one. The
      // generated shot is moved aside rather than overwritten, because
      // "generated" is recoverable and "the night we cooked it" is not.
      if (!r.file || !r.recipe) return null;
      const dir = getAccount(account)?.site?.artifact;
      if (!dir) return null;
      // Both of these name a file, and both arrive from a public endpoint.
      //
      // `/upload` is careful — it rebuilds the name from scratch and writes only
      // into `img/upload/` — but `/callback` accepts any JSON object from anyone
      // holding the page link, so a photo request can be posted directly with a
      // `file` the server never wrote. This is a rename, which is a read of that
      // path AND a delete of it, so an unchecked "../.." here moved arbitrary
      // files off this machine and into the directory the tunnel serves. Confine
      // the source to the one directory uploads land in, and require the recipe
      // id to be an id rather than a path fragment.
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

    case "voice": {
      if (!r.rid || !r.text?.trim() || !r.profile) return null;
      const dir = getAccount(account)?.site?.artifact;
      if (!dir) return null;
      const turn = await handleVoice(account, dir, r.profile, {
        rid: r.rid,
        text: r.text.trim(),
        recipe: r.recipe ?? null,
        step: r.step ?? null,
      });
      return (
        `asked out loud "${r.text.trim().slice(0, 48)}" -> ` +
        `${turn.audio ? "spoken" : "text only, synthesis failed"}`
      );
    }

    case "addlist": {
      // `missing` is what the person actually confirmed on the page, not what
      // the site guessed. The button opens a picker first, because a tap on
      // "add to list" is interest in a dish rather than a decision to cook it,
      // and a list that fills itself with things nobody chose is a list people
      // stop reading.
      if (!r.recipe) return null;
      if (!r.items?.length && !r.missing?.length)
        return `add to list for ${r.name ?? r.recipe}: nothing picked`;
      const { recipes } = loadRecipes(account);
      const cat = recipes.find((x) => x.id === r.recipe);
      const book = loadCookbook(account).find((x) => x.id === r.recipe);
      const dish = cat ?? book ?? { id: r.recipe, name: r.name ?? r.recipe, desc: "" };
      const buy = await askForList(account, dish, r.missing ?? []);
      if (!buy.length) return `add to list for ${dish.name}: nothing needed`;
      const { added, merged } = addToList(
        account,
        buy.map((b) => ({
          name: b.name,
          amount: b.amount ?? null,
          cat: b.cat ?? null,
          item: b.item ?? null,
          why: `for ${dish.name}`,
          by: r.profile ?? null,
        })),
      );
      return `add to list for ${dish.name}: +${added.length}${merged.length ? `, ${merged.length} already on it` : ""}${added.length ? ` (${added.map((a) => a.name).join(", ")})` : ""}`;
    }

    // How this house wants to be cooked for. Deterministic: it writes to the
    // account and changes nothing about what food exists, which is why it can
    // settle in ten seconds rather than waiting for a session.
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
        // Zero means "no opinion", which is a real answer and has to be stored
        // as absent rather than as a budget of nothing. A zero-dollar weekly
        // target would read as a household that may not buy food.
        //
        // Through `positive` rather than a bare truthiness test, because these
        // come off a public endpoint: `"50" > 0` is true, so a string survived
        // the old check and was persisted as the budget, and everything
        // downstream then did arithmetic on it.
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

    // A new set of dishes deliberately unlike this household's own. Narrow
    // model call, same shape as the shopping one: it runs here rather than
    // waiting for a session because the answer is a list, not writing.
    case "explore": {
      const acct = getAccount(account);
      if (!acct) return null;
      const set = await generateExplore(account, acct, { theme: r.text?.trim() || null });
      return `explore: ${set.dishes.length} ideas${set.theme ? ` for "${set.theme}"` : ""} (${set.dishes
        .slice(0, 3)
        .map((d) => d.name)
        .join(", ")})`;
    }

    // Shopping for a dish the house cannot make and has never made. The names
    // are already the model's own plain shopping words from when the idea was
    // generated, so there is nothing to resolve and nothing to look up: this
    // one is genuinely just a write.
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
          // No `item` slug on purpose. The house has never owned these, so
          // claiming a ledger identity for them would invent an inventory row
          // for food nobody has bought yet.
          item: null,
          why: `to try ${dish.name}`,
          by: r.profile ?? null,
        })),
      );
      return `add to list for ${dish.name} (idea): +${added.length}${merged.length ? `, ${merged.length} already on it` : ""}`;
    }

    // A standing dinner text, set from the page. Deterministic: it writes a row
    // on the household and changes nothing about food. The schedule is
    // validated against this household's own members here rather than trusted,
    // because the body arrived from a public endpoint.
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
      // An edit carries forward only what the OLD row knew about firing. Every
      // field the person can see on screen comes from the body, or a rename of
      // the recipients would be silently thrown away by the previous values.
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
          created: was?.created,
          fired: was?.fired ?? null,
          last: was?.last ?? null,
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
 * Answer everything on this account's page that can be answered without me.
 *
 * Each request is acted on, then marked served, one at a time — never a mark
 * for the whole batch at the end, so a crash halfway through cannot un-serve
 * the ones already done.
 *
 * The window between acting and marking is real and cannot be closed by
 * ordering: mark first and a crash loses the action, mark second and a crash
 * replays it. So every kind handled here is idempotent instead. Most are so
 * naturally — a confirmed plan is gone, a ticked line has already left the
 * list, an asserted count asserts the same count. The one that is not is
 * `cooked`, which carries an explicit request stamp in the events it writes.
 * That is the property to preserve when adding a kind to AUTO: replaying it
 * must be harmless, or it must be able to see that it already ran.
 */
export async function drain(account: string): Promise<DrainResult> {
  const out: DrainResult = { done: [], left: [], failed: [] };
  const acct = getAccount(account);
  const dir = acct?.site?.artifact;
  if (!dir) return out;

  // The drain runs every few seconds, so it is also the thing that keeps the home
  // page's weather current. Deliberately best-effort and deliberately silent:
  // a network failure here must never hold up somebody's "we made it", and a
  // stale reading is simply not shown rather than shown wrong.
  try {
    await refreshWeather(account, acct);
  } catch {
    // Nothing to say. The cache ages out on its own and the page falls silent.
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
      // A failed request stays in the queue. It will be retried next pass, and
      // if it keeps failing it surfaces to me as something still waiting, which
      // is the correct escalation.
      out.failed.push(`${r.kind} ${r.recipe ?? r.plan ?? ""}: ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * Requests still waiting on a person, across every account. Cheap, no I/O
 * beyond the log.
 *
 * AUTO membership is not the same question as "does this need a person" any
 * more. `make` is in AUTO, but only resolves itself when the dish is already
 * written out; one that has never been written still needs somebody to write
 * it, and reading AUTO alone made every such request disappear from this list
 * while continuing to sit unanswered in the queue.
 */
export function stillWaiting(account: string): MakeRequest[] {
  const acct = getAccount(account);
  const dir = acct?.site?.artifact;
  if (!dir) return [];
  const done = handled(account);
  const needsMe = (r: MakeRequest) => {
    if (!AUTO.has(r.kind)) return true;
    if (r.kind !== "make") return false;
    return !(
      r.recipe &&
      getRecipe(account, r.recipe) &&
      existsSync(join(dir, "recipe", `${r.recipe}.html`))
    );
  };
  return pending(account, dir).filter((r) => needsMe(r) && !done.has(requestKey(r)));
}

/** What the trigger reads. Only the fields it needs to decide and to dedupe. */
export type Queue = {
  /** When the pass that wrote this finished. The heartbeat. */
  at: string;
  account: string;
  waiting: Array<{ key: string; kind: string; recipe?: string; name?: string }>;
  /** Anything that failed this pass, so a broken render is not silent. */
  trouble?: string;
};

/**
 * Publish what is still waiting on a person, at the end of a pass.
 *
 * This exists because the alarm and the drain were reading different things.
 * The alarm watched the raw callback log, which contains every tap; the drain
 * settles most of them within ten seconds. So the alarm fired on work that no
 * longer needed doing, and had I acted on one of those wake-ups the person would
 * have been sent the same recipe twice. Written here, after the pass, the file
 * cannot describe a request the drain has already taken.
 *
 * The timestamp is the other half. A syntax error in the render layer took this
 * whole loop down for 54 minutes on 2026-08-17 and nothing said so, because a
 * process that dies at import time has no chance to report anything. Nothing
 * inside the pass can cover that; only the absence of a fresh stamp can. So the
 * file is rewritten every pass whether or not anything changed, and a stale `at`
 * is the outage alarm.
 *
 * Written atomically: a reader polling every two minutes must never catch a
 * half-written file and read it as an empty queue.
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
