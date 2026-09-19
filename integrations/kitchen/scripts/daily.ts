/**
 * The daily pass. One per household, unattended.
 *
 * This exists because of how tracking tools actually die. People use them hard
 * for a week or two and then stop, not because the tool got worse but because
 * keeping it current became a chore, and the moment it falls behind reality it
 * stops being worth opening — which makes it fall further behind. The research
 * calls that lapsing, and it is the normal shape of the curve rather than a
 * defect in the user: a 12-week MyFitnessPal trial saw consistent logging go
 * from 68% in week one to 21% by week twelve.
 *
 * So the design rule is that this kitchen must never need attention to stay
 * true, and must never punish a gap. Three things happen here, all silent:
 *
 *   1. Food that has obviously left the house is retired, so the stock list
 *      keeps describing the fridge even when nobody logs anything for a week.
 *
 *   2. Meal ideas built on food that is gone are dropped, and I am woken to
 *      write ideas built on what is actually in the kitchen this morning in
 *      their place. Without this the site spends month two recommending
 *      dinners from week one's shopping, which is the single most obvious way
 *      it would go stale. The writing is mine and not a sub-model's, which is
 *      why it is a wake-up rather than a call: see `wake.ts`.
 *
 *   3. The site is re-rendered, so opening the link after two weeks away shows
 *      today rather than the day you stopped.
 *
 * Nothing here messages anyone. A daily "here is what I cleaned up" notification
 * would recreate the exact burden it is meant to remove.
 */

import { existsSync } from "node:fs";
import { getAccount, householdTitle, listAccounts } from "../src/accounts.ts";
import { sweepStale } from "../src/decay.ts";
import { checkAccount } from "../src/doctor.ts";
import { pruneIdeas } from "../src/ideas.ts";
import { photographMissing } from "../src/photos.ts";
import { cookable, loadRecipes } from "../src/recipes.ts";
import { loadKitchenSettings } from "../src/settings.ts";
import { writeSite } from "../src/site.ts";
import { live } from "../src/store.ts";
import { wakeForIdeas } from "../src/wake.ts";

async function runAccount(id: string): Promise<void> {
  const acct = getAccount(id);
  if (!acct) return;
  console.log(`\n=== ${id} (${householdTitle(acct)})`);

  // 1. Retire what has obviously gone.
  const swept = sweepStale(id);
  if (swept.removed.length) {
    console.log(`  swept ${swept.removed.length} in batch ${swept.batch}:`);
    for (const r of swept.removed) console.log(`    ${r.id} — ${r.reason}`);
  } else {
    console.log("  swept nothing");
  }

  // 2. Retire the household's own ideas that the kitchen has moved past, and
  //    ask for replacements. The asking is a wake-up in a member's chat with
  //    the exact brief, not a model call from here: which ten dinners suit
  //    this house this week is the one question in this pass that needs to
  //    know the people, and the pass does not.
  const items = live(id);
  const have = new Set(items.map((i) => i.id));
  const pruned = pruneIdeas(id, items);
  for (const d of pruned.dropped) console.log(`  drop ${d.id}: ${d.why}`);
  if (pruned.want > 0 && have.size > 8) {
    const w = wakeForIdeas(id, acct, pruned.want);
    for (const x of w.woke)
      console.log(`  woke ${x.session} for ${pruned.want} idea(s), job ${x.job}`);
    for (const h of w.held) console.log(`  ideas not asked for: ${h.why}`);
  }

  // 3. Re-render, so the link shows today.
  const dir = acct.site?.artifact;
  if (dir && existsSync(dir)) {
    // Photograph anything on the site that has no picture, before the render.
    const shots = await photographMissing(id, dir, { log: (l) => console.log(`  ${l}`) });
    if (shots.left) console.log(`  ${shots.left} still without a photo`);

    const { html, pages } = writeSite(id, acct, dir);
    if (pages) console.log(`  ${pages} recipe page(s)`);
    const c = cookable(Object.fromEntries(items.map((i) => [i.id, i])), loadRecipes(id).recipes);
    console.log(`  rendered ${dir}: ${c.filter((x) => x.ready).length}/${c.length} cookable`);

    // Confirm the render landed where the household actually looks.
    //
    // The registry pointed at a directory that no server had ever served, so
    // this pass wrote a perfectly correct site into a folder nobody could see
    // while the real page sat frozen. That failure is invisible by construction
    // — everything reports success — and it is precisely the failure that makes
    // a tool go stale, so it gets checked rather than assumed.
    const url = acct.site?.url;
    if (url) {
      try {
        const res = await fetch(url, { redirect: "follow" });
        const body = await res.text();
        if (!res.ok) console.error(`  WARNING: ${url} returned ${res.status}`);
        else if (Math.abs(body.length - html.length) > 2048) {
          console.error(
            `  WARNING: live page is ${body.length}b but we just wrote ${html.length}b — site.artifact probably points somewhere that is not being served`,
          );
        } else console.log("  verified live");
      } catch (e) {
        console.error(`  WARNING: could not reach ${url}: ${(e as Error).message}`);
      }
    }
  } else {
    console.log("  no site artifact, skipped render");
  }

  // 4. Say out loud what is wired up and what is not.
  //
  // The rest of this pass is deliberately silent, and that silence is exactly
  // what let a household sit for a week with a perfect site nobody could open.
  // Only real breakage is printed; "absent" states are normal and are the
  // doctor's job to report on demand, not this pass's job to nag about.
  const rep = checkAccount(id);
  const bad = rep.findings.filter((x) => x.level === "broken");
  if (bad.length) {
    console.error(`  ${bad.length} thing(s) BROKEN on this household:`);
    for (const b of bad) console.error(`    ${b.what}: ${b.detail}\n      -> ${b.fix}`);
  } else console.log("  health: nothing broken");
}

loadKitchenSettings();

const only = process.argv[2];
for (const id of only ? [only] : listAccounts().map((a) => a.id)) {
  try {
    await runAccount(id);
  } catch (e) {
    // One household's bad day must not stop the others'.
    console.error(`  ${id} FAILED: ${(e as Error).message}`);
  }
}
