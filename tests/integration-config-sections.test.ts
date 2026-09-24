/**
 * Every integration's `config.toml` table must survive the core parse.
 *
 * An integration reads its table with `defineSection`, from the parsed Config.
 * The core schema strips keys it does not declare, so a table without its own
 * opaque entry there is silently replaced by defaults: `[kitchen]` was, from
 * the day it was written until 2026-09-24, and none of its settings ever took
 * effect.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/config.ts";

const ROOT = join(import.meta.dir, "..");
const sections = readdirSync(join(ROOT, "integrations"))
  .map((dir) => join(ROOT, "integrations", dir, "config.ts"))
  .filter((f) => existsSync(f))
  .flatMap((f) =>
    [...readFileSync(f, "utf8").matchAll(/defineSection\("([a-z_-]+)"/g)].map((m) => m[1]!),
  );

test("the integrations declare sections at all", () => {
  expect(sections).toContain("kitchen");
  expect(sections.length).toBeGreaterThanOrEqual(5);
});

for (const name of sections) {
  test(`[${name}] reaches its integration`, () => {
    const parsed = ConfigSchema.parse({
      self: { handles: [] },
      allowlist: { dm: [], groups: [] },
      identity: {},
      [name]: { probe: 1 },
    }) as unknown as Record<string, unknown>;
    expect(parsed[name]).toEqual({ probe: 1 });
  });
}
