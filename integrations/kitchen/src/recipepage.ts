/**
 * One dish, one step at a time.
 *
 * The first version of this page was a single long scroll, which is how recipes
 * are written down and not how they are cooked from. Cooking, you are on step
 * six, your hands are busy, and the thing you need is the amount for step six
 * and nothing else. A scroll makes you find your place again after every glance,
 * and finding your place is the moment people lose the thread and improvise.
 *
 * So the page is a stack of cards and you are always on exactly one. Next
 * advances, back reverses, the position lives in the URL so a locked phone comes
 * back where it was, and the step you are on carries everything that step needs:
 * its own ingredients with the amount for THIS step, the instruction in full, a
 * photograph of any technique it names, and its own timer. Timers keep running
 * across steps, which is the entire reason they are on the page rather than in
 * the clock app.
 *
 * THINGS DELIBERATELY NOT HERE:
 *
 *   No two-cook mode. It made every step ask "is this mine" before it asked
 *   "what do I do", which is a question about the interface rather than the
 *   food. One recipe, one order, follow it.
 *
 *   No typing as the primary input. The button is a microphone, because the
 *   questions that come up mid-recipe arrive when your hands are wet: ask out
 *   loud, hear the answer, never leave the step. Typing is still there for a
 *   browser that will not listen. See voice.ts.
 *
 *   No scrolling up for the ingredient list. It is still there, collapsed on the
 *   intro card, for shopping and mise en place. It is not the cooking view.
 *
 * House rules as everywhere else: no emoji, no em-dashes, and anything inferred
 * rather than measured says so on the line where it appears.
 */

import type { BuiltRecipe } from "./cookbook.ts";
import { type PricePoint, recipeCost } from "./cost.ts";
import { dayKey } from "./insights.ts";
import { CLIENT } from "./recipe/client.ts";
import { CSS } from "./recipe/style.ts";
import { slug } from "./store.ts";
import { BY_ID, techniquesFor } from "./techniques.ts";
import type { Item } from "./types.ts";
import { escapeHtml } from "./util.ts";

export type RecipePageCtx = {
  items: Record<string, Item>;
  prices: Map<string, PricePoint>;
  /** ISO date this was last actually cooked, if ever. */
  lastMade?: string | null;
  /** Relative path to the hero photo from the recipe page, or null. */
  photo?: string | null;
  /** Household name, for the header. */
  title: string;
  /** Step numbers that already have a photograph somebody took. */
  stepPhotos?: Set<number>;
  /** True when the hero is a real plate rather than a generated shot. */
  ownPhoto?: boolean;
  /**
   * Other written takes on the same dish, each with its own page.
   *
   * A variant is not a footnote: it is usually the version you can actually
   * cook, built around what was in the house the day the original came up
   * short. Burying it inside the original is how it never gets found again.
   */
  variants?: Array<{ id: string; name: string; reason?: string | null }>;
};

/** A yyyy-mm-dd calendar date, rendered for reading. */
const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
};

/**
 * The same, from a full timestamp.
 *
 * Every stored instant is UTC, so slicing its first ten characters is a
 * different day for the whole Eastern evening. A recipe written at nine on
 * Sunday night said it was written Monday.
 */
const fmtInstant = (iso: string) => fmtDate(dayKey(new Date(iso)));

const MODIFIER = new Set([
  "sliced",
  "diced",
  "chopped",
  "minced",
  "grated",
  "shredded",
  "ground",
  "fresh",
  "dried",
  "frozen",
  "whole",
  "large",
  "small",
  "medium",
  "extra",
  "virgin",
  "boneless",
  "skinless",
  "yellow",
  "white",
  "black",
  "green",
  "unsalted",
  "salted",
  "heavy",
  "light",
  "wide",
  "thin",
]);

/**
 * Whether the kitchen has what a written ingredient line asks for.
 *
 * Only lines carrying a ledger slug can be answered. A line without one is not
 * reported as missing: "salt" is not tracked and never will be, and flagging it
 * red would train people to ignore the colour on the lines that matter.
 */
function stockState(ing: { item?: string | null }, items: Record<string, Item>) {
  if (!ing.item) return null;
  const it = items[ing.item];
  if (!it || it.gone) return { label: "out", col: "var(--bad)" };
  if (it.level === "low") return { label: "running low", col: "var(--warn)" };
  return { label: "have", col: "var(--good)" };
}

/**
 * The slug a written line MEANT, given what the ledger actually knows.
 *
 * Both an ingredient line's `item` and the first half of a `needs` pair are
 * authored rather than derived, so either can arrive as a display name
 * ("Boneless skinless chicken thighs") instead of a slug
 * ("boneless-skinless-chicken-thighs"). That failed in the worst possible
 * direction: an unresolvable key is indistinguishable from an item the house
 * has run out of, so on 2026-08-17 a recipe written with display names rendered
 * every single line "out" and told two people to go shopping for a fridge full
 * of food they already had.
 *
 * Re-slugging recovers the link, because a slug is exactly what the display
 * name gets minted into. The order matters: trust an exact hit first, since a
 * real slug must never be second-guessed, and only then try re-slugging.
 */
function resolveSlug(
  raw: string | null | undefined,
  name: string | null,
  items: Record<string, Item>,
  known: ReadonlySet<string>,
): string | null {
  const ok = (c: string | null | undefined): c is string => !!c && (known.has(c) || !!items[c]);
  if (ok(raw)) return raw;
  if (raw && ok(slug(raw))) return slug(raw);
  if (name && ok(slug(name))) return slug(name);
  return null;
}

export function renderRecipePage(r: BuiltRecipe, ctx: RecipePageCtx): string {
  // Repair `needs` BEFORE anything reads it. It feeds the cost, the shortfall
  // and the vocabulary every ingredient line is checked against, so a display
  // name left in here is wrong three times over. A slug that resolves nowhere
  // is kept as written rather than dropped, because an item the house has
  // genuinely never had is a real shortfall and must still be reported.
  const needs = r.needs.map(
    ([id, q]) => [resolveSlug(id, null, ctx.items, new Set()) ?? id, q] as [string, number],
  );

  const cost = recipeCost(
    { id: r.id, name: r.name, desc: r.desc, minutes: r.minutes, needs, cat: r.cat },
    ctx.items,
    ctx.prices,
  );

  // Back-fill the slug on any line that is missing one OR carrying one the
  // ledger does not recognise.
  //
  // The written ingredient list is prose and its `item` is best-effort, so a
  // line can name something the ledger tracks and still carry a null slug. That
  // is not cosmetic: an unslugged line cannot be checked against the shelves, so
  // a dish the house is out of rendered with every line marked "have" and a
  // summary saying everything was here. Slugging the display name recovers the
  // link for free, because that is exactly how the slug was minted.
  //
  // A line still unresolvable after that is set back to null rather than left
  // pointing at a dead key. Null means untracked and draws no badge, which is
  // the rule stockState already documents; leaving the dead key in place is
  // what made "salt" and every other staple render as "out".
  const known = new Set(needs.map(([s]) => s));
  const lines = r.ingredients.map((i) => {
    const hit = resolveSlug(i.item, i.name, ctx.items, known);
    return hit === (i.item ?? null) ? i : { ...i, item: hit };
  });
  const byName = new Map(lines.map((l) => [l.name, l]));

  // The shortfall comes from `needs`, which is the authoritative list of ledger
  // slugs this dish consumes, NOT from whichever prose lines happen to resolve.
  // Deriving it from the prose meant the page's honesty depended on how well a
  // recipe had been transcribed, which is the wrong thing to depend on.
  const missing = needs
    .map(([id]) => id)
    .filter((id) => {
      const it = ctx.items[id];
      return !it || it.gone;
    })
    .map((id) => ({
      item: id,
      name: lines.find((l) => l.item === id)?.name ?? ctx.items[id]?.name ?? id.replace(/-/g, " "),
    }));

  const meta = [
    `<span class="chip"><b>${r.minutes}</b> min</span>`,
    `<span class="chip">serves <b>${r.serves || 2}</b></span>`,
    `<span class="chip"><b>${r.steps.length}</b> steps</span>`,
    cost.priced
      ? `<span class="chip">about <b>$${cost.total.toFixed(2)}${cost.complete ? "" : "+"}</b> from your receipts</span>`
      : "",
    ctx.lastMade
      ? `<span class="chip made">last made ${escapeHtml(fmtDate(ctx.lastMade))}</span>`
      : `<span class="chip">not made yet</span>`,
    r.variantReason ? `<span class="chip">variant: ${escapeHtml(r.variantReason)}</span>` : "",
  ]
    .filter(Boolean)
    .join("");

  const ingredients = lines
    .map((i) => {
      const s = stockState(i, ctx.items);
      return `<div class="ing">
      <span class="amt">${escapeHtml(i.amount || "")}</span>
      <span class="nm">${escapeHtml(i.name)}${i.note ? `<br><span class="note">${escapeHtml(i.note)}</span>` : ""}</span>
      ${s ? `<span class="st" style="color:hsl(${s.col})">${s.label}</span>` : ""}
    </div>`;
    })
    .join("");

  /**
   * What this step puts in the pan.
   *
   * The amount shown is the step's own portion where it has one, falling back to
   * the shopping amount. Those are genuinely different numbers: the intro card
   * answers "what do I buy", a step answers "what goes in now", and a recipe
   * with only the first makes you do the division in your head at the stove.
   */
  /**
   * The ingredients a step mentions but never listed.
   *
   * The writer is asked to attach `uses` to every step that puts something in
   * the pan and it misses some, which leaves a step that says "add the
   * mushrooms" with no amount and no stock beside it. That is the exact failure
   * this feature exists to prevent, so the step's own words are matched against
   * the ingredient list as a floor. Amount is left blank so the row falls back
   * to the shopping amount rather than inventing a portion.
   *
   * Whole words only. Matching on a substring made "oil" fire on "boil" and
   * "salt" on "unsalted", which puts confident wrong rows on a page people are
   * cooking from.
   */
  const inferUses = (st: BuiltRecipe["steps"][number]) => {
    const text = `${st.title}. ${st.body}`.toLowerCase();
    const hit = (word: string) =>
      new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`).test(text);
    return lines
      .filter((l) => {
        const n = l.name.toLowerCase();
        if (hit(n)) return true;
        // Recipes name an ingredient in full at the top and by its head noun in
        // the steps: "Sliced mushrooms" becomes "the mushrooms". Matching only
        // the full phrase missed exactly the steps most in need of a quantity.
        // Modifiers are dropped rather than matched on, because "sliced" and
        // "fresh" appear in half the steps in any recipe.
        const words = n.split(/\s+/).filter((w) => w.length >= 5 && !MODIFIER.has(w));
        return words.length > 0 && hit(words[words.length - 1]!);
      })
      .map((l) => ({ ingredient: l.name, amount: null }));
  };

  const usesBlock = (st: BuiltRecipe["steps"][number]) => {
    const uses = st.uses?.length ? st.uses : inferUses(st);
    if (!uses.length) return "";
    return `<div class="uses">${uses
      .map((u) => {
        const ing = byName.get(u.ingredient);
        const stock = ing ? stockState(ing, ctx.items) : null;
        // The step's own portion when it has one. Falling back to the whole-dish
        // amount is better than a blank, but that text describes the recipe and
        // not this step, so it is usually a sentence rather than a quantity and
        // has to be laid out as one.
        const amount = u.amount || ing?.amount || "";
        const long = amount.length > 22;
        return `<div class="u${long ? " long" : ""}">
        <span class="q">${escapeHtml(amount)}</span>
        <span class="n">${escapeHtml(u.ingredient)}</span>
        ${stock ? `<span class="s" style="color:hsl(${stock.col})">${stock.label}</span>` : ""}
      </div>`;
      })
      .join("")}</div>`;
  };

  /**
   * The reference panel: a real photograph, a real chef, a written source.
   *
   * On the step rather than collected at the bottom, because the moment you need
   * to know how small a small dice is, is the moment you are holding the knife.
   */
  const techBlock = (st: BuiltRecipe["steps"][number]) => {
    const named = (st.techniques ?? [])
      .map((id) => BY_ID.get(id))
      .filter((t): t is NonNullable<typeof t> => !!t);
    // Fall back to reading the step's own words, so recipes written before any
    // of this existed still get their references.
    const list = (named.length ? named : techniquesFor(st)).slice(0, 2);
    return list
      .map(
        (t) => `<div class="tech">
      ${t.image ? `<img data-img="../img/technique/${t.id}.${t.image.ext}" alt="${escapeHtml(t.label)}" loading="lazy">` : ""}
      <div class="tb">
        <div class="tt">${escapeHtml(t.label)}</div>
        <div class="tw">${escapeHtml(t.what)}</div>
        ${t.spec ? `<div class="ts">${escapeHtml(t.spec)}</div>` : ""}
        <div class="tl">
          ${
            t.video
              ? `<a href="https://www.youtube.com/watch?v=${t.video.id}" target="_blank" rel="noopener">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            ${escapeHtml(t.video.by)}</a>`
              : ""
          }
          ${t.help ? `<a href="${escapeHtml(t.help.url)}" target="_blank" rel="noopener">${escapeHtml(t.help.label)}</a>` : ""}
        </div>
        ${
          t.image
            ? `<div class="cr">Photograph: ${escapeHtml(t.image.credit)}, ${escapeHtml(t.image.license)},
          via <a href="${escapeHtml(t.image.source)}" target="_blank" rel="noopener">Wikimedia Commons</a>.</div>`
            : ""
        }
      </div>
    </div>`,
      )
      .join("");
  };

  /**
   * The instruction, as a list of single actions.
   *
   * Recipes written before `parts` existed carry one paragraph, so it is split
   * on sentence boundaries as a fallback. That is a real improvement rather than
   * a hack: a recipe sentence is almost always exactly one action, which is why
   * the paragraph was hard to scan in the first place. Abbreviations that end in
   * a period are protected, or "1/2 in. cubes" becomes two steps.
   */
  const partsOf = (st: BuiltRecipe["steps"][number]): string[] => {
    if (st.parts?.length) return st.parts;
    const guarded = st.body.replace(
      /\b(approx|approx|in|oz|lb|tbsp|tsp|qt|pt|deg|min|sec|Dr|Mr|Mrs|St|no)\./gi,
      "$1\u0000",
    );
    return guarded
      .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
      .map((x) => x.replace(/\u0000/g, ".").trim())
      .filter(Boolean);
  };

  const camera = (label: string, step: number | null) =>
    `<label class="shoot" data-shoot data-step="${step ?? ""}">
      <input type="file" accept="image/*" capture="environment">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
        stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 8.5A1.5 1.5 0 014.5 7h2.2l1.1-2h8.4l1.1 2h2.2A1.5 1.5 0 0121 8.5v9A1.5 1.5 0 0119.5 19h-15A1.5 1.5 0 013 17.5z"/>
        <circle cx="12" cy="13" r="3.6"/></svg>
      <span>${escapeHtml(label)}</span>
    </label>`;

  const stepViews = r.steps
    .map(
      (s) => `<section class="view" data-view="${s.n}">
    <div class="eyebrow">Step ${s.n}<span class="of">of ${r.steps.length}</span>
      ${s.minutes ? `<span class="of">${s.minutes} min</span>` : ""}</div>
    <h3>${escapeHtml(s.title)}</h3>
    ${s.parts?.length && s.body ? `<p class="lede-why">${escapeHtml(s.body)}</p>` : ""}
    ${usesBlock(s)}
    <ol class="parts">${partsOf(s)
      .map((x) => `<li>${escapeHtml(x)}</li>`)
      .join("")}</ol>
    ${s.watch ? `<div class="watch"><b>Done when</b><span>${escapeHtml(s.watch)}</span></div>` : ""}
    ${techBlock(s)}
    ${
      s.minutes
        ? `<button class="timer" data-timer="${s.minutes}" data-label="${escapeHtml(s.title)}">
      <span class="t">${String(s.minutes).padStart(2, "0")}:00</span><span>start timer</span></button>`
        : ""
    }
    ${
      ctx.stepPhotos?.has(s.n)
        ? `<div class="mine"><img data-img="../img/steps/${r.id}-${s.n}.jpg" alt="" loading="lazy">
          <div class="cap">Yours, from last time</div></div>`
        : ""
    }
    ${camera("Photograph this step", s.n)}
  </section>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(r.name)}</title>
<style>${CSS}</style>
</head><body>
<div id="instant-share-admin" hidden></div>

<header>
  <div class="wrap row">
    <a class="back" id="back" href="../index.html">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round"><path d="M15 6l-6 6 6 6"/></svg>All meals</a>
    <span class="where" id="where"></span>
    <button class="jump" id="jumpbtn">View
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
  </div>
  <div class="prog"><i id="bar"></i></div>
</header>

<main class="wrap">
  <section class="view on" data-view="0">
    ${ctx.photo ? `<div class="hero"><img data-img="${escapeHtml(ctx.photo)}" alt="${escapeHtml(r.name)}"></div>` : ""}
    <h1>${escapeHtml(r.name)}</h1>
    <p class="lede">${escapeHtml(r.desc || "")}</p>
    <div class="meta">${meta}</div>
    ${
      missing.length
        ? `<p class="note" style="margin-top:14px">Short ${missing.length}: ${missing
            .map((m) => escapeHtml(m.name))
            .join(", ")}. The buttons below can put those
          on the shopping list, or build a version around what is here.</p>`
        : `<p class="note" style="margin-top:14px">Everything this needs is in the kitchen right now.</p>`
    }
    <!-- Collapsed on purpose. Every step carries its own ingredients with the
         amount for that step, which is what you want while cooking; this list is
         the shopping and mise-en-place view, wanted once, before you start. -->
    <details class="full">
      <summary>Everything at a glance, ${r.ingredients.length} ingredients</summary>
      ${ingredients}
    </details>
    ${
      ctx.variants?.length
        ? `<h2>Other versions</h2>
    <div class="card">${ctx.variants
      .map(
        (v) => `<a class="vrow" style="text-decoration:none;color:inherit"
        href="${escapeHtml(v.id)}.html" data-page>
        <span class="nm" style="font-weight:600">${escapeHtml(v.name)}</span>
        <span class="note">${escapeHtml(v.reason ?? "another take")}</span>
      </a>`,
      )
      .join("")}</div>`
        : ""
    }
    <div class="acts">
      <button class="btn alt" id="addlist">Add what I need to the list</button>
      <button class="btn alt" id="variant">Make a variant</button>
    </div>
    <footer>
      ${escapeHtml(ctx.title)} · written ${escapeHtml(fmtInstant(r.built))}.
      Stock beside each ingredient comes from the kitchen ledger, so it is as current as the
      last receipt or meal logged. The cost is what this household actually paid for those
      ingredients, not a market price.
    </footer>
  </section>

  ${stepViews}

  <section class="view" data-view="${r.steps.length + 1}">
    <div class="eyebrow">Done</div>
    <h3>That is ${escapeHtml(r.name)}</h3>
    <p class="body">Take a picture of the plate and it becomes the photograph for this dish
    everywhere on the site, replacing the generated one. ${
      ctx.ownPhoto
        ? "The current picture is already one of yours."
        : "Right now it is using a generated shot."
    }</p>
    ${camera("Photograph the plate", null)}
    <p class="body" style="font-size:16px;color:hsl(var(--ink-soft))">Nothing leaves the kitchen
    ledger until somebody says it happened, so tell me here and the shelves stay true.</p>
    <div class="acts">
      <button class="btn alt" id="restart">Start over</button>
      <button class="btn" id="cooked">We made it</button>
    </div>
    <div class="acts" style="margin-top:0">
      <button class="btn alt" id="done">Just close this</button>
    </div>
  </section>
</main>

<div class="runs" id="runs"><div class="in" id="runsin"></div></div>

<nav class="step"><div class="in">
  <button class="prev" id="prev">Back</button>
  <button class="next" id="next">Start cooking</button>
  <button class="mic" id="mic" aria-label="Ask out loud">
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 15a3.5 3.5 0 003.5-3.5v-6a3.5 3.5 0 10-7 0v6A3.5 3.5 0 0012 15z"/>
      <path d="M19 11.5a1 1 0 10-2 0 5 5 0 01-10 0 1 1 0 10-2 0 7 7 0 006 6.93V21H8.5a1 1 0 100 2h7a1 1 0 100-2H13v-2.57a7 7 0 006-6.93z"/></svg>
  </button>
</div></nav>

<!-- A panel that drops from the header rather than a modal sheet. The sheet
     fought the page: it darkened everything, it swallowed taps meant for the
     card behind it, and on a phone its only dismiss target was a sliver of
     backdrop. This closes on any tap outside it and on picking a step. -->
<div class="panel" id="jump" hidden>
  <div class="wrap">
    <div class="phead">How to read this</div>
    <div class="vopt">
      <button data-mode="step">One step at a time</button>
      <button data-mode="flow">The whole thing as a list</button>
    </div>
    <div class="phead">Jump to a step</div><div id="jumplist"></div>
  </div>
</div>

<div class="sheet" id="confirm"><div class="bg" data-close></div><div class="pane">
  <div class="grab"></div>
  <h4 id="chead"></h4>
  <p class="note" id="cwhat" style="font-size:15px;line-height:1.55"></p>
  <div class="acts">
    <button class="btn alt" data-close style="flex:1">Not now</button>
    <button class="btn" id="cyes" style="flex:2"></button>
  </div>
</div></div>

<!-- Docked, not modal. Asking a question mid-recipe must not cover the step
     you are standing there reading, and it must be closable with one obvious
     tap rather than by finding a sliver of backdrop or reloading the page. -->
<div class="vdock" id="vdock" hidden>
  <div class="wrap">
    <div class="vtop">
      <span class="vlabel" id="vstate">Listening</span>
      <button class="vx" id="vclose" aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="vq" id="vq"></div>
    <div class="va" id="va"></div>
    <div class="vtype"><input id="vtext" placeholder="Or type it" enterkeyhint="send">
      <button class="btn" id="vsend" style="flex:0 0 auto;min-width:0">Ask</button></div>
  </div>
</div>

<script type="application/json" id="d">${JSON.stringify({
    id: r.id,
    name: r.name,
    steps: r.steps.map((s) => ({ n: s.n, title: s.title })),
    missing: missing.map((m) => m.name),
  }).replace(/</g, "\\u003c")}</script>
${CLIENT}
</body></html>`;
}
