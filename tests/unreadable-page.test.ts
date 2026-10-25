import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unreadablePageText } from "../src/mcp/tools/web.ts";
import { looksBlocked, renderInBrowser } from "../src/web/fetch.ts";

describe("a wall is not the page", () => {
  test("block-page titles seen on real sites read as blocked", () => {
    // Titles headless Chrome got back on 2026-10-25.
    expect(looksBlocked("Blocked - Indeed.com", "")).toBe(true);
    expect(looksBlocked("Error Page | eBay", "")).toBe(true);
    expect(looksBlocked("Just a moment...", "")).toBe(true);
    expect(looksBlocked("Access Denied", "")).toBe(true);
  });

  test("a real page is not blocked", () => {
    expect(looksBlocked("Microwaves - The Home Depot", "x".repeat(5000))).toBe(false);
    expect(looksBlocked("How to graft an apple tree", "Grafting joins a scion to rootstock.")).toBe(
      false,
    );
  });

  test("a short challenge body with no telling title is blocked", () => {
    expect(looksBlocked(null, "Please enable JavaScript and cookies to continue")).toBe(true);
  });

  test("no Chrome means no fallback, not a crash", async () => {
    expect(await renderInBrowser("https://example.com", { chromeBin: "/nonexistent/chrome" })).toBe(
      null,
    );
  });
});

describe("the model is told it has not seen an unreadable page", () => {
  test("the failure text forbids filling the gap from the title", () => {
    const text = unreadablePageText("https://example.com/item/1", "HTTP 403");
    expect(text).toStartWith("COULD NOT READ https://example.com/item/1 (HTTP 403).");
    expect(text).toContain("You have not seen this page.");
    expect(text).toContain("do not fill them in from a title or search snippet");
  });

  test("web_fetch uses it for every non-security failure", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/mcp/tools/web.ts"), "utf8");
    expect(src).toContain("unreadablePageText(args.url, msg)");
    expect(src).not.toContain("`Fetch failed: ${msg}`");
  });

  test("the reply-path prefetch never waits on a browser and says when it could not read", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/web/link-prefetch.ts"), "utf8");
    expect(src).toContain("browserFallback: false");
    expect(src).toContain("You have not seen it");
  });
});
