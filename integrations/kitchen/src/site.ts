/**
 * The per-household website: assembly and file output.
 *
 * `renderSite` gathers the ledger into one `Ctx`, asks each panel under `site/`
 * for its markup and returns the hub page. `writeSite` writes the hub, one page
 * per written recipe, the shelf-check page and the chat threads the hub polls.
 *
 * Constraints the markup relies on:
 *   - every image and data request carries the share key, appended client-side
 *     from `location.search`, because the share server checks it on every GET;
 *   - the page cannot call anything directly, so actions POST to the share
 *     server's /callback and replies arrive as JSON files written beside it;
 *   - the link is shared by a household, so the browser picks a profile once
 *     and keeps it in a cookie.
 *
 * Mobile first: three header controls, menu and filters as full sheets, no
 * horizontal scrolling, 44px tap targets. No emoji and no em-dashes in copy.
 *
 * Parts: style.ts (CSS, fonts), icons.ts (SVG), format.ts (dates, image or
 * monogram), ctx.ts (shared context), meals.ts (home), panels.ts (kitchen,
 * history, shopping, explore, schedule), recap.ts (year in review), client.ts
 * (browser script). Refactors here are proven by rendering before and after
 * and requiring byte-identical output.
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
import { exploreShelf } from "./explore.ts";
import { onTheClock } from "./fit.ts";
import { lastMade, madeIndex } from "./made.ts";
import { VIBES, moodFor, readWeather } from "./mood.ts";
import { METHOD_LABEL, compoundPairs, cookable, menu } from "./recipes.ts";
import { MEALS, dinnersOf } from "./schedules.ts";
import { fold, live } from "./store.ts";

import { type Assets, noAssets } from "./assets.ts";
import { type BuiltRecipe, baseIdOf, groupRecipes, loadCookbook } from "./cookbook.ts";
import { activeSkips, loadProfiles } from "./profile.ts";
import type { Account } from "./types.ts";

import { clientScript } from "./site/client.ts";
import type { Ctx } from "./site/ctx.ts";
import { j } from "./site/format.ts";
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

/**
 * Write the whole site to disk: the hub, a page per written recipe, the shelf
 * check and the chat threads the hub polls.
 *
 * Every re-render path (daily pass, drain, MCP tool, scripts) goes through this
 * one function so none of them can leave the hub linking to pages that were
 * never written.
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
    // Recipe pages live one directory down; the share key is appended client-side.
    const photo = assets.meals.has(r.id)
      ? `../img/meals/${r.id}.jpg`
      : assets.meals.has(baseIdOf(r))
        ? `../img/meals/${baseIdOf(r)}.jpg`
        : null;
    // `scanAssets` indexes only items and meals, so step photos are checked on disk.
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
        // A generated shot is moved aside when a real photo arrives, so its
        // presence means the hero image is the household's own.
        ownPhoto: existsSync(join(dir, "img", "meals-generated", `${r.id}.jpg`)),
        lastMade: lastMade(made, r) ?? null,
        variants: (byBase.get(baseIdOf(r)) ?? [])
          .filter((v) => v.id !== r.id)
          .map((v) => ({ id: v.id, name: v.name, reason: v.variantReason ?? null })),
      }),
    );
  }
  // The shelf check is its own full-screen page, used standing at the fridge.
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
  // The catalog, this household's own ideas and its written recipes, minus
  // the avoid list: everything the page may offer.
  const all = menu(account);
  const book = loadCookbook(account);
  const prof = loadProfiles(account);
  const cook = cookable(items, all);
  const pairs = compoundPairs(items, all);

  // Compound pairs indexed from both ends, best first: a card names only the
  // strongest pairing, so this order is the ranking.
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
    // Cached weather may be absent; the mood then works from the calendar alone.
    mood: moodFor(acct, readWeather(account)),
    explore: exploreShelf(account),
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
        // Ids let the short sheet correct the ledger; state and quantities tell
        // "none on the shelf" apart from "some, but not enough".
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
</head><body class="nojs">
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
    // What is running out, so the compose sheet can name the actual food.
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
