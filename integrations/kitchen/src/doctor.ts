/**
 * Is this household actually wired up?
 *
 * Every feature here degrades quietly by design. No weather means the page
 * never mentions weather; no price book means deals report as unknown; no
 * written recipe means a card offers to write one. That is the right behaviour
 * for a person reading the page and the wrong behaviour for whoever set it up,
 * because the difference between "this household has no shopping list" and
 * "this household's site has never been served to anybody" looks identical from
 * the outside: a quiet, correct-looking page.
 *
 * So the quiet is made loud in exactly one place. Nothing here changes
 * anything; it reads the same state every other module reads and says which
 * parts are broken, which are merely absent, and which are fine. The
 * distinction matters more than the list does:
 *
 *   BROKEN   something claims to work and does not. A schedule that texts a
 *            person who has left, a site directory that does not exist.
 *   ABSENT   a real, valid state that costs a feature. No coordinates, no
 *            served URL, an empty catalog. Never described as an error.
 *   OK       checked and true.
 *
 * Written after Jordan's household turned out to have a perfectly rendered
 * website that no server had ever served and no trigger had ever watched. Every
 * individual piece reported success.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { eaters, getAccount, listAccounts } from "./accounts.ts";
import { loadCookbook } from "./cookbook.ts";
import { readList } from "./list.ts";
import { readWeather } from "./mood.ts";
import { cookable, loadRecipes } from "./recipes.ts";
import { dinnersOf, nextFire, recipients } from "./schedules.ts";
import { corruptLines, fold, live, readLog } from "./store.ts";
import type { Account } from "./types.ts";

export type Level = "ok" | "absent" | "broken";

export type Finding = {
  level: Level;
  what: string;
  detail: string;
  /** What a person would do about it. Only set when there is something to do. */
  fix?: string;
};

export type Report = { account: string; title: string; findings: Finding[] };

const ok = (what: string, detail: string): Finding => ({ level: "ok", what, detail });
const absent = (what: string, detail: string, fix?: string): Finding => ({
  level: "absent",
  what,
  detail,
  ...(fix ? { fix } : {}),
});
const broken = (what: string, detail: string, fix: string): Finding => ({
  level: "broken",
  what,
  detail,
  fix,
});

/**
 * Everything checkable about one household, without touching the network.
 *
 * Deliberately synchronous and cheap enough to run on every daily pass. Whether
 * a URL actually answers is a separate, slower question and lives in the daily
 * script, which already fetches the page to compare its length.
 */
export function checkAccount(id: string): Report {
  const acct = getAccount(id);
  if (!acct) {
    return {
      account: id,
      title: id,
      findings: [
        broken(
          "household",
          `no household called "${id}"`,
          "check the id against kitchen_accounts list",
        ),
      ],
    };
  }
  const f: Finding[] = [];
  const people = eaters(acct);

  /* ── who ─────────────────────────────────────────────────────────────── */

  if (!acct.members.length) {
    f.push(
      broken(
        "members",
        "nobody is linked to this household",
        "kitchen_accounts action:join with the session key that should own it",
      ),
    );
  } else if (!people.length) {
    // A household whose only member is a group chat has no messageable person,
    // so "text this to me" and every schedule silently reach nobody.
    f.push(
      broken(
        "members",
        `${acct.members.length} member(s), all group chats and no individual`,
        "add at least one imessage:dm: principal, or nothing can be texted",
      ),
    );
  } else {
    f.push(
      ok(
        "members",
        `${people.length} eater(s): ${people.map((p) => p.label).join(", ")}${people.length === 1 ? " (single-person household)" : ""}`,
      ),
    );
  }

  // The same principal in two households makes every resolution order-dependent.
  const others = listAccounts().filter((a) => a.id !== id);
  const doubled = acct.members.filter((m) => others.some((o) => o.members.includes(m)));
  if (doubled.length) {
    f.push(
      broken(
        "membership",
        `${doubled.join(", ")} also belong(s) to another household`,
        "leave one of them; which fridge a chat resolves to must not depend on sort order",
      ),
    );
  }

  /* ── the ledger ──────────────────────────────────────────────────────── */

  const events = readLog(id);
  const bad = corruptLines.get(id) ?? [];
  if (bad.length) {
    f.push(
      broken(
        "ledger",
        `${bad.length} unreadable line(s): ${bad.join(", ")}`,
        "everything derived is computed without them; a human should look at the file",
      ),
    );
  }
  const stock = live(id, fold(id));
  if (!events.length) f.push(absent("ledger", "no events yet", "log a receipt or a meal"));
  else if (!stock.length) {
    f.push(
      absent(
        "stock",
        `${events.length} events but nothing currently in stock`,
        "either the shelves are genuinely empty or a sweep took too much",
      ),
    );
  } else f.push(ok("ledger", `${events.length} events, ${stock.length} items in stock`));

  /* ── what it can suggest ─────────────────────────────────────────────── */

  const { recipes } = loadRecipes(id);
  const book = loadCookbook(id);
  const ready = cookable(fold(id), recipes).filter((c) => c.ready).length;
  if (!recipes.length) {
    f.push(
      absent(
        "meals",
        "no catalog and no ideas yet",
        "the daily pass writes ideas once the ledger has more than eight items",
      ),
    );
  } else if (!ready) {
    f.push(
      absent(
        "meals",
        `${recipes.length} dishes known, none cookable from current stock`,
        "normal for a bare kitchen; the daily pass rewrites ideas against what is actually there",
      ),
    );
  } else
    f.push(
      ok(
        "meals",
        `${recipes.length} dishes, ${ready} cookable right now, ${book.length} written out`,
      ),
    );

  /* ── the site ────────────────────────────────────────────────────────── */

  const dir = acct.site?.artifact;
  if (!dir) {
    f.push(absent("site", "never rendered", "kitchen_site to build it"));
  } else if (!existsSync(dir)) {
    f.push(
      broken(
        "site",
        `artifact directory is recorded but missing: ${dir}`,
        "kitchen_site to re-render, or clear the stale path",
      ),
    );
  } else if (!existsSync(join(dir, "index.html"))) {
    f.push(broken("site", `${dir} exists but has no index.html`, "kitchen_site to re-render"));
  } else if (!acct.site?.url) {
    // The one that hid for a week: rendered perfectly, served to nobody.
    f.push(
      broken(
        "site",
        "rendered, but no public URL is recorded, so nobody can open it and no button on " +
          "it can reach anything",
        "share the artifact directory, then record the URL with kitchen_site url:...",
      ),
    );
  } else {
    f.push(ok("site", `${acct.site.url}`));
    const missing = book.filter((b) => !existsSync(join(dir, "recipe", `${b.id}.html`)));
    if (missing.length) {
      f.push(
        broken(
          "recipe pages",
          `${missing.length} written recipe(s) have no page on disk: ${missing.map((m) => m.id).join(", ")}`,
          "kitchen_site re-renders every page in one go",
        ),
      );
    }
  }

  // Taps only reach anybody if something is watching the callback log. This
  // module cannot see the trigger table, so it reports the precondition rather
  // than claiming the trigger exists.
  if (dir && existsSync(join(dir, "_callbacks.jsonl"))) {
    f.push(ok("taps", "the page has posted at least once, so the callback path works"));
  } else if (dir && acct.site?.url) {
    f.push(
      absent(
        "taps",
        "nothing has ever been pressed on this site",
        "expected for a new site; if it is not new, check the trigger watching /callbacks",
      ),
    );
  }

  /* ── standing texts ──────────────────────────────────────────────────── */

  const dinners = dinnersOf(acct);
  if (!dinners.length) {
    f.push(absent("standing texts", "none set", "kitchen_schedule action:set"));
  } else {
    for (const d of dinners) {
      const who = recipients(d, acct);
      if (!who.length) {
        f.push(
          broken(
            "standing text",
            `${d.id} at ${d.at} has no recipient who still lives here`,
            "kitchen_schedule action:set to fix the list, or action:remove",
          ),
        );
      } else if (d.on && !nextFire(d)) {
        f.push(
          broken(
            "standing text",
            `${d.id} is on but has no day it can fire on`,
            "kitchen_schedule action:set with at least one weekday",
          ),
        );
      } else {
        f.push(
          ok(
            "standing text",
            `${d.id} ${d.at} to ${who.map((w) => w.label).join(" and ")}${d.on ? "" : " (paused)"}`,
          ),
        );
      }
    }
  }

  /* ── the optional signals ────────────────────────────────────────────── */

  if (!acct.place) {
    f.push(
      absent(
        "weather",
        "no coordinates, so the page never mentions weather",
        "set place on the account; there is deliberately no default coordinate",
      ),
    );
  } else if (!readWeather(id)) {
    f.push(
      absent(
        "weather",
        "coordinates set but no reading cached in the last 12 hours",
        "the minute pass refreshes it; a persistent gap means NWS is unreachable",
      ),
    );
  } else f.push(ok("weather", `${acct.place.label ?? "coordinates set"}, reading is current`));

  const list = readList(id).entries.length;
  f.push(list ? ok("shopping list", `${list} line(s)`) : absent("shopping list", "empty"));

  return { account: id, title: acct.name, findings: f };
}

/** One line per finding, worst first, for a log or a tool result. */
export function format(r: Report): string {
  const rank: Record<Level, number> = { broken: 0, absent: 1, ok: 2 };
  const rows = r.findings.slice().sort((a, b) => rank[a.level] - rank[b.level]);
  const tag: Record<Level, string> = { broken: "BROKEN", absent: "absent", ok: "ok" };
  return rows
    .map(
      (x) =>
        `  ${tag[x.level].padEnd(6)} ${x.what}: ${x.detail}${x.fix ? `\n           -> ${x.fix}` : ""}`,
    )
    .join("\n");
}

export function summarise(r: Report): string {
  const n = (l: Level) => r.findings.filter((x) => x.level === l).length;
  return `${r.account}: ${n("broken")} broken, ${n("absent")} absent, ${n("ok")} ok`;
}

export function checkAll(): Report[] {
  return listAccounts().map((a) => checkAccount(a.id));
}

export type { Account };
