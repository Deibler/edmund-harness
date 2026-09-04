/**
 * The loop that makes buttons feel like buttons.
 *
 * Runs every ten seconds under launchd (`com.edmund-harness.kitchen-watch`),
 * drains whatever the site's callback log has collected for every household,
 * and re-renders any page whose state actually changed. A tap resolves in
 * seconds with nobody in the loop.
 *
 * Why a poller rather than a trigger that wakes a session: the deterministic
 * answers here — a meal confirmed, a cleanup undone, a line ticked off — do not
 * improve for having a model think about them, and routing them through one
 * makes the cheapest interaction on the site the slowest. A model still gets
 * woken for the things that need writing; those are deliberately left in the
 * queue by `drain`.
 *
 * Re-rendering only on change matters: the render is a few hundred kilobytes,
 * this runs 8,640 times a day, and a page that rewrites itself every pass
 * would churn the disk to say nothing.
 */

import { existsSync } from "node:fs";
import { getAccount, listAccounts } from "../src/accounts.ts";
import { drain, publishQueue } from "../src/drain.ts";
import { syncDueNotes } from "../src/notesync.ts";
import { describe, due, fire } from "../src/schedules.ts";
import { loadKitchenSettings } from "../src/settings.ts";
import { writeSite } from "../src/site.ts";

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

/**
 * Standing dinner texts, fired from the same minute-by-minute pass.
 *
 * Here rather than in its own launchd job because the two need the same thing —
 * a loop that has already read every household this minute — and a second timer
 * is a second thing that can silently stop. Each schedule is isolated: one that
 * throws must not cost the others theirs.
 */
function fireDue(id: string): void {
  const acct = getAccount(id);
  if (!acct) return;
  for (const d of due(acct)) {
    try {
      const res = fire(id, d);
      const who = res.sent.length ? res.sent.join(", ") : "nobody";
      console.log(
        `${stamp()} ${id}: schedule ${d.id} (${describe(d, acct)}) fired -> ${res.picked ?? "nothing cookable"}, texted ${who}${res.queuedWrite ? ", asked for a written page" : ""}`,
      );
      for (const f of res.failed) {
        console.error(`${stamp()} ${id}: schedule ${d.id} could not text ${f.principal}: ${f.why}`);
      }
    } catch (e) {
      // Left unfired on purpose. The grace window means the next pass tries
      // again, which is the right behaviour for a transient send failure.
      console.error(`${stamp()} ${id}: schedule ${d.id} FAILED ${(e as Error).message}`);
    }
  }
}

// Same `[kitchen]` settings the MCP tools get. Without this a configured `dir`
// would apply to tools and not to the pass that answers taps, and the two would
// read different kitchens.
loadKitchenSettings();

for (const { id } of listAccounts()) {
  try {
    fireDue(id);
    const res = await drain(id);
    let trouble = res.failed.length ? res.failed.join("; ") : undefined;

    for (const line of res.done) console.log(`${stamp()} ${id}: ${line}`);
    for (const line of res.failed) console.error(`${stamp()} ${id}: FAILED ${line}`);

    // Only worth re-rendering if something was actually decided.
    if (res.done.length) {
      const acct = getAccount(id);
      const dir = acct?.site?.artifact;
      if (acct && dir && existsSync(dir)) {
        // Caught here rather than by the outer handler so that a render that
        // cannot run still publishes a queue saying so. Silently serving a
        // page that stopped updating is the worse failure.
        try {
          const { pages } = writeSite(id, acct, dir);
          console.log(`${stamp()} ${id}: re-rendered (${pages} recipe pages)`);
        } catch (e) {
          trouble = [trouble, `render: ${(e as Error).message}`].filter(Boolean).join("; ");
          console.error(`${stamp()} ${id}: FAILED render ${(e as Error).message}`);
        }
      }
    }

    // Last, and only on a pass that got this far: the stamp is what says the
    // loop is alive, so it must not be written by a pass that failed early.
    publishQueue(id, trouble);
  } catch (e) {
    // One household's bad minute must not stop the others'.
    console.error(`${stamp()} ${id}: FAILED ${(e as Error).message}`);
  }
}

/**
 * Keep the shared Apple Note equal to the list, for whoever needs it.
 *
 * After the per-household loop rather than inside it, and at most one household
 * per pass, because this is the only thing here that drives a browser: it costs
 * the better part of a minute where everything above costs milliseconds.
 * `syncDueNotes` decides with a pure fold whether there is anything to do, so
 * the overwhelmingly common case — the list has not changed since the last
 * pass — opens nothing and costs nothing.
 */
try {
  for (const r of await syncDueNotes()) {
    if (!r.ok) {
      console.error(`${stamp()} ${r.account}: FAILED note sync ${r.error}`);
      continue;
    }
    console.log(
      `${stamp()} ${r.account}: note "${r.title}" ${r.wrote ? "rewritten" : "already current"} (${r.lines} lines, via ${r.via})${r.ticked.length ? `, ${r.ticked.length} ticked off` : ""}${r.adopted.length ? `, adopted ${r.adopted.join(", ")}` : ""}${r.invited.length ? `, invited ${r.invited.join(", ")}` : ""}`,
    );
  }
} catch (e) {
  console.error(`${stamp()} FAILED note sync ${(e as Error).message}`);
}
