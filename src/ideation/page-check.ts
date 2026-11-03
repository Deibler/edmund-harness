import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ideationHeaders } from "./serve.ts";

/**
 * The check a page must pass before anyone is sent its link. It opens the
 * page the way the person's phone will (390 px wide, under the exact headers
 * the kitchen host sends) and refuses it for anything that would make it
 * broken, blank, cramped or off-brief. The builder runs it and fixes what it
 * reports, so every problem is written as something to change.
 *
 * Looked for in the rendered page rather than the source, so a Tailwind
 * class and a hand-written rule are caught alike:
 *  - an uncaught error, or anything the sandbox blocked
 *  - too little text to be a page (a blank or crashed render)
 *  - sideways scrolling on a phone
 *  - a left accent border, gradient text, or an emoji (DESIGN.md rules 1-3)
 */

export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MIN_TEXT_CHARS = 200;
const VIEW = { width: 390, height: 844 };
/** Screens of a long page pictured for review; the rest are summarised in one line. */
const MAX_SCREENS = 10;

export type PageCheck = {
  ok: boolean;
  problems: string[];
  /** The first screen at phone width, JPEG, when the page rendered at all. */
  screenshot: Buffer | null;
  /** With `allScreens`: the whole page, one phone screen per JPEG, top down. */
  screens: Buffer[];
  /** The page's full height in CSS pixels at phone width, when measured. */
  pageHeight: number | null;
};

/** Emoji as people see them: emoji-by-default characters, or any symbol forced to emoji. */
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u;

export function findEmoji(text: string): string | null {
  const m = text.match(EMOJI);
  return m ? m[0] : null;
}

/** What can be told without a browser. */
export function staticProblems(html: string): string[] {
  const problems: string[] = [];
  const bytes = Buffer.byteLength(html);
  if (bytes > MAX_PAGE_BYTES) {
    problems.push(
      `the page is ${(bytes / 1048576).toFixed(1)} MB; the limit is 3 MB. Inline smaller images or drop a library.`,
    );
  }
  if (!/<html[\s>]/i.test(html))
    problems.push("there is no <html> element; publish the built dist/index.html.");
  if (/<script[^>]+src=["']https?:/i.test(html)) {
    problems.push("a <script> loads from another site; bundle the library with bun add instead.");
  }
  return problems;
}

/** Runs in the page: what the design rules and the layout look like once rendered. */
const MEASURE = `(() => {
  const all = Array.from(document.querySelectorAll("body *"));
  const label = (el) => {
    const t = (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40);
    return el.tagName.toLowerCase() + (t ? ' "' + t + '"' : "");
  };
  const stripes = [];
  const gradients = [];
  for (const el of all) {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") continue;
    const left = parseFloat(s.borderLeftWidth) || 0;
    const others = Math.max(parseFloat(s.borderTopWidth) || 0, parseFloat(s.borderRightWidth) || 0, parseFloat(s.borderBottomWidth) || 0);
    if (s.borderLeftStyle !== "none" && left >= 2 && left > others && s.borderLeftColor !== "rgba(0, 0, 0, 0)") stripes.push(label(el));
    const clip = s.backgroundClip || s.webkitBackgroundClip || "";
    if (clip.includes("text") && s.backgroundImage.includes("gradient")) gradients.push(label(el));
  }
  return {
    text: (document.body.innerText || "").trim(),
    title: document.title || "",
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    stripes: stripes.slice(0, 3),
    gradients: gradients.slice(0, 3),
  };
})()`;

/** The fields read from the DevTools events this check listens to. */
type CdpEventParams = {
  exceptionDetails?: { text?: string; exception?: { description?: string } };
  type?: string;
  args?: Array<{ value?: unknown; description?: string }>;
  entry?: { level?: string; text?: string };
  blockedReason?: string;
};

type Measure = {
  text: string;
  title: string;
  scrollWidth: number;
  innerWidth: number;
  stripes: string[];
  gradients: string[];
};

/** One headless Chrome, reused across checks (a test checks several pages). */
export class PageChecker {
  private constructor(
    private readonly chrome: ChildProcess,
    private readonly profile: string,
    private readonly port: string,
  ) {}

  static available(): boolean {
    return existsSync(CHROME);
  }

  static async launch(): Promise<PageChecker> {
    const profile = mkdtempSync(join(tmpdir(), "ideation-check-"));
    const chrome = spawn(
      CHROME,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--disable-gpu",
        "--hide-scrollbars",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    const portFile = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 150 && !existsSync(portFile); i++) await Bun.sleep(100);
    if (!existsSync(portFile)) {
      chrome.kill();
      throw new Error("headless Chrome did not start");
    }
    const [port] = readFileSync(portFile, "utf8").trim().split("\n");
    return new PageChecker(chrome, profile, port ?? "");
  }

  async close(): Promise<void> {
    this.chrome.kill();
    await Bun.sleep(100);
    rmSync(this.profile, { recursive: true, force: true });
  }

  /**
   * Check one page's HTML. `settleMs`: how long to let it render after load.
   * `allScreens`: also picture the whole page, screen by screen, for review
   * (the first screen alone hides everything below the fold).
   */
  async check(
    html: string,
    opts: { settleMs?: number; allScreens?: boolean } = {},
  ): Promise<PageCheck> {
    const problems = staticProblems(html);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(html, { headers: ideationHeaders("text/html; charset=utf-8") }),
    });
    const seen: string[] = [];
    let screenshot: Buffer | null = null;
    const screens: Buffer[] = [];
    let pageHeight: number | null = null;
    try {
      const target = (await (
        await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: "PUT" })
      ).json()) as { id: string; webSocketDebuggerUrl: string };
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise<void>((res, rej) => {
        ws.addEventListener("open", () => res());
        ws.addEventListener("error", () => rej(new Error("DevTools connection failed")));
      });
      const cdp = makeCdp(ws);
      ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(String(ev.data)) as { method?: string; params?: CdpEventParams };
        const p = msg.params ?? {};
        if (msg.method === "Runtime.exceptionThrown") {
          const d = p.exceptionDetails ?? {};
          const what = d.exception?.description ?? d.text ?? "unknown error";
          seen.push(
            `uncaught error: ${String(what).split("\n")[0]}. Fix it; the page must run without errors.`,
          );
        } else if (msg.method === "Runtime.consoleAPICalled" && p.type === "error") {
          const what = (p.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
          seen.push(`console error: ${String(what).slice(0, 160)}.`);
        } else if (msg.method === "Log.entryAdded") {
          const e = p.entry ?? {};
          if (e.level === "error" && /Content Security Policy|sandbox/i.test(e.text ?? "")) {
            seen.push(
              `the sandbox blocked something: ${String(e.text).slice(0, 200).replace(/\.+$/, "")}. Pages cannot use the network after loading; bake the data in.`,
            );
          }
        } else if (msg.method === "Network.loadingFailed" && p.blockedReason === "csp") {
          seen.push(
            `the sandbox blocked a request. Pages cannot load scripts, styles or data from the network; bundle them.`,
          );
        }
      });
      await cdp("Emulation.setDeviceMetricsOverride", {
        ...VIEW,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await cdp("Emulation.setUserAgentOverride", {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      });
      await cdp("Emulation.setTouchEmulationEnabled", { enabled: true });
      await cdp("Runtime.enable");
      await cdp("Log.enable");
      await cdp("Network.enable");
      await cdp("Page.enable");
      const loaded = waitFor(ws, "Page.loadEventFired", 15_000);
      await cdp("Page.navigate", { url: `http://127.0.0.1:${server.port}/i/check/` });
      if (!(await loaded)) seen.push("the page did not finish loading within 15 seconds.");
      await Bun.sleep(opts.settleMs ?? 2000);

      const res = (await cdp("Runtime.evaluate", { expression: MEASURE, returnByValue: true })) as {
        result?: { value?: Measure };
      };
      const m = res.result?.value;
      if (!m) {
        seen.push("the page could not be measured; it may have crashed while rendering.");
      } else {
        if (m.text.length < MIN_TEXT_CHARS) {
          seen.push(
            `the page shows only ${m.text.length} characters of text at phone width; it is blank or failed to render.`,
          );
        }
        // Against the device's width, not innerWidth: a phone zooms out to
        // fit content wider than the screen, and innerWidth grows with it.
        if (m.scrollWidth > VIEW.width + 1) {
          seen.push(
            `the page is ${m.scrollWidth}px wide on a ${VIEW.width}px phone, so it scrolls sideways. Make every element fit 390px.`,
          );
        }
        for (const s of m.stripes) {
          seen.push(
            `left accent border on ${s}. Remove it (DESIGN.md rule 1); use space or a full hairline instead.`,
          );
        }
        for (const g of m.gradients) {
          seen.push(`gradient text on ${g}. Use a solid colour (DESIGN.md rule 2).`);
        }
        const emoji = findEmoji(`${m.title} ${m.text}`);
        if (emoji)
          seen.push(`an emoji ("${emoji}") is on the page. Remove every emoji (DESIGN.md rule 3).`);
      }
      const shot = (await cdp("Page.captureScreenshot", { format: "jpeg", quality: 72 })) as {
        data?: string;
      };
      if (shot.data) screenshot = Buffer.from(shot.data, "base64");
      const metrics = (await cdp("Page.getLayoutMetrics")) as {
        cssContentSize?: { height?: number };
      };
      pageHeight = Math.ceil(metrics.cssContentSize?.height ?? 0) || null;
      if (opts.allScreens && pageHeight) {
        for (let y = 0; y < pageHeight && screens.length < MAX_SCREENS; y += VIEW.height) {
          const part = (await cdp("Page.captureScreenshot", {
            format: "jpeg",
            quality: 72,
            captureBeyondViewport: true,
            clip: {
              x: 0,
              y,
              width: VIEW.width,
              height: Math.min(VIEW.height, pageHeight - y),
              scale: 1,
            },
          })) as { data?: string };
          if (part.data) screens.push(Buffer.from(part.data, "base64"));
        }
      }
      ws.close();
      await fetch(`http://127.0.0.1:${this.port}/json/close/${target.id}`).catch(() => {});
    } catch (err) {
      seen.push(`the check itself failed: ${(err as Error).message}`);
    } finally {
      server.stop(true);
    }
    const all = [...problems, ...new Set(seen)];
    return { ok: all.length === 0, problems: all, screenshot, screens, pageHeight };
  }
}

function makeCdp(ws: WebSocket) {
  let next = 1;
  return (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = next++;
      const onMsg = (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number;
          error?: unknown;
          result?: Record<string, unknown>;
        };
        if (msg.id !== id) return;
        ws.removeEventListener("message", onMsg);
        if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result ?? {});
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
}

function waitFor(ws: WebSocket, method: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      ws.removeEventListener("message", onMsg);
      resolve(false);
    }, timeoutMs);
    const onMsg = (ev: MessageEvent) => {
      if ((JSON.parse(String(ev.data)) as { method?: string }).method === method) {
        clearTimeout(t);
        ws.removeEventListener("message", onMsg);
        resolve(true);
      }
    };
    ws.addEventListener("message", onMsg);
  });
}
