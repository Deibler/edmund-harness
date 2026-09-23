/**
 * The daily pass, one run per household, unattended
 * (`com.edmund-harness.kitchen-daily`). Keeps the kitchen current without
 * asking anyone for anything:
 *
 *   1. Leftovers nobody logged eating are retired.
 *   2. The inventory is reviewed (`review.ts`): suspicions that waited long
 *      enough are settled, and uncertain items go to the household's session.
 *   3. Ideas built on food that is gone are retired.
 *   4. Missing dish photos are generated and the site is re-rendered.
 *   5. Real breakage is reported.
 *
 * Nothing here messages anyone. Usage: `bun scripts/daily.ts [account]`.
 */

import { existsSync } from "node:fs";
import { getAccount, householdTitle, listAccounts } from "../src/accounts.ts";
import { sweepStale } from "../src/decay.ts";
import { checkAccount } from "../src/doctor.ts";
import { pruneIdeas } from "../src/ideas.ts";
import { photographMissing } from "../src/photos.ts";
import { cookable, loadRecipes } from "../src/recipes.ts";
import { morningReview } from "../src/review.ts";
import { loadKitchenSettings } from "../src/settings.ts";
import { writeSite } from "../src/site.ts";
import { live } from "../src/store.ts";

async function runAccount(id: string): Promise<void> {
  const acct = getAccount(id);
  if (!acct) return;
  console.log(`\n=== ${id} (${householdTitle(acct)})`);

  // 1. Retire leftovers nobody logged eating.
  const swept = sweepStale(id);
  if (swept.removed.length) {
    console.log(`  swept ${swept.removed.length} in batch ${swept.batch}:`);
    for (const r of swept.removed) console.log(`    ${r.id} — ${r.reason}`);
  } else {
    console.log("  swept nothing");
  }

  // 2. Review the inventory.
  const review = morningReview(id, acct);
  for (const a of review.settled.assumed) console.log(`  assumed ${a.verdict}: ${a.id}`);
  if (review.settled.dropped.length)
    console.log(`  suspicions withdrawn: ${review.settled.dropped.join(", ")}`);
  if (review.held.length) console.log(`  held for follow-up: ${review.held.join(", ")}`);
  for (const x of review.wake?.woke ?? [])
    console.log(`  woke ${x.session} to review ${review.reviewed.length} item(s), job ${x.job}`);
  for (const h of review.wake?.held ?? []) console.log(`  review not asked for: ${h.why}`);

  // 3. Retire ideas built on food that is gone.
  const items = live(id);
  for (const d of pruneIdeas(id, items).dropped) console.log(`  drop ${d.id}: ${d.why}`);

  // 4. Re-render, so the link shows today.
  const dir = acct.site?.artifact;
  if (dir && existsSync(dir)) {
    const shots = await photographMissing(id, dir, { log: (l) => console.log(`  ${l}`) });
    if (shots.left) console.log(`  ${shots.left} still without a photo`);

    const { html, pages } = writeSite(id, acct, dir);
    if (pages) console.log(`  ${pages} recipe page(s)`);
    const c = cookable(Object.fromEntries(items.map((i) => [i.id, i])), loadRecipes(id).recipes);
    console.log(`  rendered ${dir}: ${c.filter((x) => x.ready).length}/${c.length} cookable`);

    // Confirm the render is what the live URL serves. A registry pointing at a
    // directory nobody serves reports success while the real page goes stale.
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

  // 5. Report real breakage. Absent optional pieces are normal and left to the
  // doctor to report on demand.
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
    // One household's failure must not stop the others.
    console.error(`  ${id} FAILED: ${(e as Error).message}`);
  }
}
