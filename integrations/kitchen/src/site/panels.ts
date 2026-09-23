/**
 * The panels other than home: kitchen stock, history, shopping, explore and
 * the standing dinner texts. Each is a read of the ledger rendered as markup,
 * with no state of its own.
 */

import { eaters } from "../accounts.ts";
import { recipeCost } from "../cost.ts";
import { bestBasket } from "../deals.ts";
import { dayKey, expiring, meals } from "../insights.ts";
import { type Cookable, EFFORT_LABEL, METHOD_LABEL, type Recipe, loadRecipes } from "../recipes.ts";
import { lastChecked } from "../reconcile.ts";
import { clock, dinnersOf, nextFire, recipients } from "../schedules.ts";
import { type Line, type Suggestion, shopping } from "../shopping.ts";
import { amount, live, slug } from "../store.ts";
import type { Item } from "../types.ts";
import { escapeHtml, fmtMoney } from "../util.ts";
import { type Ctx, mealPhoto } from "./ctx.ts";
import { ago, cap, daysLabel, fmtDate, j, shot, whenWord } from "./format.ts";
import { I } from "./icons.ts";

export function kitchenPanel(ctx: Ctx): string {
  const stock = live(ctx.account, ctx.items);
  const soon = new Map(expiring(ctx.account, 6).map((i) => [i.id, i.days] as const));

  const tile = (i: Item) => {
    const d = soon.get(i.id);
    const flag =
      d === undefined
        ? ""
        : d <= 0
          ? `<span class="flag">Expired</span>`
          : `<span class="flag soon">${d}d</span>`;
    return `<article class="prod" data-prod data-cat="${escapeHtml(i.cat)}"
        data-loc="${escapeHtml(i.loc)}" data-soon="${d === undefined ? 0 : 1}"
        data-q="${escapeHtml(`${i.name} ${i.cat} ${i.loc} ${i.aliases.join(" ")}`.toLowerCase())}">
      ${shot(ctx.assets.items.has(i.id) ? `img/items/${i.id}.jpg` : null, i.name)}
      ${flag}
      <div class="body">
        <div class="nm">${escapeHtml(i.name)}</div>
        <div class="qt tabular">${escapeHtml(amount(i))}</div>
      </div>
    </article>`;
  };

  // When the shelves were last checked, and by whom (by name, not handle).
  const checked = lastChecked(ctx.account);
  const who = checked?.by
    ? (eaters(ctx.acct).find((e) => e.principal === checked.by)?.label ?? null)
    : null;

  return `<section data-panel="kitchen" data-view="grid">
    <div class="head">
      <div class="eyebrow">In the kitchen</div>
      <h2>${stock.length} things on the shelves</h2>
      <p>What the ledger currently believes is here. Counts come from receipts and cooking,
      ${
        checked
          ? `and ${who ? `${escapeHtml(who)} last checked the shelves` : "the shelves were last checked"}
           ${escapeHtml(ago(checked.at))}.`
          : `and nobody has checked them against the actual shelves yet.`
      }</p>
    </div>
    <a class="checkcard" id="checkgo" href="check.html">
      <div>
        <div class="eyebrow">Shelf check</div>
        <p>Go through what is here one item at a time. Swipe right if it is correct, left if it
        is gone or the count is wrong. A minute of this is worth more than a week of guessing.</p>
      </div>
      <span class="go">${I.chev}</span>
    </a>
    <input id="q" placeholder="Search the kitchen" autocomplete="off" inputmode="search"
      style="width:100%;padding:14px 16px;border:1px solid hsl(var(--line));border-radius:13px;
      background:hsl(var(--card));font-size:16px;margin-bottom:14px;min-height:var(--tap)">
    <div class="active-filters" data-af="kitchen"></div>
    <div class="prods">${stock.map(tile).join("")}</div>
    <div class="empty" data-noresults hidden>Nothing matches.</div>
  </section>`;
}

export function historyPanel(ctx: Ctx): string {
  const { seed } = loadRecipes();
  const ms = meals(ctx.account);
  const cooked = [
    ...seed.map((s) => ({
      date: s.date,
      name: s.meal,
      items: [] as string[],
      kcal: null as number | null,
    })),
    ...ms.map((m) => ({
      date: dayKey(m.at),
      name: m.name,
      items: m.items.map((i) => ctx.items[i.id]?.name ?? i.id),
      kcal: m.macros.kcal ? Math.round(m.macros.kcal) : null,
    })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  const byDate: Record<string, string[]> = {};
  for (const c of cooked) {
    const names = byDate[c.date] ?? [];
    names.push(c.name);
    byDate[c.date] = names;
  }

  const buys = Object.values(ctx.items)
    .filter((i) => i.added)
    .sort((a, b) => b.added.localeCompare(a.added))
    .slice(0, 150);

  /**
   * The recipe id a logged meal name refers to. Meals are logged by free text
   * ("creamy mushroom chicken over egg noodles, side salad"), so a logged name
   * that extends a dish's name on a slug boundary counts; the longest match wins.
   */
  const dishes = [...ctx.cook.map((c) => c.recipe), ...ctx.book].map((r) => ({
    id: r.id,
    key: slug(r.name),
  }));
  const resolveDish = (name: string): string => {
    const k = slug(name);
    const exact = dishes.find((d) => d.id === k || d.key === k);
    if (exact) return exact.id;
    let best: { id: string; key: string } | undefined;
    for (const d of dishes) {
      if (k.startsWith(`${d.key}-`) && (!best || d.key.length > best.key.length)) best = d;
    }
    return best?.id ?? k;
  };

  const row = (c: (typeof cooked)[number]) => {
    const id = resolveDish(c.name);
    const compound = c.items.some((n) => /^leftover/i.test(n));
    return `<button class="hrow2" data-act="past" data-id="${escapeHtml(id)}"
        data-name="${escapeHtml(c.name)}">
      ${shot(mealPhoto(ctx.assets, id), c.name)}
      <div style="min-width:0">
        <div class="nm">${escapeHtml(c.name)}</div>
        <div class="dt">
          <span>${escapeHtml(fmtDate(c.date))}</span>
          ${c.items.length ? `<span>${c.items.length} ingredients</span>` : ""}
          ${c.kcal ? `<span class="tabular">${c.kcal} kcal</span>` : ""}
          ${compound ? `<span class="tag comp">Leftovers</span>` : ""}
        </div>
      </div>
      <span class="rt">${I.chev}</span>
    </button>`;
  };

  const buyRow = (i: Item) => `<div class="hrow2">
    ${shot(ctx.assets.items.has(i.id) ? `img/items/${i.id}.jpg` : null, i.name)}
    <div><div class="nm">${escapeHtml(i.name)}</div>
      <div class="dt"><span>Added ${escapeHtml(fmtDate(dayKey(new Date(i.added))))}</span>
      ${i.store ? `<span>${escapeHtml(i.store)}</span>` : ""}</div></div>
    <div class="rt"><span class="note tabular">${escapeHtml(amount(i))}</span></div>
  </div>`;

  // Every dish with its cost from this kitchen's own receipts (see `recipeCost`)
  // and the date it was last made. Meals are logged by name, so look up both the
  // recipe id and its slugged name, and accept a logged name that extends the
  // recipe name on a slug boundary.
  const madeByName = new Map<string, string>();
  for (const c of cooked) {
    const k = slug(c.name);
    if (!madeByName.has(k)) madeByName.set(k, c.date);
  }
  const madeOn = (r: Recipe): string | undefined => {
    const exact = madeByName.get(r.id) ?? madeByName.get(slug(r.name));
    if (exact) return exact;
    const base = slug(r.name);
    for (const [k, date] of madeByName) {
      if (k.startsWith(`${base}-`)) return date;
    }
    return undefined;
  };
  const recipeRow = (c: Cookable) => {
    const k = recipeCost(c.recipe, ctx.items, ctx.prices);
    const made = madeOn(c.recipe);
    // "+" marks a total missing some unpriced ingredients.
    const money = k.priced ? `$${k.total.toFixed(2)}${k.complete ? "" : "+"}` : "no prices yet";
    return `<button class="hrow2" data-act="past" data-id="${escapeHtml(c.recipe.id)}"
        data-name="${escapeHtml(c.recipe.name)}">
      ${shot(mealPhoto(ctx.assets, c.recipe.id), c.recipe.name)}
      <div style="min-width:0">
        <div class="nm">${escapeHtml(c.recipe.name)}</div>
        <div class="dt">
          <span>${made ? `Last made ${escapeHtml(fmtDate(made))}` : "Never made"}</span>
          <span class="tabular">${c.recipe.minutes}m</span>
          ${
            c.ready
              ? `<span class="tag ready"><span class="dot"></span>Ready</span>`
              : `<span class="tag short">Short ${c.missing.length}</span>`
          }
        </div>
      </div>
      <div class="rt"><span class="cost tabular">${money}</span></div>
    </button>`;
  };
  const byCost = [...ctx.cook].sort((a, b) => {
    const ka = recipeCost(a.recipe, ctx.items, ctx.prices).total;
    const kb = recipeCost(b.recipe, ctx.items, ctx.prices).total;
    return kb - ka;
  });

  return `<section data-panel="history" data-view="list">
    <div class="head">
      <div class="eyebrow">History</div>
      <h2>${cooked.length} meals on the record</h2>
      <p>Tap any meal to see whether it can be made again tonight. The filter switches
      this to everything bought, or to every recipe with what it costs to cook.</p>
    </div>
    <div class="active-filters" data-af="history"></div>
    <div data-hview="list">
      <div class="hist" data-hfilter="meals">
        ${cooked.length ? cooked.map(row).join("") : `<div class="empty">Nothing cooked yet.</div>`}
      </div>
      <div class="hist" data-hfilter="items" hidden>${buys.map(buyRow).join("")}</div>
      <div class="hist" data-hfilter="recipes" hidden>${byCost.map(recipeRow).join("")}</div>
    </div>
    <div data-hview="cal" hidden><div class="cal" id="cal"></div></div>
    <script type="application/json" id="cal-data">${j(byDate)}</script>
  </section>`;
}

/**
 * The shopping list, one card per group from `shopping.ts`, with the
 * suggestion tray, the held-back items and per-store basket prices below it.
 * Presentation only.
 */
export function shoppingPanel(ctx: Ctx): string {
  const s = shopping(ctx.account);
  const soon = expiring(ctx.account, 6);
  const baskets = bestBasket(
    s.lines.filter((l) => l.item).map((l) => ({ id: l.item!, name: l.name })),
  );

  const stale = (l: { bought?: number | null }) =>
    l.bought !== null && l.bought !== undefined && l.bought <= 2
      ? `<span class="note" style="color:hsl(var(--warn));margin-left:7px">bought ${
          l.bought === 0 ? "today" : l.bought === 1 ? "yesterday" : `${l.bought}d ago`
        }</span>`
      : "";

  const line = (l: Line) => `<div class="listrow">
    <button class="check" data-act="tick" data-id="${escapeHtml(l.key)}" aria-pressed="false">
      <span class="box">${I.tick}</span>
      <span style="min-width:0">
        <span class="lb" style="font-weight:500;display:block">${escapeHtml(l.name)}${
          l.amount
            ? `<span class="note" style="margin-left:7px">${escapeHtml(l.amount)}</span>`
            : ""
        }</span>
        <span class="note" style="color:hsl(var(--accent))">${escapeHtml(l.why)}</span>${stale(l)}
      </span>
    </button>
    <button class="iconbtn" data-act="lineedit" data-id="${escapeHtml(l.key)}"
      data-name="${escapeHtml(l.name)}" data-reason="${escapeHtml(l.reason)}"
      data-item="${escapeHtml(l.item ?? "")}" aria-label="Change ${escapeHtml(l.name)}">${I.more}</button>
  </div>`;

  const suggestion = (x: Suggestion) => `<div class="sugrow">
    <div style="min-width:0">
      <span class="lb" style="font-weight:500;display:block">${escapeHtml(x.name)}${stale(x)}</span>
      <span class="note">${escapeHtml(x.why)}${
        x.unlocks.length
          ? ` · ${escapeHtml(x.unlocks.slice(0, 2).join(", "))}${
              x.unlocks.length > 2 ? ` +${x.unlocks.length - 2}` : ""
            }`
          : ""
      }</span>
    </div>
    <div class="sugacts">
      <button class="btn sm" data-act="sugadd" data-id="${escapeHtml(x.item)}"
        data-name="${escapeHtml(x.name)}" data-kind="${escapeHtml(x.kind)}">Add</button>
      ${
        x.kind === "restock"
          ? `<button class="btn sm ghost" data-act="sugnever" data-id="${escapeHtml(x.item)}"
             data-name="${escapeHtml(x.name)}">One-off</button>`
          : ""
      }
    </div>
  </div>`;

  return `<section data-panel="shopping" data-view="list">
    <div class="head">
      <div class="eyebrow">Shopping</div>
      <h2>${s.lines.length} to pick up</h2>
      <p>Only things that ran out, things we think you are out of, a meal you committed to, or a line you wrote.
      Ideas live in the tray at the bottom and never sneak onto the list.</p>
    </div>
    ${
      soon.length
        ? `<div class="grid4" style="margin-bottom:20px">
      ${soon
        .slice(0, 4)
        .map(
          (i) => `<div class="panelcard stat">
        <span class="v tabular">${i.days <= 0 ? "0" : i.days}</span>
        <span class="k">days · ${escapeHtml(i.name)}</span></div>`,
        )
        .join("")}
    </div>`
        : ""
    }

    ${
      s.groups.length
        ? s.groups
            .map(
              (g) => `<div class="panelcard" style="margin-bottom:16px">
          <h3 style="font-size:18px;font-weight:600;margin-bottom:4px">${escapeHtml(g.title)}</h3>
          <p class="note" style="margin-bottom:10px">${escapeHtml(g.note)}</p>
          ${g.lines.map(line).join("")}
        </div>`,
            )
            .join("")
        : `<div class="panelcard" style="margin-bottom:16px">
          <div class="empty">Nothing is out and nothing is planned. This is what an
          empty list is supposed to look like.</div>
        </div>`
    }

    <div class="panelcard" style="margin-bottom:16px">
      <button class="btn wide" data-act="listdone" ${s.lines.length ? "" : "disabled"}>
        Finished shopping</button>
      <p class="note" style="margin-top:8px">Tick as you go. Finishing archives the trip
      and clears anything a receipt shows you actually bought.</p>
      <button class="btn wide ghost" data-act="listnotes" style="margin-top:8px">
        Send this to Apple Notes</button>
    </div>

    ${
      s.suggestions.length
        ? `<div class="panelcard" style="margin-bottom:16px">
      <h3 style="font-size:18px;font-weight:600;margin-bottom:4px">Worth a thought</h3>
      <p class="note" style="margin-bottom:10px">Not the list. These ran out or would open up
      dinners, and I do not know whether you want them again. Answer once and I stop asking.</p>
      ${s.suggestions.map(suggestion).join("")}
    </div>`
        : ""
    }

    ${
      s.held.length
        ? `<details class="panelcard" style="margin-bottom:16px">
      <summary class="note">${s.held.length} thing${s.held.length === 1 ? "" : "s"} kept off this list</summary>
      <div style="margin-top:10px">
        ${s.held
          .map(
            (h) => `<div class="needline">
          <span>${escapeHtml(h.name)}</span>
          <span class="note">${escapeHtml(h.why)}</span></div>`,
          )
          .join("")}
      </div>
    </details>`
        : ""
    }

    <div class="panelcard">
      <h3 style="font-size:18px;font-weight:600;margin-bottom:8px">Where to buy it</h3>
      ${
        baskets.length
          ? baskets
              .map(
                (b) => `<div class="needline">
            <span style="font-weight:500;text-transform:capitalize">${escapeHtml(b.store)}</span>
            <span class="st tabular" style="text-transform:none;font-weight:500">
              ${escapeHtml(fmtMoney(b.total))} · ${b.covers}/${s.lines.length}</span></div>`,
              )
              .join("")
          : `<p class="note">No price data loaded, so I am not going to guess what anything costs.
           Prices get imported per store rather than scraped live.</p>`
      }
    </div>
  </section>`;
}

/**
 * Dishes unlike anything the house cooks. Kept off the home page, which only
 * shows what the shelves can make; everything here needs a shopping trip.
 */
export function explorePanel(ctx: Ctx): string {
  const set = ctx.explore;
  const themes: Array<[string, string]> = [
    ["", "Surprise me"],
    ["fast weeknight food, 30 minutes or less", "Fast"],
    ["a weekend project worth an afternoon", "A project"],
    ["cheap, feeds a house for very little", "Cheap"],
    ["slow cooker food that feeds us for days", "Slow cooker"],
    ["vegetarian, nothing that pretends to be meat", "No meat"],
  ];
  const themeRow = `<div class="shelves" style="margin-top:18px">
    ${themes
      .map(
        ([t, label]) =>
          `<button class="shelf" data-act="explore" data-theme="${escapeHtml(t)}">${escapeHtml(label)}</button>`,
      )
      .join("")}
  </div>`;

  const cards = (set?.dishes ?? [])
    .map(
      (d) => `<article class="idea">
    <div class="from">${escapeHtml(d.cuisine)}</div>
    <h3>${escapeHtml(d.name)}</h3>
    <p class="desc">${escapeHtml(d.desc)}</p>
    ${d.why ? `<p class="why">${escapeHtml(d.why)}</p>` : ""}
    <div class="facts">
      <span class="pill">${d.minutes}m</span>
      <span class="pill big">${EFFORT_LABEL[d.effort]}</span>
      <span class="pill">${METHOD_LABEL[d.method]}</span>
      <span class="pill">${"$".repeat(d.spend)}</span>
    </div>
    ${d.buy.length ? `<div class="buy"><b>You would need to buy</b>${escapeHtml(d.buy.join(", "))}</div>` : ""}
    ${d.have.length ? `<div class="buy"><b>Already in the house</b>${escapeHtml(d.have.join(", "))}</div>` : ""}
    <div class="btns">
      <button class="btn sm alt" data-act="idealist" data-idea="${escapeHtml(d.id)}"
        data-name="${escapeHtml(d.name)}">Add the shopping to my list</button>
      <button class="btn sm" data-act="idearecipe" data-idea="${escapeHtml(d.id)}"
        data-name="${escapeHtml(d.name)}">Write me the recipe</button>
    </div>
  </article>`,
    )
    .join("");

  return `<section data-panel="explore" data-view="grid">
    <div class="head">
      <div class="eyebrow">Explore</div>
      <h2>Nothing like what you cook</h2>
      <p>Everywhere else on this site is checked against your shelves. This is the
      opposite on purpose: dishes picked for being unlike your own, which means every
      one of them is a shopping trip. Nothing here can be made tonight and nothing here
      touches the ledger.</p>
      ${themeRow}
    </div>
    ${
      set
        ? `<p class="note" style="margin-bottom:16px">Generated ${escapeHtml(ago(set.generated))}${set.theme ? ` for "${escapeHtml(set.theme)}"` : ""}.</p>${cards}`
        : `<div class="empty">Nothing generated yet. Pick a direction above and I will
         go and find some, which takes about half a minute.</div>`
    }
  </section>`;
}

/** Standing dinner texts. Each row says who receives it and when it next fires. */
export function schedulePanel(ctx: Ctx): string {
  const list = dinnersOf(ctx.acct);
  const rows = list
    .map((d) => {
      const next = nextFire(d);
      const who =
        recipients(d, ctx.acct)
          .map((e) => e.label)
          .join(" and ") || "nobody";
      return `<div class="sched" data-on="${d.on ? 1 : 0}">
      <div class="when">${escapeHtml(clock(d.at))}
        <small>${escapeHtml(daysLabel(d.days))}</small></div>
      <div class="body">
        <div class="t">${escapeHtml(cap(d.meal))} to ${escapeHtml(who)}</div>
        <div class="s">${
          d.on
            ? next
              ? `Next ${escapeHtml(whenWord(next))}.`
              : "On, but no day left to fire on."
            : "Paused."
        }${d.note ? ` Steer: ${escapeHtml(d.note)}.` : ""}${
          d.last ? ` Last sent ${escapeHtml(ago(d.last))}.` : " Never sent yet."
        }</div>
        <div class="btns">
          <button class="btn sm alt" data-act="schedit" data-sched="${escapeHtml(d.id)}">Edit</button>
          <button class="btn sm alt" data-act="schtoggle" data-sched="${escapeHtml(d.id)}"
            data-on="${d.on ? 1 : 0}">${d.on ? "Pause" : "Turn back on"}</button>
          <button class="btn sm alt" data-act="schdel" data-sched="${escapeHtml(d.id)}">Delete</button>
        </div>
      </div>
    </div>`;
    })
    .join("");

  return `<section data-panel="schedule">
    <div class="head">
      <div class="eyebrow">Schedule</div>
      <h2>Standing dinner texts</h2>
      <p>Everything else on this site waits for you to open it. This is the one thing
      that comes to you: at the time you pick, I work out what the shelves can actually
      cook, text it to whoever is on the list, and send the written recipe with it. If
      that dish has never been written out, I write it and the page follows a minute
      later. Nothing here takes food off your shelves.</p>
      <div class="shelves">
        <button class="shelf" data-act="schnew">Add a time</button>
      </div>
    </div>
    ${
      list.length
        ? rows
        : `<div class="empty">No standing texts yet. Add one above, or
      just text me something like "text us at 4 every day with dinner" and I will set
      it up from there.</div>`
    }
    <p class="note" style="margin-top:20px">These fire from this Mac, once a day each. If
    it is asleep at the time and wakes up more than about an hour later, that day gets
    skipped rather than sent late. A text at nine about a four o'clock dinner is worse
    than no text.</p>
  </section>`;
}
