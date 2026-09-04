/**
 * The per-account website.
 *
 * WHAT THIS IS. A storefront for food the household already owns, crossed with
 * a library. The shop half is HelloFresh and Instacart: browse dishes, see what
 * is in stock, put one in motion. The library half is Spotify: a history you
 * can scroll, favourites, and a recap that treats a year of dinners as a story
 * rather than a table. Everything on it is derived from the ledger, so no
 * feature here asks anyone to fill in a form first.
 *
 * MOBILE FIRST, MEANT LITERALLY. The previous pass put filters in a horizontal
 * chip rail and nav in a top bar, which is a desktop layout that merely fits on
 * a phone. Here there are exactly three controls in the header — where you are,
 * a filter button, and the menu — and both the menu and the filters open as
 * full sheets. Nothing scrolls sideways. Every tap target clears 44px.
 *
 * THINGS THAT DRIVE REAL DECISIONS, not just breakpoints:
 *   - every image request carries the share key, appended client-side from
 *     `location.search`, because the server validates the token on every GET.
 *     A plain relative `src` 403s.
 *   - the page cannot call anything, so every action POSTs to the share
 *     server's /callback and a trigger wakes the model. Chat replies come back
 *     by polling a JSON file this renderer writes next to the page.
 *   - two people share this link, so the browser picks a profile once and keeps
 *     it in a cookie. Without that, "text this to me" has no referent and a
 *     favourite belongs to nobody.
 *
 * House rules: no emoji anywhere, no em-dashes in copy. Anything inferred
 * rather than measured is labelled inline, never in a footnote nobody reads.
 *
 * WHERE THINGS LIVE. This file was 3,000 lines until 2026-08-17 and is now the
 * assembly step only: gather the ledger into one `Ctx`, ask each panel for its
 * markup, and write the files out. The parts live under `site/`:
 *
 *   style.ts    the stylesheet and the web-font links
 *   icons.ts    the inline SVG set
 *   format.ts   dates, relative times, the image-or-monogram fallback
 *   ctx.ts      the `Ctx` every panel is handed, and the meal-photo lookup
 *   meals.ts    the home page: meal cards, the mood band, the cleanup receipt
 *   panels.ts   kitchen, history, shopping, explore, schedule
 *   recap.ts    the year in review
 *   client.ts   everything the page runs in the browser
 *
 * The split was a pure move, verified by rendering both live households before
 * and after and requiring the HTML to be byte-identical apart from its own
 * timestamp. If you split something else out of here, do the same: a refactor
 * of a page nobody is looking at right now is only safe if it is provable.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eaters, householdTitle } from "./accounts.ts";
import { scanAssets } from "./assets.ts";
import { publishThreads } from "./chat.ts";
import { renderCheckPage } from "./checkpage.ts";
import { renderRecipePage } from "./recipepage.ts";
import { lastChecked } from "./reconcile.ts";
import { escapeHtml } from "./util.ts";

import { priceBook } from "./cost.ts";
import { lastSweep } from "./decay.ts";
import { readExplore } from "./explore.ts";
import { onTheClock } from "./fit.ts";
import { meals, recap } from "./insights.ts";
import { lastMade, madeIndex } from "./made.ts";
import { VIBES, moodFor, readWeather } from "./mood.ts";
import { METHOD_LABEL, type Recipe, compoundPairs, cookable, loadRecipes } from "./recipes.ts";
import { MEALS, dinnersOf } from "./schedules.ts";
import { fold, live, slug } from "./store.ts";

import { type Assets, noAssets } from "./assets.ts";
import { type BuiltRecipe, baseIdOf, groupRecipes, loadCookbook } from "./cookbook.ts";
import { activeSkips, loadProfiles } from "./profile.ts";
import type { Account } from "./types.ts";

import { clientScript } from "./site/client.ts";
import type { Ctx } from "./site/ctx.ts";
import { j, shot } from "./site/format.ts";
import { I } from "./site/icons.ts";
import { homePanel } from "./site/meals.ts";
import {
  explorePanel,
  historyPanel,
  kitchenPanel,
  schedulePanel,
  shoppingPanel,
} from "./site/panels.ts";
import { recapPanel } from "./site/recap.ts";
import { CSS, FONTS } from "./site/style.ts";

// ─── panels ──────────────────────────────────────────────────────────────────

// ─── page ────────────────────────────────────────────────────────────────────

/**
 * Write the whole site to disk: the hub, a page per written recipe, and the
 * chat threads the hub polls.
 *
 * One function rather than three calls at each site, because there are four
 * places that re-render (the daily pass, the request drain, the MCP tool, and
 * a hand-run script) and any one of them forgetting the recipe pages produces
 * a hub full of links to files that do not exist. The failure would be silent
 * on the machine writing it and a dead end on the phone reading it.
 */
export function writeSite(
  account: string,
  acct: Account,
  dir: string,
): { html: string; pages: number } {
  const assets = scanAssets(dir);
  const html = renderSite(account, acct, assets);
  writeFileSync(join(dir, "index.html"), html);

  const items = fold(account);
  const prices = priceBook(account);
  const made = madeIndex(account);
  const title = householdTitle(acct);
  const book = loadCookbook(account);
  const byBase = new Map<string, BuiltRecipe[]>();
  for (const r of book) {
    const b = baseIdOf(r);
    (byBase.get(b) ?? byBase.set(b, []).get(b)!).push(r);
  }
  mkdirSync(join(dir, "recipe"), { recursive: true });
  for (const r of book) {
    // The page sits one directory down, so its own photo is one level up. The
    // share key is appended in the browser, as everywhere else.
    const photo = assets.meals.has(r.id)
      ? `../img/meals/${r.id}.jpg`
      : assets.meals.has(baseIdOf(r))
        ? `../img/meals/${baseIdOf(r)}.jpg`
        : null;
    // Step photographs are checked on disk rather than through scanAssets,
    // which only indexes items and meals. Cheap: a handful of stats per recipe.
    const stepPhotos = new Set(
      r.steps
        .map((st) => st.n)
        .filter((n) => existsSync(join(dir, "img", "steps", `${r.id}-${n}.jpg`))),
    );
    writeFileSync(
      join(dir, "recipe", `${r.id}.html`),
      renderRecipePage(r, {
        items,
        prices,
        title,
        photo,
        stepPhotos,
        // A generated shot gets moved aside the first time a real one arrives, so
        // its presence is exactly the signal that the hero is somebody's own.
        ownPhoto: existsSync(join(dir, "img", "meals-generated", `${r.id}.jpg`)),
        lastMade: lastMade(made, r) ?? null,
        variants: (byBase.get(baseIdOf(r)) ?? [])
          .filter((v) => v.id !== r.id)
          .map((v) => ({ id: v.id, name: v.name, reason: v.variantReason ?? null })),
      }),
    );
  }
  // The shelf check is a page rather than a panel: it is a different posture
  // (standing at the fridge, one hand) and it takes over the whole screen.
  writeFileSync(
    join(dir, "check.html"),
    renderCheckPage({
      title,
      assets,
      account,
      items: live(account, items),
      people: eaters(acct),
      lastChecked: lastChecked(account),
    }),
  );
  publishThreads(
    account,
    eaters(acct).map((e) => e.principal),
    dir,
  );
  return { html, pages: book.length };
}

const NAV: Array<[string, string, string]> = [
  ["home", "Home", "what to cook"],
  ["kitchen", "Kitchen", "what we have"],
  ["explore", "Explore", "things you don't make"],
  ["history", "History", "what we made"],
  ["shopping", "Shopping", "what to buy"],
  ["schedule", "Schedule", "texts we get"],
  ["recap", "Recap", "the year"],
];

export function renderSite(account: string, acct: Account, assets: Assets = noAssets()): string {
  const items = fold(account);
  // Account-scoped: the shared catalog plus whatever the daily pass has written
  // from THIS kitchen's shelves this week.
  const { recipes } = loadRecipes(account);
  const book = loadCookbook(account);
  const prof = loadProfiles(account);

  const extra: Recipe[] = book
    .filter((b) => !recipes.some((r) => r.id === b.id))
    .map((b) => ({
      id: b.id,
      name: b.name,
      desc: b.desc,
      minutes: b.minutes,
      needs: b.needs,
      cat: b.cat,
    }));
  const all = [...recipes, ...extra];
  const cook = cookable(items, all);
  const pairs = compoundPairs(items, all);

  // Index the pairs from both ends, best pair first. A dish can lead into more
  // than one thing and be fed by more than one thing, and the card only ever
  // names the strongest, so ordering here is the whole ranking.
  const leads = new Map<string, Array<{ id: string; name: string; via: string[] }>>();
  const needsFirst = new Map<string, Array<{ id: string; name: string; via: string[] }>>();
  for (const p of pairs) {
    const pid = p.parent.recipe.id;
    const cid = p.child.recipe.id;
    (leads.get(pid) ?? leads.set(pid, []).get(pid)!).push({
      id: cid,
      name: p.child.recipe.name,
      via: p.via,
    });
    (needsFirst.get(cid) ?? needsFirst.set(cid, []).get(cid)!).push({
      id: pid,
      name: p.parent.recipe.name,
      via: p.via,
    });
  }

  const variantsOf = new Map<string, Array<{ id: string; name: string; reason: string | null }>>();
  for (const g of groupRecipes(book)) {
    if (g.variants.length) {
      variantsOf.set(
        g.baseId,
        g.variants.map((v) => ({ id: v.id, name: v.name, reason: v.variantReason ?? null })),
      );
    }
  }

  const ctx: Ctx = {
    account,
    acct,
    assets,
    items,
    cook,
    book,
    prof,
    prices: priceBook(account),
    sweep: lastSweep(account),
    made: madeIndex(account),
    leads,
    needsFirst,
    variantsOf,
    skips: activeSkips(prof),
    // Weather is read from cache and may well be absent. That is a normal
    // state, not a degraded one: the mood works off the calendar alone and the
    // page simply never mentions the weather rather than inventing a number.
    mood: moodFor(acct, readWeather(account)),
    explore: readExplore(account),
  };

  const people = eaters(acct);
  const stock = live(account, items);
  const title = householdTitle(acct);

  const mealCats = [...new Set(cook.map((c) => c.recipe.cat))];
  const itemCats = [...new Set(stock.map((i) => i.cat))].sort();
  const catCount = (c: string) => cook.filter((x) => x.recipe.cat === c).length;
  const itemCount = (c: string) => stock.filter((i) => i.cat === c).length;

  const bookIndex = Object.fromEntries(book.map((b) => [b.id, b]));
  const cookIndex = Object.fromEntries(
    cook.map((c) => [
      c.recipe.id,
      {
        name: c.recipe.name,
        ready: c.ready,
        minutes: c.recipe.minutes,
        cat: c.recipe.cat,
        health: c.recipe.health ?? null,
        desc: c.recipe.desc,
        from: c.recipe.from ?? [],
        needs: c.needs.map((n) => ({ name: n.name, state: n.state })),
        missing: c.missing.map((n) => n.name),
        // Names are for reading, ids are for writing. The short sheet corrects the
        // ledger, so it needs the slug, and pairing them by index keeps the two
        // lists honest about being the same list.
        // Names are for reading, ids are for writing, and the state and numbers are
        // what tell "the shelf is empty" apart from "there is some, just not enough".
        missingDetail: c.missing.map((n) => ({
          id: n.id,
          name: n.name,
          state: n.state,
          want: n.want,
          have: items[n.id]?.qty ?? 0,
        })),
        leads: leads.get(c.recipe.id) ?? [],
        after: needsFirst.get(c.recipe.id) ?? [],
        variants: variantsOf.get(c.recipe.id) ?? [],
      },
    ]),
  );

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
${FONTS}
<style>${CSS}</style>
</head><body>
<!-- Claiming this id opts the page out of instant-share's injected overlay bar,
     which is fixed to the bottom at z-99999 and covered the navigation. -->
<div id="instant-share-admin" hidden></div>

<header><div class="wrap hrow">
  <div class="where"><span id="where-t">${escapeHtml(title)}</span></div>
  <nav class="dnav">
    ${NAV.map(
      ([id, label]) => `<button data-go="${id}"${id === "home" ? ' aria-current="page"' : ""}>
      ${label}</button>`,
    ).join("")}
  </nav>
  <button class="iconbtn" id="filterbtn" aria-label="Filter">${I.filter}
    <span class="badge" id="fbadge" hidden>0</span></button>
  <button class="iconbtn menubtn" id="menubtn" aria-label="Menu">${I.menu}</button>
</div></header>

<main class="wrap">
  ${homePanel(ctx)}
  ${kitchenPanel(ctx)}
  ${explorePanel(ctx)}
  ${historyPanel(ctx)}
  ${shoppingPanel(ctx)}
  ${schedulePanel(ctx)}
  ${recapPanel(ctx)}
  <footer>
    ${escapeHtml(title)} · <span id="whoami">pick a profile</span> ·
    rendered ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}.
    Counts come from the ledger, never from a photo or a guess.
  </footer>
</main>

<button id="chatbtn" aria-label="Ask Edmund">${I.chat}</button>

<div class="sheet" id="menu"><div class="bg" data-close></div><div class="pane">
  <div class="grab"></div>
  <div class="shead"><h3>Go to</h3>
    <button class="iconbtn" data-close aria-label="Close">${I.close}</button></div>
  <div class="sbody">
    ${NAV.map(
      ([
        id,
        label,
        hint,
      ]) => `<button class="navitem" data-go="${id}"${id === "home" ? ' aria-current="page"' : ""}>
      ${label}<small>${hint}</small></button>`,
    ).join("")}
    <button class="navitem" data-act="settings">How we cook<small>vibe, budget, meal prep</small></button>
    <div style="margin-top:20px;padding-top:16px;border-top:1px solid hsl(var(--line))">
      <h4 style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;
        color:hsl(var(--ink-faint));margin:0 0 10px">Signed in as</h4>
      <div id="profilelist"></div>
    </div>
  </div>
</div></div>

<div class="sheet" id="filters"><div class="bg" data-close></div><div class="pane">
  <div class="grab"></div>
  <div class="shead"><h3>Filter</h3>
    <button class="iconbtn" data-close aria-label="Close">${I.close}</button></div>
  <div class="sbody" id="filterbody"></div>
  <div class="sfoot">
    <button class="btn alt" id="fclear" style="flex:1">Clear</button>
    <button class="btn" id="fapply" style="flex:2">Show results</button>
  </div>
</div></div>

<div class="sheet" id="detail"><div class="bg" data-close></div><div class="pane">
  <div class="grab"></div>
  <div class="shead"><h3 id="dtitle"></h3>
    <button class="iconbtn" data-close aria-label="Close">${I.close}</button></div>
  <div class="sbody" id="dbody"></div>
  <div class="sfoot" id="dfoot"></div>
</div></div>

<div class="sheet full" id="chat"><div class="bg" data-close></div><div class="pane">
  <div class="grab"></div>
  <div class="shead"><h3>Ask Edmund</h3>
    <button class="iconbtn" data-close aria-label="Close">${I.close}</button></div>
  <div class="sbody" id="chatbody"><div class="msgs" id="msgs"></div></div>
  <div class="sfoot">
    <div class="composer">
      <textarea id="ctext" rows="1" placeholder="Ask about this page" enterkeyhint="send"></textarea>
      <button class="btn" id="csend">Send</button>
    </div>
  </div>
</div></div>

<div class="toast" id="toast"></div>

<script type="application/json" id="data">${j({
    people,
    book: bookIndex,
    cook: cookIndex,
    title,
    mealCats: mealCats.map((c) => ({ id: c, n: catCount(c) })),
    itemCats: itemCats.map((c) => ({ id: c, n: itemCount(c) })),
    againCount: cook.filter((c) => c.ready && lastMade(ctx.made, c.recipe)).length,
    skips: [...ctx.skips.keys()],
    // What is running out, so the compose sheet can name the actual food
    // instead of asking somebody to describe their own fridge back to me.
    clock: onTheClock(ctx.items, 2).map((c) => ({ name: c.item.name, days: c.days })),
    single: people.length <= 1,
    vibes: VIBES,
    mood: {
      vibe: ctx.mood.vibe.id,
      pinned: ctx.mood.pinned,
      auto: ctx.mood.auto.id,
      autoLabel: ctx.mood.auto.label,
      headline: ctx.mood.headline,
      month: ctx.mood.month,
      occasion: ctx.mood.occasion?.label ?? null,
      occTags: ctx.mood.occasion?.tags ?? [],
      football: ctx.mood.football,
    },
    prefs: {
      mode: acct.prefs?.mode ?? "normal",
      budget: acct.budget ?? null,
      perMeal: acct.prefs?.per_meal ?? null,
      avoid: acct.prefs?.avoid_methods ?? [],
    },
    methods: Object.entries(METHOD_LABEL).map(([id, label]) => ({ id, label })),
    meals: MEALS,
    dinners: dinnersOf(acct).map((d) => ({
      id: d.id,
      at: d.at,
      days: d.days,
      to: d.to,
      meal: d.meal,
      note: d.note ?? "",
      on: d.on,
    })),
    ideas: Object.fromEntries(
      (ctx.explore?.dishes ?? []).map((d) => [
        d.id,
        {
          name: d.name,
          cuisine: d.cuisine,
          buy: d.buy,
          have: d.have,
          minutes: d.minutes,
          effort: d.effort,
          method: d.method,
          desc: d.desc,
        },
      ]),
    ),
  })}</script>
${clientScript(j(Object.fromEntries(NAV.map(([id, label]) => [id, label]))))}
</body></html>`;
}
