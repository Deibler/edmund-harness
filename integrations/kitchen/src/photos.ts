/**
 * Generated photographs for dishes that have none.
 *
 * A card without a picture looks broken in a grid of photographed ones, so
 * missing photos are generated in a consistent style. This is presentation,
 * not judgement: the dish itself was written in the household's session.
 * Cookable dishes go first, and each run is capped so a growing catalog fills
 * in over a few days.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openrouterKey } from "./openrouter.ts";
import { type Recipe, cookable, loadRecipes } from "./recipes.ts";
import { live } from "./store.ts";

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

/** Where a dish's picture lives, relative to the artifact root. */
function photoPath(dir: string, recipeId: string): string {
  return join(dir, "img", "meals", `${recipeId}.jpg`);
}

/** Photograph up to `cap` dishes that have no picture yet, most cookable first. */
export async function photographMissing(
  account: string,
  dir: string,
  opts: { cap?: number; log?: (line: string) => void; shoot?: typeof makePhoto } = {},
): Promise<{ shot: string[]; failed: string[]; left: number }> {
  const cap = opts.cap ?? 12;
  const log = opts.log ?? (() => {});
  const shoot = opts.shoot ?? makePhoto;
  const stock = Object.fromEntries(live(account).map((i) => [i.id, i]));
  const ranked = cookable(stock, loadRecipes(account).recipes).sort(
    (a, b) => Number(b.ready) - Number(a.ready) || a.missing.length - b.missing.length,
  );
  const want = ranked.filter((c) => !existsSync(photoPath(dir, c.recipe.id)));
  if (want.length) log(`${want.length} dish(es) without a photo`);
  const shot: string[] = [];
  const failed: string[] = [];
  for (const c of want) {
    if (shot.length >= cap) {
      log(`stopping at ${cap} photos, the rest tomorrow`);
      break;
    }
    try {
      if (await shoot(c.recipe, photoPath(dir, c.recipe.id))) {
        shot.push(c.recipe.id);
        log(`photo ${c.recipe.id}`);
      } else {
        failed.push(c.recipe.id);
        log(`photo failed ${c.recipe.id}`);
      }
    } catch (e) {
      failed.push(c.recipe.id);
      log(`photo failed ${c.recipe.id}: ${(e as Error).message}`);
    }
  }
  return { shot, failed, left: want.length - shot.length - failed.length };
}
