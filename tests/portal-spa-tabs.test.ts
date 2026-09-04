import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PORTAL_TABS } from "../src/announce/links.ts";

/**
 * Announcements may deep-link to a portal tab (#credits, #skills…). The
 * React portal owns the tab list and the daemon must not import it, so the
 * two are pinned here the same way the server-rendered page's TAB_DEFS are.
 */
describe("react portal tabs", () => {
  test("match the announcement deep-link allowlist exactly", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "dashboard", "user-web", "src", "tabs.ts"),
      "utf8",
    );
    const block = src.slice(
      src.indexOf("export const TABS"),
      src.indexOf("export function visibleTabs"),
    );
    const ids = [...block.matchAll(/id:\s*"([a-z]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect([...ids].sort()).toEqual([...PORTAL_TABS].sort());
  });
});
