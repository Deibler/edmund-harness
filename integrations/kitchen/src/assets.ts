/**
 * Which pictures exist on disk next to the rendered page.
 *
 * The site never emits an `<img>` for a file it has not seen: a missing photo
 * gets a deliberate typographic placeholder instead of a broken image.
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
