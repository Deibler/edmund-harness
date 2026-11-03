import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PageChecker, findEmoji, staticProblems } from "../src/ideation/page-check.ts";

/**
 * One good page and one page per defect, each differing from the good one in
 * a single way, so each failure is for its own reason. The good page renders
 * its text from a script, which also proves scripts run under the sandbox.
 */
const PROSE =
  "Sunset from the harbor faces west-southwest over the water. In early November the sun sets near 248 degrees, so the open water lines up with it. Drag the date to see how the angle moves through the year and which of the spots faces it best.";

function page(
  opts: { style?: string; body?: string; script?: string; head?: string } = {},
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sunset Compass</title>${opts.head ?? ""}
<style>body{font-family:-apple-system,sans-serif;margin:0;padding:20px}
.row{border-bottom:1px solid #ddd;padding:8px 0}.box{border:2px solid #333;padding:8px}${opts.style ?? ""}</style>
</head><body><main id="m"><h1>Sunset Compass</h1>
<div class="row">Harbor → 248° ↔ the water</div><div class="box">A framed box with every side drawn.</div>
${opts.body ?? ""}<p>© 2026 Made by Edmund for Sam.</p></main>
<script>document.getElementById("m").insertAdjacentHTML("beforeend", "<p>${PROSE}</p>");${opts.script ?? ""}</script>
</body></html>`;
}

/** Pixel height from a JPEG's start-of-frame header. */
function jpegHeight(jpeg: Buffer): number {
  for (let i = 2; i < jpeg.length - 8; ) {
    if (jpeg[i] !== 0xff) return -1;
    const marker = jpeg[i + 1] as number;
    if (marker >= 0xc0 && marker <= 0xc3) return jpeg.readUInt16BE(i + 5);
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  return -1;
}

describe("staticProblems", () => {
  test("a built page within the limits has none", () => {
    expect(staticProblems(page())).toEqual([]);
  });
  test("over 3 MB is refused", () => {
    expect(staticProblems(page({ body: `<p>${"x".repeat(3_200_000)}</p>` }))[0]).toContain("3 MB");
  });
  test("a script from another site is refused", () => {
    const p = staticProblems(
      page({ head: '<script src="https://cdn.example.com/lib.js"></script>' }),
    );
    expect(p[0]).toContain("bundle the library");
  });
});

describe("findEmoji", () => {
  test("finds emoji, but not arrows, degrees or the copyright sign", () => {
    expect(findEmoji("Bass on the bend 🎣")).toBe("🎣");
    expect(findEmoji("Sunny ☀️ today")).toBe("☀️");
    expect(findEmoji("Harbor → 248° ↔ © ★ ™")).toBeNull();
  });
});

describe.skipIf(!PageChecker.available())("PageChecker, in headless Chrome", () => {
  let checker: PageChecker;
  // Launching Chrome can take well past the default 5 s hook limit on a
  // cold CI runner (it did on the first run in CI).
  beforeAll(async () => {
    checker = await PageChecker.launch();
  }, 60_000);
  afterAll(async () => {
    await checker?.close();
  });
  const check = (html: string) => checker.check(html, { settleMs: 400 });

  test("the good page passes and leaves a screenshot", async () => {
    const r = await check(page());
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.screenshot?.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // a JPEG
  }, 20_000);

  test("allScreens pictures the whole page, one phone screen at a time", async () => {
    // Three bands of colour, each taller than a screen, so the pictures differ.
    const tall = page({
      style: ".band{height:700px}",
      body: '<div class="band" style="background:#e8e2d6"></div><div class="band" style="background:#203040"></div><div class="band" style="background:#7a2f1d"></div>',
    });
    const r = await checker.check(tall, { settleMs: 400, allScreens: true });
    expect(r.ok).toBe(true);
    const height = r.pageHeight ?? 0;
    expect(height).toBeGreaterThan(2 * 844);
    expect(height).toBeLessThanOrEqual(3 * 844);
    expect(r.screens).toHaveLength(3);
    const heights = r.screens.map(jpegHeight);
    expect(heights).toEqual([844, 844, height - 2 * 844]);
    expect(new Set(r.screens.map((s) => s.toString("base64"))).size).toBe(3);

    const plain = await check(tall);
    expect(plain.screens).toEqual([]);
  }, 20_000);

  test("an uncaught error fails it", async () => {
    const r = await check(page({ script: "throw new Error('spot list missing');" }));
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("spot list missing");
  }, 20_000);

  test("a blank render fails it", async () => {
    const r = await check(page({ script: "document.body.innerHTML = '<p>Loading</p>';" }));
    expect(r.problems.join("\n")).toContain("characters of text");
  }, 20_000);

  test("sideways scrolling on a phone fails it", async () => {
    const r = await check(page({ body: '<div style="width:800px">A wide table</div>' }));
    expect(r.problems.join("\n")).toContain("scrolls sideways");
  }, 20_000);

  test("a left accent border fails it", async () => {
    const r = await check(
      page({ body: '<div style="border-left:4px solid #c2410c;padding-left:12px">Tip</div>' }),
    );
    expect(r.problems.join("\n")).toContain("left accent border");
  }, 20_000);

  test("gradient text fails it", async () => {
    const r = await check(
      page({
        style:
          "h2{background:linear-gradient(90deg,#7c3aed,#2563eb);-webkit-background-clip:text;background-clip:text;color:transparent}",
        body: "<h2>Your journey</h2>",
      }),
    );
    expect(r.problems.join("\n")).toContain("gradient text");
  }, 20_000);

  test("an emoji fails it", async () => {
    const r = await check(page({ body: "<p>Tight lines 🎣</p>" }));
    expect(r.problems.join("\n")).toContain("emoji");
  }, 20_000);

  test("reaching the network after load fails it", async () => {
    const r = await check(
      page({ script: "fetch('https://example.com/data.json').then(r => r.json());" }),
    );
    expect(r.ok).toBe(false);
  }, 20_000);
});
