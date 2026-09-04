/**
 * The year in review, Wrapped-style.
 *
 * Its own file because it is the one panel that reads a whole years history
 * rather than todays state, and it is long: every figure here is a fold over
 * the ledger with its own confidence caveat, because a recap that presents a
 * guess as a measurement is worse than one that admits it is a trend.
 *
 * Moved out of `site.ts` on 2026-08-17 unedited.
 */

import { join } from "node:path";
import { kcalTarget, meals, recap, spend } from "../insights.ts";
import { slug } from "../store.ts";
import { escapeHtml, fmtMoney } from "../util.ts";
import { type Ctx, mealPhoto } from "./ctx.ts";
import { fmtDate } from "./format.ts";

export function recapPanel(ctx: Ctx): string {
  const r = recap(ctx.account, 365, 1);
  const s = spend(ctx.account, 90);
  const k = kcalTarget(ctx.account, ctx.acct.diet?.kcal_target ?? null, 1);
  const favCount = Object.keys(ctx.prof.favorites).length;
  const art = (id: string) => {
    const p = mealPhoto(ctx.assets, id);
    return p ? `<div class="art"><img data-img="${escapeHtml(p)}" alt=""></div>` : "";
  };

  const rankList = (rows: Array<{ n: string; v: string }>) =>
    rows
      .map(
        (row, i) => `<div class="rank">
      <span class="no">${i + 1}</span><span class="rn">${escapeHtml(row.n)}</span>
      <span class="rv">${escapeHtml(row.v)}</span></div>`,
      )
      .join("");

  // Only cards with something true to say. A stat that reads "1" or "0" because
  // nothing has happened yet is worse than an absent card: it makes the whole
  // page look automated rather than observed.
  const cards: string[] = [];

  cards.push(`<div class="sc a">
    <span class="lab">Dinners made at home</span>
    <div><div class="big tabular">${r.meals}</div>
    <div class="sub">${
      r.meals === 0
        ? "Nothing logged yet this year."
        : `That is ${r.meals} night${r.meals === 1 ? "" : "s"} nobody ordered out.`
    }</div></div>
    ${r.topMeals[0] ? art(slug(r.topMeals[0].name)) : ""}
  </div>`);

  if (r.meatLbs > 0) {
    cards.push(`<div class="sc b">
      <span class="lab">Meat and seafood eaten</span>
      <div><div class="big tabular">${r.meatLbs} lb</div>
      <div class="sub">Weighed from what was actually finished.${
        r.meatUsesUnweighed
          ? ` Another ${r.meatUsesUnweighed} use${r.meatUsesUnweighed === 1 ? "" : "s"} came by the package, so they are not counted here.`
          : ""
      }</div></div>
    </div>`);
  }

  if (r.compoundMeals > 0) {
    cards.push(`<div class="sc c">
      <span class="lab">Second lives</span>
      <div><div class="big tabular">${r.compoundMeals}</div>
      <div class="sub">Meal${r.compoundMeals === 1 ? "" : "s"} cooked out of another meal's
      leftovers instead of the bin.</div></div>
    </div>`);
  }

  if (r.topMeals.length) {
    cards.push(`<div class="sc d">
      <span class="lab">The one you came back to</span>
      <div><div class="mid">${escapeHtml(r.topMeals[0]!.name)}</div>
      <div class="sub">Made ${r.topMeals[0]!.times} times.</div></div>
      ${art(slug(r.topMeals[0]!.name))}
    </div>`);
    if (r.topMeals.length > 1) {
      cards.push(`<div class="sc e"><span class="lab">Repeat offenders</span>
        <div style="margin-top:10px">${rankList(r.topMeals.map((m) => ({ n: m.name, v: `${m.times}x` })))}</div>
      </div>`);
    }
  } else if (r.meals > 1) {
    cards.push(`<div class="sc d">
      <span class="lab">Range</span>
      <div><div class="big tabular">${r.distinctMeals}</div>
      <div class="sub">Different dishes, and not one repeat yet. This kitchen does not
      have a rut.</div></div>
    </div>`);
  }

  if (r.topItems.length > 1) {
    cards.push(`<div class="sc f"><span class="lab">Most reached for</span>
      <div style="margin-top:10px">${rankList(
        r.topItems.slice(0, 5).map((m) => ({ n: m.name, v: `${m.times}x` })),
      )}</div>
    </div>`);
  }

  if (r.longestStreak && r.longestStreak.days > 1) {
    cards.push(`<div class="sc b wide">
      <span class="lab">Longest streak</span>
      <div><div class="big tabular">${r.longestStreak.days} days</div>
      <div class="sub">Cooked every night from ${escapeHtml(fmtDate(r.longestStreak.from))}
      to ${escapeHtml(fmtDate(r.longestStreak.to))}.</div></div>
    </div>`);
  }

  if (favCount) {
    cards.push(`<div class="sc e">
      <span class="lab">Starred</span>
      <div><div class="big tabular">${favCount}</div>
      <div class="sub">Dish${favCount === 1 ? "" : "es"} someone in this house marked as a keeper.</div></div>
    </div>`);
  }

  if (r.newThings.length) {
    cards.push(`<div class="sc c"><span class="lab">New to this kitchen</span>
      <div style="margin-top:10px">${rankList(
        r.newThings.slice(0, 5).map((n) => ({ n: n.name, v: fmtDate(n.at) })),
      )}</div>
    </div>`);
  }

  return `<section data-panel="recap" data-view="grid">
    <div class="head">
      <div class="eyebrow">Recap</div>
      <h2>${escapeHtml(r.headline)}</h2>
      <p>Counted from what actually got logged over the last ${escapeHtml(r.window)}. Cards only
      appear once there is something real to say, so this page grows as you cook.</p>
    </div>
    <div class="story">${cards.join("")}</div>
    <div class="grid4" style="margin-top:20px">
      <div class="panelcard stat"><span class="v tabular">${fmtMoney(s.total)}${s.unpricedTrips.length ? "+" : ""}</span>
        <span class="k">groceries, ${s.trips} trip${s.trips === 1 ? "" : "s"}</span></div>
      <div class="panelcard stat"><span class="v tabular">${s.perWeek === null ? "—" : fmtMoney(s.perWeek)}</span>
        <span class="k">per week</span></div>
      <div class="panelcard stat"><span class="v tabular">${r.distinctMeals}</span>
        <span class="k">different dishes</span></div>
      <div class="panelcard stat"><span class="v tabular">${Math.round(r.wasteRate * 100)}%</span>
        <span class="k">thrown out</span></div>
    </div>
    <p class="note" style="margin-top:14px">
      ${
        s.byStore.length
          ? `Spend is the printed total of ${s.pricedTrips} receipt${s.pricedTrips === 1 ? "" : "s"}
           (${s.byStore.map((b) => `${escapeHtml(b.store)} ${fmtMoney(b.total)}`).join(", ")}).`
          : "No receipts priced yet."
      }
      ${
        s.unpricedTrips.length
          ? `${s.unpricedTrips.length} trip${s.unpricedTrips.length === 1 ? "" : "s"} in the log
           carry no total, so the real figure is higher.`
          : ""
      }
      Calories per day: ${
        r.avgKcal === null
          ? "not enough logged yet"
          : `${Math.round(r.avgKcal)} (${escapeHtml(r.kcalConfidence)})`
      }.
      Reference: ${k.target === null ? "none inferred yet" : `${k.target}, ${escapeHtml(k.source)}`}.
      ${
        r.tossed.length
          ? `Wasted recently: ${escapeHtml(
              r.tossed
                .slice(0, 4)
                .map((t) => t.name)
                .join(", "),
            )}.`
          : ""
      }
    </p>
  </section>`;
}
