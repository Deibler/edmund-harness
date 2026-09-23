/**
 * Household health check: which parts are broken, which are merely absent,
 * and which are fine.
 *
 * Every feature degrades quietly by design, which is right for the person
 * reading the page and wrong for whoever set it up: "no shopping list" and "a
 * site nobody has ever been served" look the same from outside. This module
 * reads the same state as everything else, changes nothing, and reports:
 *
 *   broken  something claims to work and does not
 *   absent  a valid state that costs a feature; never reported as an error
 *   ok      checked and true
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
 * Everything checkable about one household without the network. Cheap enough
 * for every daily pass; the daily script checks the live URL separately.
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
    // Group chats only: nothing can be texted to a person.
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
        "ask for ideas in chat (kitchen_ideas) or tap Make or Explore on the site",
      ),
    );
  } else if (!ready) {
    f.push(
      absent(
        "meals",
        `${recipes.length} dishes known, none cookable from current stock`,
        "normal for a bare kitchen; ideas written in chat or from the site use what is actually there",
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
    // Rendered but served to nobody: the failure that looks like success.
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

  // Reports only the precondition for taps working; the watcher itself is not
  // visible from here.
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
