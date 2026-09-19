/**
 * Photograph whatever on a household's site has no picture, then re-render.
 *
 * Spawned detached by `kitchen_ideas save`, because a tool call must not sit
 * on image generation: the ideas are on the page the moment they are saved,
 * and the pictures arrive a minute later. The morning pass does the same work
 * inline. Usage: `bun integrations/kitchen/scripts/photos.ts <account>`.
 */

import { existsSync } from "node:fs";
import { getAccount } from "../src/accounts.ts";
import { photographMissing } from "../src/photos.ts";
import { loadKitchenSettings } from "../src/settings.ts";
import { writeSite } from "../src/site.ts";

loadKitchenSettings();

const id = process.argv[2];
if (!id) {
  console.error("usage: photos.ts <account>");
  process.exit(2);
}
const acct = getAccount(id);
const dir = acct?.site?.artifact;
if (!acct || !dir || !existsSync(dir)) {
  console.error(`${id}: no site artifact to photograph for`);
  process.exit(1);
}
const res = await photographMissing(id, dir, { log: (l) => console.log(`  ${l}`) });
if (res.shot.length) {
  const { pages } = writeSite(id, acct, dir);
  console.log(`re-rendered ${dir} (${pages} recipe pages)`);
}
console.log(`${res.shot.length} shot, ${res.failed.length} failed, ${res.left} left for next time`);
