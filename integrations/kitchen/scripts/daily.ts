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
 *   2. Meal ideas built on food that is gone are dropped, and ideas built on
 *      what is actually in the kitchen this morning are written in their place.
 *      Without this the site spends month two recommending dinners from week
 *      one's shopping, which is the single most obvious way it would go stale.
 *
 *   3. The site is re-rendered, so opening the link after two weeks away shows
 *      today rather than the day you stopped.
 *
 * Nothing here messages anyone. A daily "here is what I cleaned up" notification
 * would recreate the exact burden it is meant to remove.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAccount, householdTitle, listAccounts } from "../src/accounts.ts";
import { sweepStale } from "../src/decay.ts";
import { checkAccount } from "../src/doctor.ts";
import { openrouterKey } from "../src/openrouter.ts";
import { type Recipe, cookable, loadRecipes, overlayPath } from "../src/recipes.ts";
import { loadKitchenSettings } from "../src/settings.ts";
import { writeSite } from "../src/site.ts";
import { daysLeft, live } from "../src/store.ts";
import type { Item } from "../src/types.ts";

const IDEAS_TARGET = 10;
/** An unmade idea is not worth keeping forever; the kitchen has moved on. */
const IDEA_MAX_AGE_DAYS = 21;

type Overlay = { recipes: Array<Recipe & { created?: string; origin?: string }> };

function readOverlay(account: string): Overlay {
  const p = overlayPath(account);
  if (!existsSync(p)) return { recipes: [] };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Overlay;
  } catch {
    return { recipes: [] };
  }
}

function writeOverlay(account: string, o: Overlay): void {
  const p = overlayPath(account);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(o, null, 2));
}

/**
 * Ask for dinners built strictly from what is on the shelves right now.
 *
 * The slug whitelist in the prompt is a courtesy, not the safeguard — the
 * returned recipes are validated against the ledger afterwards and anything
 * naming an unknown ingredient is thrown away. A model that invents "garlic
 * cloves" when the kitchen has "garlic powder" would otherwise produce a dish
 * that reads as cookable and is not, which is worse than proposing nothing.
 */
async function generateIdeas(
  account: string,
  items: Item[],
  have: Set<string>,
  existing: string[],
  n: number,
): Promise<Recipe[]> {
  const soon = items
    .filter((i) => {
      const d = daysLeft(i);
      return d !== null && d <= 6;
    })
    .sort((a, b) => (daysLeft(a) ?? 99) - (daysLeft(b) ?? 99))
    .map((i) => `${i.id} (${daysLeft(i)}d)`);

  const prompt = [
    "You are writing dinner and lunch ideas for one specific household.",
    "",
    "Use ONLY these ingredient slugs, exactly as written. Do not invent slugs, do not",
    "pluralise, do not substitute a similar word:",
    [...have].sort().join(", "),
    "",
    soon.length ? `Use these first, they expire soonest: ${soon.join(", ")}` : "",
    "",
    `Do NOT repeat any of these existing ideas: ${existing.join(", ")}`,
    "",
    `Return JSON: {"recipes":[{"id":"kebab-case","name":"","desc":"one sentence, plain,`,
    `no marketing","minutes":30,"cat":"dinner|lunch|side|dessert|snack","health":1-5,`,
    `"needs":[["slug",qty-or-null]]}]}`,
    "",
    `Write ${n}. A null qty means "some", correct for spices, oils and condiments.`,
    "Real cooking, no garnish-only dishes, and nothing that needs equipment beyond a",
    "stovetop, an oven and a sheet pan. This kitchen has no microwave.",
  ].join("\n");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openrouterKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4.5",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const parsed = JSON.parse(data.choices[0]!.message.content) as { recipes?: Recipe[] };
  const out: Recipe[] = [];
  for (const r of parsed.recipes ?? []) {
    if (!r?.id || !Array.isArray(r.needs)) continue;
    const unknown = r.needs.filter(([s]) => !have.has(s)).map(([s]) => s);
    if (unknown.length) {
      console.log(`    reject ${r.id}: unknown ${unknown.join(", ")}`);
      continue;
    }
    out.push(r);
  }
  return out;
}

/**
 * A hero shot for a dish that has just been invented.
 *
 * Without this the daily ideas arrive as text cards in a grid of photographed
 * ones, which looks broken rather than new — and the freshest, most relevant
 * suggestions would be the ugliest things on the page. Generated rather than
 * searched because a stock-photo hit for "beef penne skillet" is somebody's
 * phone snapshot under kitchen lights, and one bad photo in a consistent grid
 * costs more than no photo at all.
 */
const PHOTO_STYLE =
  "Overhead food photography, natural window light from the left, shallow depth of " +
  "field, on a warm neutral ceramic plate or bowl over a pale linen surface, " +
  "appetising and homemade rather than styled for a menu. No text, no hands, no " +
  "faces, no packaging, no logos.";

async function makePhoto(r: Recipe, dest: string): Promise<boolean> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openrouterKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-3-pro-image-preview",
      modalities: ["image", "text"],
      image_config: { aspect_ratio: "4:3" },
      messages: [{ role: "user", content: `${r.name}. ${r.desc} ${PHOTO_STYLE}` }],
    }),
  });
  if (!res.ok) return false;
  const data = (await res.json()) as {
    choices: Array<{ message: { images?: Array<{ image_url: { url: string } }> } }>;
  };
  const url = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) return false;
  const bytes = url.startsWith("data:")
    ? Buffer.from(url.split(",", 2)[1]!, "base64")
    : Buffer.from(await (await fetch(url)).arrayBuffer());
  // A truncated or error-page body would write a file that scanAssets counts as
  // a photo and the browser renders as a broken image.
  if (bytes.length < 8000) return false;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  return true;
}

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

  // 2. Refresh the household's own ideas against what is actually in stock.
  const items = live(id);
  const have = new Set(items.map((i) => i.id));
  const overlay = readOverlay(id);
  const cutoff = Date.now() - IDEA_MAX_AGE_DAYS * 86_400_000;

  const kept = overlay.recipes.filter((r) => {
    const missing = r.needs.filter(([s]) => !s.startsWith("leftover-") && !have.has(s));
    if (missing.length) {
      console.log(`  drop ${r.id}: no longer have ${missing.map(([s]) => s).join(", ")}`);
      return false;
    }
    if (r.created && new Date(r.created).getTime() < cutoff) {
      console.log(`  drop ${r.id}: ${IDEA_MAX_AGE_DAYS} days old and never made`);
      return false;
    }
    return true;
  });

  const want = IDEAS_TARGET - kept.length;
  if (want > 0 && have.size > 8) {
    const shared = loadRecipes().recipes.map((r) => r.name);
    try {
      const fresh = await generateIdeas(
        id,
        items,
        have,
        [...shared, ...kept.map((r) => r.name)],
        want,
      );
      const today = new Date().toISOString().slice(0, 10);
      for (const r of fresh) {
        kept.push({ ...r, created: today, origin: "daily" });
        console.log(`  new idea: ${r.name}`);
      }
    } catch (e) {
      // A bad day at the model must not cost the sweep or the render. The
      // kitchen is still more correct than it was five seconds ago.
      console.log(`  idea generation failed, keeping what we have: ${(e as Error).message}`);
    }
  }
  writeOverlay(id, { recipes: kept });

  // 3. Re-render, so the link shows today.
  const dir = acct.site?.artifact;
  if (dir && existsSync(dir)) {
    // Photograph anything on the site that has no picture, before the render.
    //
    // This used to shoot only dishes cookable RIGHT NOW, which was correct when
    // every card was an idea built from the shelves and became wrong the moment
    // the catalog deliberately included food you shop for: the slow-cooker
    // dinners, the weekend projects and the seasonal dishes are short by
    // definition, so under the old rule not one of them could ever get a
    // portrait. The result was that the newest, most interesting shelves were
    // the only ones rendering as bare text in a grid of photographs, which
    // reads as a broken page rather than as a page with something new on it.
    //
    // Cookable still goes first, because that is what somebody is most likely
    // to open tonight. The cap is per run, not per dish, so a catalog that
    // grows by eight fills in over a few days instead of spending an hour of
    // image generation in one pass.
    const stockNow = Object.fromEntries(items.map((i) => [i.id, i]));
    const everything = [
      ...loadRecipes(id).recipes,
      ...kept.filter((k) => !loadRecipes(id).recipes.some((r) => r.id === k.id)),
    ];
    const ranked = cookable(stockNow, everything).sort(
      (a, b) => Number(b.ready) - Number(a.ready) || a.missing.length - b.missing.length,
    );
    let shot = 0;
    const want = ranked.filter((c) => !existsSync(join(dir, "img", "meals", `${c.recipe.id}.jpg`)));
    if (want.length) console.log(`  ${want.length} dish(es) without a photo`);
    for (const c of want) {
      if (shot >= 12) {
        console.log(`  stopping at ${shot} photos, the rest tomorrow`);
        break;
      }
      const dest = join(dir, "img", "meals", `${c.recipe.id}.jpg`);
      try {
        if (await makePhoto(c.recipe, dest)) {
          shot++;
          console.log(`  photo ${c.recipe.id}`);
        } else console.log(`  photo failed ${c.recipe.id}`);
      } catch (e) {
        console.log(`  photo failed ${c.recipe.id}: ${(e as Error).message}`);
      }
    }

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
