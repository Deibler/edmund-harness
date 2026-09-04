/**
 * Which pictures actually exist on disk next to the rendered page.
 *
 * The site never emits an `<img>` for a file it has not seen. A broken image
 * icon in a product grid reads as a broken site, and a grid where three tiles
 * out of a hundred silently fail looks worse than one that draws a deliberate
 * typographic placeholder for the ones it does not have. Same principle as the
 * rest of this integration: show what is known, say so when something isn't.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type Assets = {
  /** Ledger slugs with a photo at img/items/<id>.jpg */
  items: Set<string>;
  /** Recipe ids with a photo at img/meals/<id>.jpg */
  meals: Set<string>;
};

const jpgIds = (dir: string): Set<string> => {
  if (!existsSync(dir)) return new Set();
  try {
    return new Set(
      readdirSync(dir)
        .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
        .map((f) => f.replace(/\.(jpe?g|png|webp)$/i, "")),
    );
  } catch {
    return new Set();
  }
};

export function scanAssets(dir: string): Assets {
  return {
    items: jpgIds(join(dir, "img", "items")),
    meals: jpgIds(join(dir, "img", "meals")),
  };
}

export const noAssets = (): Assets => ({ items: new Set(), meals: new Set() });
