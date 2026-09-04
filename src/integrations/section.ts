/**
 * `defineSection` — the one place an integration's `config.toml` table is read.
 *
 * Core keeps every integration section (`[trading]`, `[mirror]`, …) as an
 * opaque value: the schema belongs to the package, not to `src/config/config.ts`,
 * which is what lets a package be deleted without touching a core type. Each
 * package therefore needs its own "parse my table" accessor — and all five were
 * the same 24 lines with a different noun, which is exactly the kind of
 * duplication that drifts (one gets a bug fix, four don't).
 *
 * ```ts
 * export const Schema = z.object({ enabled: z.boolean().default(false) }).default({});
 * export type FishingConfig = z.infer<typeof Schema>;
 * export const fishingConfig = defineSection("fishing", Schema);
 * ```
 */

import type { z } from "zod";
import type { Config } from "../config/config.ts";
import { log } from "../util/log.ts";

/**
 * Build a memoized accessor for one integration's config table.
 *
 * @param key    the `config.toml` table name, e.g. "trading" for `[trading]`
 * @param schema the package's zod schema; must tolerate `undefined` (give the
 *               top-level object a `.default({})`) so a missing table yields
 *               defaults instead of throwing
 */
export function defineSection<S extends z.ZodType>(
  key: string,
  schema: S,
): (config: Config) => z.infer<S> {
  // Keyed on the Config object identity, so a long-lived daemon parses each
  // table once instead of on every hot-path read.
  const memo = new WeakMap<object, z.infer<S>>();

  return function readSection(config: Config): z.infer<S> {
    const cacheKey = config as unknown as object;
    const cached = memo.get(cacheKey);
    if (cached !== undefined) return cached;

    const raw = (config as unknown as Record<string, unknown>)[key];
    const parsed = schema.safeParse(raw ?? undefined);

    let value: z.infer<S>;
    if (parsed.success) {
      value = parsed.data;
    } else {
      // A bad field must not silently reset every OTHER field to its default —
      // that turns one typo into a whole section of surprise behavior. Layer
      // whatever the operator actually wrote over the schema defaults, and say
      // so out loud rather than failing the boot.
      value = {
        ...(schema.parse(undefined) as object),
        ...(raw && typeof raw === "object" ? raw : {}),
      } as z.infer<S>;
      log.warn("integrations", `[${key}] config failed validation — using defaults where invalid`, {
        issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      });
    }

    memo.set(cacheKey, value);
    return value;
  };
}
