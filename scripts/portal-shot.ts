/**
 * Device-emulated screenshots via the Chrome DevTools Protocol.
 *   bun scripts/portal-shot.ts <outDir> <name>=<url>[@WxH[m]] ...   (m = mobile emulation)
 * Blocks the portal's /file?p= media so a 300-image grid does not stall.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [outDir, ...specs] = process.argv.slice(2);
if (!outDir || specs.length === 0) {
  console.error("usage: bun shot.ts <outDir> name=url[@WxH[m]] ...");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "shot-profile-"));
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
for (let i = 0; i < 100 && !existsSync(portFile); i++) await Bun.sleep(100);
if (!existsSync(portFile)) throw new Error("chrome did not start");
const [port] = readFileSync(portFile, "utf8").trim().split("\n");

let nextId = 1;
async function cdp(ws: WebSocket, method: string, params: Record<string, unknown> = {}) {
  const id = nextId++;
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === id) {
        ws.removeEventListener("message", onMsg);
        if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result ?? {});
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function waitEvent(ws: WebSocket, method: string, timeoutMs: number) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      ws.removeEventListener("message", onMsg);
      resolve();
    }, timeoutMs);
    const onMsg = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.method === method) {
        clearTimeout(t);
        ws.removeEventListener("message", onMsg);
        resolve();
      }
    };
    ws.addEventListener("message", onMsg);
  });
}

for (const spec of specs) {
  const m = spec.match(/^([\w-]+)=(.+?)(?:@(\d+)x(\d+)(m?))?$/);
  if (!m) {
    console.error("bad spec", spec);
    continue;
  }
  const [, name, url, w = "390", h = "844", mobile = "m"] = m;
  const width = Number(w);
  const height = Number(h);
  const t0 = Date.now();
  try {
    const target = (await (
      await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
    ).json()) as { id: string; webSocketDebuggerUrl: string };
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res());
      ws.addEventListener("error", () => rej(new Error("ws error")));
    });
    await cdp(ws, "Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: mobile === "m",
    });
    if (mobile === "m") {
      await cdp(ws, "Emulation.setUserAgentOverride", {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      });
      await cdp(ws, "Emulation.setTouchEmulationEnabled", { enabled: true });
    }
    await cdp(ws, "Network.enable");
    await cdp(ws, "Network.setBlockedURLs", { urls: ["*/file?p=*"] });
    await cdp(ws, "Page.enable");
    const loaded = waitEvent(ws, "Page.loadEventFired", 15_000);
    await cdp(ws, "Page.navigate", { url });
    await loaded;
    await Bun.sleep(2500); // the SPA's fetch + render
    // Hash tabs: the SPA reads the hash on load; nudge once more in case of a race.
    await cdp(ws, "Runtime.evaluate", {
      expression: "window.dispatchEvent(new HashChangeEvent('hashchange'))",
    });
    await Bun.sleep(600);
    const shot = (await cdp(ws, "Page.captureScreenshot", { format: "png" })) as { data: string };
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(shot.data, "base64"));
    ws.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
    console.log(`${name}: ok (${width}x${height}${mobile ? " mobile" : ""}, ${Date.now() - t0}ms)`);
  } catch (err) {
    console.log(`${name}: FAILED ${(err as Error).message}`);
  }
}
chrome.kill();
process.exit(0);
