/**
 * The home page: the mood band, the meal grid, meals in progress and the
 * automatic-cleanup card. A card only offers actions that can succeed from its
 * state: whether the dish is written out and whether the kitchen can make it.
 */

import { fitReason, fitScore, onTheClock } from "../fit.ts";
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
import { openPlans } from "../store.ts";
import { escapeHtml } from "../util.ts";
import { type Ctx, mealPhoto } from "./ctx.ts";
import { ago, fmtDate, shot } from "./format.ts";
import { I } from "./icons.ts";

/**
 * Word pills for facts that matter on a particular kind of day (effort, method,
 * feeds several days, season, occasion). At most three.
 */
function dayPills(r: Recipe, mood: Mood): string {
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
  // An occasion pill only shows near the occasion itself.
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
 * How well a dish fits tonight: the day (`moodScore`) plus the fridge and the
 * household's history (`fitScore`), summed rather than used as tiebreaks.
 */
function dinnerScore(r: Recipe, ctx: Ctx): number {
  return moodScore(r, ctx.mood, ctx.acct) + fitScore(r, ctx.items, ctx.made, ctx.prof);
}

function mealCard(c: Cookable, ctx: Ctx, built: Set<string>): string {
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

  // Every badge is a button. The cloche marks a written-out dish (whether or
  // not it has been cooked yet) and is the route back to its page.
  const badges: string[] = [];
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

  // At most two buttons on a phone; any further action lives in the card's sheet.
  // A written dish offers its recipe and a variant rather than "Make", which
  // would only ask for a page that already exists.
  const acts: string[] = [];
  if (page) {
    acts.push(
      `<button class="btn sm alt" data-act="recipe" data-id="${escapeHtml(r.id)}">Recipe</button>`,
    );
    acts.push(`<button class="btn sm" data-act="variant" data-id="${escapeHtml(r.id)}"
      data-name="${escapeHtml(r.name)}">Variant</button>`);
  } else if (c.ready) {
    acts.push(`<button class="btn sm" data-act="make" data-id="${escapeHtml(r.id)}">Make</button>`);
  } else {
    // A dish that looks short is most often a stale shelf, so "Short" (correct
    // the ledger) is offered rather than a variant.
    acts.push(`<button class="btn sm alt" data-act="addlist" data-id="${escapeHtml(r.id)}"
      data-name="${escapeHtml(r.name)}">Add to list</button>`);
    acts.push(`<button class="btn sm" data-act="short" data-id="${escapeHtml(r.id)}"
      data-name="${escapeHtml(r.name)}">Short ${c.missing.length}</button>`);
  }

  // The pairing in words. A declined leg stays visible so the choice can be undone.
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
        // Why the ranking put this card here, when there is a reason worth saying.
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
 * The top of the home page: the day, what the page noticed about it, the vibe
 * dial, and shelf chips that act as filters (never a sideways-scrolling rail).
 */
function moodBand(ctx: Ctx, ready: number, order: Cookable[]): string {
  const m = ctx.mood;
  const cnt = (f: (r: Recipe) => boolean) => ctx.cook.filter((c) => f(c.recipe)).length;
  const seasonN = cnt((r) => inSeason(r, m.month));
  const weekN = cnt((r) => feedsAllWeek(r));
  const projectN = cnt((r) => ["project", "allday"].includes(effortOf(r)));
  const occTags = m.occasion?.tags ?? [];
  const occN = cnt((r) => (r.occasions ?? []).some((o) => occTags.includes(o)));
  const gameN = cnt((r) => (r.occasions ?? []).includes("gameday"));
  // Every dish made before, cookable tonight or not.
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
      // Offer to write a dish for expiring food only when the lead card does
      // not already use it.
      const clock = onTheClock(ctx.items, 1);
      if (!clock.length) return "";
      // The grid's actual lead, from `order`, not `ctx.cook`: they sort differently.
      const lead = order.find((c) => c.ready);
      const spent = new Set((lead?.recipe.needs ?? []).map(([id]) => id));
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

  // Second-night dishes live on their parent's card, not in the grid, unless
  // the leftover they need is already in the fridge.
  const order = [...ctx.cook]
    .filter((c) => {
      const parents = ctx.needsFirst.get(c.recipe.id);
      if (!parents?.length) return true;
      return c.ready;
    })
    // Cookable first; the day's fit only reorders within each group.
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

/** The last automatic cleanup, with one tap to undo the whole batch. */
function sweepCard(ctx: Ctx): string {
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
