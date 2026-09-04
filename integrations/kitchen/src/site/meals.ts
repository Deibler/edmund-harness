/**
 * The home page: what to cook tonight.
 *
 * A meal card, the band above it that says what kind of day the site thinks it
 * is, and the automatic-cleanup receipt that sits under both. Grouped because
 * they are one screen and they share the rules about what a card is allowed to
 * claim: the buttons on a card follow from whether the dish is written out and
 * whether the kitchen can actually make it, and nothing here may show an action
 * that would fail.
 *
 * Moved out of `site.ts` on 2026-08-17 unedited.
 */

import { join } from "node:path";
import { fitReason, fitScore, onTheClock } from "../fit.ts";
import { meals, spend } from "../insights.ts";
import { lastMade } from "../made.ts";
import { type Mood, moodScore } from "../mood.ts";
import {
  type Cookable,
  EFFORT_LABEL,
  METHOD_LABEL,
  type Recipe,
  cookable,
  effortOf,
  feedsAllWeek,
  inSeason,
} from "../recipes.ts";
import { live, openPlans } from "../store.ts";
import { escapeHtml } from "../util.ts";
import { type Ctx, mealPhoto } from "./ctx.ts";
import { ago, fmtDate, shot } from "./format.ts";
import { I } from "./icons.ts";

/**
 * The facts about a dish that only matter on a particular kind of day.
 *
 * Written as words rather than icons. An icon works for a category everybody
 * already has a picture for (a cloche means "you have made this"), and fails
 * for a claim like "one batch feeds you for four days", which is the whole
 * reason somebody would pick it on a Sunday. Capped at three so the row still
 * reads as facts about food rather than a wall of labels.
 */
export function dayPills(r: Recipe, mood: Mood): string {
  const out: string[] = [];
  const effort = effortOf(r);
  if (effort === "allday" || effort === "project") {
    out.push(`<span class="pill big">${EFFORT_LABEL[effort]}</span>`);
  }
  if (r.method === "crockpot" || r.method === "instantpot" || r.method === "grill") {
    out.push(`<span class="pill">${METHOD_LABEL[r.method]}</span>`);
  }
  if ((r.feeds_days ?? 1) >= 3) {
    out.push(`<span class="pill">Feeds ${r.feeds_days} days</span>`);
  }
  if (inSeason(r, mood.month)) out.push(`<span class="pill season">In season</span>`);
  // An occasion pill is only true near the occasion. Off-season it is noise,
  // and worse, it is noise that claims today is something it isn't.
  const occTags = mood.occasion?.tags ?? [];
  const hit = (r.occasions ?? []).find((o) => occTags.includes(o));
  if (hit && mood.occasion)
    out.push(`<span class="pill season">${escapeHtml(mood.occasion.label)}</span>`);
  else if (mood.football && (r.occasions ?? []).includes("gameday")) {
    out.push(`<span class="pill season">Game day</span>`);
  }
  return out.slice(0, 3).join("");
}

/**
 * How good a dinner this is TONIGHT, as one number.
 *
 * Two halves that had to be added together rather than chained as a tiebreak:
 * `moodScore` reads the calendar and the weather, `fitScore` reads the fridge
 * and what this house has actually eaten. Sorting on the mood alone and falling
 * through to fewest-ingredients is what made the page recommend the blandest
 * pantry dinner in the catalog every night, correctly and uselessly.
 */
export function dinnerScore(r: Recipe, ctx: Ctx): number {
  return moodScore(r, ctx.mood, ctx.acct) + fitScore(r, ctx.items, ctx.made, ctx.prof);
}

export function mealCard(c: Cookable, ctx: Ctx, built: Set<string>): string {
  const r = c.recipe;
  const fav = (ctx.prof.favorites[r.id] ?? []).length > 0;
  const compound = r.cat === "compound";
  const page = built.has(r.id);
  const made = lastMade(ctx.made, r);
  const tag = c.ready
    ? `<span class="tag ready"><span class="dot"></span>Ready</span>`
    : `<span class="tag short">Short ${c.missing.length}</span>`;

  const leads = ctx.leads.get(r.id) ?? [];
  const needsFirst = ctx.needsFirst.get(r.id) ?? [];
  const variants = ctx.variantsOf.get(r.id) ?? [];

  // Badges. Every one is a button: an icon that says "this dish is special" and
  // cannot be acted on is decoration, and decoration is what people stop seeing.
  // The cloche is the important one — a dish you have made and cannot make
  // tonight still has a page worth opening, and this is the route back to it.
  const badges: string[] = [];
  // The cloche means "this one is written out", which is true the moment the
  // page exists. Gating it on `made` as well meant a dish whose recipe had just
  // been written carried no mark at all until somebody cooked it, so the newest
  // and most useful pages were the only ones with nothing pointing at them.
  if (page) {
    badges.push(`<button class="bg-cloche" data-act="recipe" data-id="${escapeHtml(r.id)}"
      title="${made ? `Made ${escapeHtml(fmtDate(made))}. Open the recipe.` : "Written out. Open the recipe."}"
      aria-label="Open the recipe">${I.cloche}</button>`);
  }
  if (leads.length || needsFirst.length) {
    badges.push(`<button class="bg-recycle" data-act="pair" data-id="${escapeHtml(r.id)}"
      title="${escapeHtml(leads.length ? `Leftovers become ${leads[0]!.name}` : `Needs ${needsFirst[0]!.name} first`)}"
      aria-label="Cook once, eat twice">${I.recycle}</button>`);
  }
  if (variants.length) {
    badges.push(`<button class="bg-fork" data-act="variants" data-id="${escapeHtml(r.id)}"
      title="${variants.length} other version${variants.length === 1 ? "" : "s"} of this"
      aria-label="Other versions">${I.fork}</button>`);
  }
  if (r.health) {
    badges.push(`<button class="bg-leaf" data-act="health" data-id="${escapeHtml(r.id)}"
      title="Health ${r.health} out of 5" aria-label="Health ${r.health} out of 5">
      ${I.leaf}<b>${r.health}</b></button>`);
  }

  // Two buttons is the ceiling on a phone. The third action always lives one tap
  // deeper in the sheet rather than being dropped, so nothing is unreachable
  // from any state a card can be in.
  const acts: string[] = [];
  if (page) {
    acts.push(
      `<button class="btn sm alt" data-act="recipe" data-id="${escapeHtml(r.id)}">Recipe</button>`,
    );
  }
  if (page) {
    // Once a dish is written out there is nothing left to make. "Make" here used
    // to post a request that woke a model to write the recipe that already
    // existed, which is the most expensive possible way to open a link. The
    // remaining useful ask is a different version of it, so that is the button,
    // and it takes the reason in words because "a variant" on its own is a
    // question, not an instruction.
    acts.push(`<button class="btn sm" data-act="variant" data-id="${escapeHtml(r.id)}"
      data-name="${escapeHtml(r.name)}">Variant</button>`);
  } else if (c.ready) {
    acts.push(`<button class="btn sm" data-act="make" data-id="${escapeHtml(r.id)}">Make</button>`);
  } else {
    // "Short" before "Variant": the most common cause of a dish looking
    // un-makeable is a stale shelf, and building a variant around an ingredient
    // somebody actually owns is solving a problem that is not there.
    acts.push(`<button class="btn sm alt" data-act="addlist" data-id="${escapeHtml(r.id)}"
      data-name="${escapeHtml(r.name)}">Add to list</button>`);
    acts.push(`<button class="btn sm" data-act="short" data-id="${escapeHtml(r.id)}"
      data-name="${escapeHtml(r.name)}">Short ${c.missing.length}</button>`);
  }

  // Said in words as well as an icon, because "needs the pork roast first" is a
  // fact about tonight and an icon is only ever a hint that one exists. A leg
  // somebody has declined says so rather than disappearing, so the pairing is
  // still visible and the decision is still reversible.
  const skipped = (x: { id: string }, leg: "parent" | "child") =>
    ctx.skips.has(`${leg === "child" ? r.id : x.id}>${leg === "child" ? x.id : r.id}|${leg}`);
  const pairLine = needsFirst.length
    ? `<span class="pill pre">Make ${escapeHtml(needsFirst[0]!.name)} first</span>`
    : leads.length
      ? skipped(leads[0]!, "child")
        ? `<span class="pill">Not doing ${escapeHtml(leads[0]!.name)}</span>`
        : `<span class="pill pre">Then tomorrow: ${escapeHtml(leads[0]!.name)}</span>`
      : "";

  return `<article class="meal" data-meal data-cat="${escapeHtml(r.cat)}"
      data-ready="${c.ready ? 1 : 0}" data-id="${escapeHtml(r.id)}"
      data-fav="${fav ? 1 : 0}" data-health="${r.health ?? 0}" data-minutes="${r.minutes}"
      data-made="${made ? 1 : 0}" data-page="${page ? 1 : 0}"
      data-pair="${leads.length || needsFirst.length ? 1 : 0}"
      data-second="${needsFirst.length ? 1 : 0}"
      data-variants="${variants.length ? 1 : 0}"
      data-effort="${effortOf(r)}" data-method="${escapeHtml(r.method ?? "")}"
      data-week="${feedsAllWeek(r) ? 1 : 0}" data-season="${inSeason(r, ctx.mood.month) ? 1 : 0}"
      data-occ="${escapeHtml((r.occasions ?? []).join(" "))}" data-spend="${r.spend ?? 2}"
      data-fit="${Math.round(dinnerScore(r, ctx))}"
      data-q="${escapeHtml(r.name.toLowerCase())}">
    <button class="star" data-act="fav" data-id="${escapeHtml(r.id)}"
      aria-pressed="${fav}" aria-label="Favourite">${I.star}</button>
    ${badges.length ? `<div class="badges">${badges.join("")}</div>` : ""}
    ${shot(mealPhoto(ctx.assets, r.id), r.name)}
    <div class="body">
      <h3>${escapeHtml(r.name)}</h3>
      <p class="desc">${escapeHtml(r.desc)}</p>
      ${(() => {
        // A ranking nobody can see is a ranking nobody trusts, and the first
        // question about a reordered list is why. This is also the honest test
        // of the score: a card at the top with no sentence for it means a term
        // moved it for a reason the household would not agree with.
        const why = fitReason(r, ctx.items, ctx.made, ctx.prof);
        return why ? `<p class="why">${escapeHtml(why)}</p>` : "";
      })()}
      <div class="foot">
        <div class="facts">
          ${compound ? `<span class="tag comp">Leftovers</span>` : ""}${tag}
          <span class="note tabular">${r.minutes}m</span>
          ${dayPills(r, ctx.mood)}
          ${pairLine}
        </div>
        <div class="btns">${acts.join("")}</div>
      </div>
    </div>
  </article>`;
}

/**
 * The top of the home page: what day it is and what that means for dinner.
 *
 * This is the answer to the page feeling like an archive. The heading is the
 * date read as a human reads it, the sentence under it says what the page has
 * noticed, and the vibe is a dial rather than a decision made for you. When
 * nothing is special about today it says so plainly instead of manufacturing
 * an occasion, because a page that insists every Tuesday is exciting is the
 * same page that stops being read.
 *
 * The shelf chips underneath are filters, not rows: nothing on this site
 * scrolls sideways, and a horizontal rail of dish cards is the standard way
 * that rule gets broken.
 */
export function moodBand(ctx: Ctx, ready: number, order: Cookable[]): string {
  const m = ctx.mood;
  const cnt = (f: (r: Recipe) => boolean) => ctx.cook.filter((c) => f(c.recipe)).length;
  const seasonN = cnt((r) => inSeason(r, m.month));
  const weekN = cnt((r) => feedsAllWeek(r));
  const projectN = cnt((r) => ["project", "allday"].includes(effortOf(r)));
  const occTags = m.occasion?.tags ?? [];
  const occN = cnt((r) => (r.occasions ?? []).some((o) => occTags.includes(o)));
  const gameN = cnt((r) => (r.occasions ?? []).includes("gameday"));
  // Deliberately not gated on being cookable tonight. "Made before AND ready"
  // is a different, narrower question that already has a filter; this is the
  // shelf of dishes this house knows, which is what somebody means when they
  // ask to see what they have made.
  const madeN = cnt((r) => !!lastMade(ctx.made, r));

  const chip = (key: string, label: string, n: number) =>
    n === 0
      ? ""
      : `<button class="shelf" data-shelf="${key}">${escapeHtml(label)}<span class="ct">${n}</span></button>`;

  return `<div class="head mood">
    <div class="eyebrow">${escapeHtml(m.signals.map((s) => s.label).join(" · "))}</div>
    <h2>${escapeHtml(m.headline)}</h2>
    <p>${escapeHtml(m.line)}</p>
    <div class="viberow">
      <div class="vibe">
        <span class="lab">${m.pinned ? "You picked" : "Today reads as"}</span>
        <b>${escapeHtml(m.vibe.label)}</b>
      </div>
      <button class="btn sm alt" data-act="vibe">Change the vibe</button>
    </div>
    <p class="note">${ready} of ${ctx.cook.length} dishes are fully stocked, ordered for
    today rather than alphabetically.</p>
    ${(() => {
      // The escape hatch from a fixed catalog, offered only when the catalog is
      // visibly failing: something is about to be thrown out and the dish this
      // page just put at the top does not spend it. A catalog ranked against
      // stock can only ever return the least-bad card it already holds, so
      // without this the page recommends pasta at a fridge full of expiring
      // beef, confidently and forever.
      const clock = onTheClock(ctx.items, 1);
      if (!clock.length) return "";
      // The card the grid will actually LEAD with, which is `order[0]` and not
      // the first entry of `ctx.cook`: those two are sorted differently, and
      // reading the wrong one made this claim "nothing above uses the prepped
      // veg" directly above a card whose own reason line said it used it.
      const lead = order.find((c) => c.ready);
      const spent = new Set((lead?.recipe.needs ?? []).map(([id]) => id));
      // Only what the lead is ignoring. Listing food the top card already
      // spends is the same false claim in a quieter form.
      const missed = clock.filter((c) => !spent.has(c.item.id));
      if (!missed.length) return "";
      const names = missed.slice(0, 3).map((c) => c.item.name.toLowerCase());
      const more = missed.length > 3 ? ` and ${missed.length - 3} more` : "";
      return `<div class="clockrow">
        <p>Nothing above is built around the ${escapeHtml(names.join(", "))}${escapeHtml(more)}.</p>
        <button class="btn sm" data-act="compose">Write one for the clock</button>
      </div>`;
    })()}
    <div class="shelves">
      ${m.occasion ? chip("occasion", m.occasion.label, occN) : ""}
      ${!m.occasion && m.football ? chip("gameday", "Game day food", gameN) : ""}
      ${chip("made", "You have made this", madeN)}
      ${chip("season", `Good in ${new Date(2000, m.month - 1, 1).toLocaleString("en-US", { month: "long" })}`, seasonN)}
      ${chip("week", "Feeds you all week", weekN)}
      ${chip("project", "Worth an afternoon", projectN)}
      <button class="shelf" data-go="explore">Nothing like what you cook</button>
      <button class="shelf" data-act="compose">Write one for what is going off</button>
    </div>
  </div>`;
}

export function homePanel(ctx: Ctx): string {
  const plans = Object.values(openPlans(ctx.account));
  const built = new Set(ctx.book.map((r) => r.id));
  const ready = ctx.cook.filter((c) => c.ready).length;

  // Second-night dishes come OUT of the grid entirely.
  //
  // A dish built from last night's leftovers is not a dinner you can decide to
  // cook; it is what a different dinner becomes. Listing it as its own card put
  // a run of meals nobody could make into the middle of the page that answers
  // "what can we make", and made the whole list read as mostly leftovers. It now
  // lives on its parent's card, where the decision it belongs to actually gets
  // made, and stays reachable from there.
  //
  // The exception is a second-night dish whose leftover is genuinely in the
  // fridge right now, because at that point it IS tonight's dinner.
  const order = [...ctx.cook]
    .filter((c) => {
      const parents = ctx.needsFirst.get(c.recipe.id);
      if (!parents?.length) return true;
      return c.ready;
    })
    // Cookable first, then how well it fits today. The two are in that order on
    // purpose: the day's mood reorders dinners you could already have made, and
    // is never allowed to lift a dish you cannot cook above one you can.
    .sort(
      (a, b) =>
        Number(b.ready) - Number(a.ready) ||
        dinnerScore(b.recipe, ctx) - dinnerScore(a.recipe, ctx) ||
        Number(ctx.leads.has(b.recipe.id)) - Number(ctx.leads.has(a.recipe.id)),
    );

  const liveStrip = plans.length
    ? `<div class="live-wrap">
        <div class="eyebrow">In progress</div>
        ${plans
          .map(
            (p) => `<div class="live-row">
          <div>
            <h3>${escapeHtml(p.meal)}</h3>
            <div class="when">Started ${escapeHtml(ago(p.created))}. Nobody has said yet whether it happened.</div>
          </div>
          <div class="acts">
            <button class="btn sm" data-act="made" data-plan="${escapeHtml(p.id)}"
              data-name="${escapeHtml(p.meal)}">We made it</button>
            <button class="btn sm alt" data-act="cancelled" data-plan="${escapeHtml(p.id)}"
              data-name="${escapeHtml(p.meal)}">Didn't happen</button>
          </div>
        </div>`,
          )
          .join("")}
      </div>`
    : "";

  return `<section data-panel="home" data-view="grid">
    ${moodBand(ctx, ready, order)}
    ${sweepCard(ctx)}
    ${liveStrip}
    <div class="active-filters" data-af="home"></div>
    <div class="meals">${order.map((c) => mealCard(c, ctx, built)).join("")}</div>
    <div class="empty" data-noresults hidden>Nothing matches those filters.</div>
  </section>`;
}

/**
 * What the kitchen decided had gone, and the one tap that says otherwise.
 *
 * The sweep runs silently, which is the only way it can run without becoming a
 * chore. Silence is only acceptable because being wrong is cheap: this card is
 * the whole cost of a bad guess, and it retracts the entire batch at once.
 */
export function sweepCard(ctx: Ctx): string {
  const s = ctx.sweep;
  if (!s || !s.items.length) return "";
  const names = s.items.map((i) => ctx.items[i.id]?.name ?? i.id);
  const shown = names.slice(0, 4).map(escapeHtml).join(", ");
  const more = names.length > 4 ? ` and ${names.length - 4} more` : "";
  return `<div class="sweepcard">
    <div>
      <div class="eyebrow">Tidied up ${escapeHtml(ago(s.at))}</div>
      <p>Took ${names.length} thing${names.length === 1 ? "" : "s"} off the shelves that had
      almost certainly gone: ${shown}${more}. Nobody had to log it.</p>
    </div>
    <button class="btn sm alt" data-act="unsweep" data-batch="${escapeHtml(s.batch)}">
      Still here, put ${names.length === 1 ? "it" : "them"} back</button>
  </div>`;
}
