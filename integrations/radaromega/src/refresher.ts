/**
 * RadarOmega freshness watchdog.
 *
 * The app's model engine corrupts after long uptime (engine callbacks stop
 * firing — verified live 2026-06-10, cost a worker a 28-minute turn). The
 * MCP tools self-heal reactively, but that still costs the FIRST weather
 * turn after a wedge ~20s of restart. This watchdog prevents the wedge from
 * forming: the daemon relaunches the app once its uptime crosses a
 * threshold, and only while no worker is mid-turn, so a restart never lands
 * in the middle of a radar session.
 *
 * If the app isn't running at all, the watchdog does nothing — the MCP
 * server auto-launches it on first use, and an idle Mac doesn't need the
 * app open.
 */

import { spawn } from "node:child_process";

export interface RefresherOpts {
  cdpPort: number;
  /** Relaunch once app uptime exceeds this. */
  maxUptimeMs: number;
  /** Sweep cadence. */
  checkIntervalMs: number;
  /** True while any pooled worker is mid-turn — refresh is deferred. */
  isBusy: () => boolean;
  appPath?: string;
  log?: (msg: string) => void;
  /** Test seams. */
  getUptimeMs?: () => Promise<number | null>;
  relaunch?: () => Promise<void>;
}

const APP_PROC = "RadarOmega.app/Contents/MacOS/RadarOmega";

function run(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.on("close", (code) => resolve({ code, stdout }));
    child.on("error", () => resolve({ code: -1, stdout: "" }));
  });
}

/** Parse ps's etime format — [[dd-]hh:]mm:ss — into milliseconds. */
export function parseEtime(raw: string): number | null {
  const m = raw.trim().match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, dd, hh, mm, ss] = m;
  return ((Number(dd ?? 0) * 24 + Number(hh ?? 0)) * 60 + Number(mm)) * 60_000 + Number(ss) * 1_000;
}

/** Uptime of the running RadarOmega main process, or null if not running.
 *  macOS ps has no `etimes` (seconds) keyword — only formatted `etime`. */
async function appUptimeMs(): Promise<number | null> {
  const { stdout } = await run("ps", ["-axo", "etime=,command="]);
  for (const line of stdout.split("\n")) {
    if (line.includes(APP_PROC) && !line.includes("Helper")) {
      const ms = parseEtime(line.trim().split(/\s+/)[0] ?? "");
      if (ms !== null) return ms;
    }
  }
  return null;
}

export class RadarOmegaRefresher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;

  constructor(private opts: RefresherOpts) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.checkIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<"refreshed" | "skipped-busy" | "fresh" | "not-running" | "error"> {
    if (this.refreshing) return "skipped-busy";
    const log = this.opts.log ?? (() => {});
    try {
      const uptime = await (this.opts.getUptimeMs ?? appUptimeMs)();
      if (uptime === null) return "not-running";
      if (uptime < this.opts.maxUptimeMs) return "fresh";
      if (this.opts.isBusy()) {
        // A worker is mid-turn (maybe mid radar session) — try again next
        // sweep. The MCP's reactive self-heal covers the meantime.
        return "skipped-busy";
      }
      this.refreshing = true;
      log(
        `[radaromega] app uptime ${Math.round(uptime / 3_600_000)}h ≥ ${Math.round(
          this.opts.maxUptimeMs / 3_600_000,
        )}h — preventative relaunch`,
      );
      await (this.opts.relaunch ?? (() => this.defaultRelaunch()))();
      return "refreshed";
    } catch (e) {
      log(`[radaromega] refresh failed: ${(e as Error).message}`);
      return "error";
    } finally {
      this.refreshing = false;
    }
  }

  /** pkill then `open -a` with the CDP flag — same protocol as the MCP's
   *  own self-heal launch (Electron honors the port only on fresh launch,
   *  and `open` parents the app to launchd so it outlives the daemon). */
  private async defaultRelaunch(): Promise<void> {
    await run("pkill", ["-f", APP_PROC]);
    await new Promise((r) => setTimeout(r, 1_500));
    await run("open", [
      "-a",
      this.opts.appPath ?? "/Applications/RadarOmega.app",
      "--args",
      `--remote-debugging-port=${this.opts.cdpPort}`,
    ]);
  }
}
