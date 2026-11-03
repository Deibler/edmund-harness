import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type PortalPageData,
  ideasTab,
  shownTabIds,
} from "../dashboard/server/views/portalPage.ts";
import { tabsFor } from "../dashboard/user-web/src/tabs.ts";
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

describe("which tabs a page shows", () => {
  const ideas = (n: number) => ({
    threads: [],
    pages: Array.from({ length: n }, (_, i) => ({
      title: `Page ${i}`,
      pitch: "",
      thread: "",
      url: `https://pages.example.com/i/${i}/`,
      thumbUrl: "",
      readyMs: 1,
      days: 3,
    })),
  });
  const shown = (d: Parameters<typeof tabsFor>[0]) => tabsFor(d).map((t) => t.id);

  test("Made for you appears once a page exists, and never in a group", () => {
    expect(shown({ isGroup: false, credits: null, ideas: ideas(0) })).not.toContain("ideas");
    expect(shown({ isGroup: false, credits: null, ideas: ideas(1) })).toContain("ideas");
    expect(shown({ isGroup: true, credits: null, ideas: ideas(1) })).not.toContain("ideas");
  });

  test("the server-rendered fallback page follows the same rule", () => {
    const fallback = (isGroup: boolean, n: number) =>
      shownTabIds({ isGroup, credits: null, ideas: ideas(n) } as unknown as PortalPageData);
    expect(fallback(false, 0)).not.toContain("ideas");
    expect(fallback(false, 1)).toContain("ideas");
    expect(fallback(true, 1)).not.toContain("ideas");
    expect(fallback(false, 0)).not.toContain("credits");
  });

  test("the fallback page's section escapes what a model wrote and opens pages without a referrer", () => {
    const d = {
      tz: "America/New_York",
      ideas: {
        threads: [{ label: "night <sky>", days: 4, lastSeenMs: 1 }],
        pages: [
          {
            ...ideas(1).pages[0],
            title: 'Sunset <img src=x onerror="alert(1)">',
            pitch: "A & B",
            thread: "sky",
            readyMs: Date.UTC(2026, 10, 3, 15),
          },
        ],
      },
    } as unknown as PortalPageData;
    const html = ideasTab(d);
    expect(html).not.toContain("<img");
    expect(html).toContain("Sunset &lt;img");
    expect(html).toContain("A &amp; B");
    expect(html).toContain("night &lt;sky&gt;");
    expect(html).toContain(
      'href="https://pages.example.com/i/0/" target="_blank" rel="noreferrer"',
    );
    expect(html).toContain("4 days");
  });

  test("page data from an older server, without ideas, hides the tab instead of failing", () => {
    const old = { isGroup: false, credits: null } as Parameters<typeof tabsFor>[0];
    expect(shown(old)).not.toContain("ideas");
    expect(shown(old)).toContain("home");
  });
});
