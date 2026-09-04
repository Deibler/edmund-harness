import { describe, expect, test } from "bun:test";
import { RadarOmegaRefresher, parseEtime } from "../integrations/radaromega/src/refresher.ts";

const HOUR = 3_600_000;

function make(opts: {
  uptimeMs: number | null;
  busy?: boolean;
  maxUptimeMs?: number;
  onRelaunch?: () => void;
  failRelaunch?: boolean;
}) {
  const calls = { relaunches: 0 };
  const refresher = new RadarOmegaRefresher({
    cdpPort: 9222,
    maxUptimeMs: opts.maxUptimeMs ?? 6 * HOUR,
    checkIntervalMs: 60_000,
    isBusy: () => opts.busy ?? false,
    log: () => {},
    getUptimeMs: async () => opts.uptimeMs,
    relaunch: async () => {
      calls.relaunches++;
      opts.onRelaunch?.();
      if (opts.failRelaunch) throw new Error("open failed");
    },
  });
  return { refresher, calls };
}

describe("RadarOmegaRefresher", () => {
  test("relaunches when uptime exceeds the threshold and pool is idle", async () => {
    const { refresher, calls } = make({ uptimeMs: 7 * HOUR });
    expect(await refresher.tick()).toBe("refreshed");
    expect(calls.relaunches).toBe(1);
  });

  test("leaves a fresh app alone", async () => {
    const { refresher, calls } = make({ uptimeMs: 2 * HOUR });
    expect(await refresher.tick()).toBe("fresh");
    expect(calls.relaunches).toBe(0);
  });

  test("does nothing when the app is not running", async () => {
    const { refresher, calls } = make({ uptimeMs: null });
    expect(await refresher.tick()).toBe("not-running");
    expect(calls.relaunches).toBe(0);
  });

  test("defers while a worker is mid-turn", async () => {
    const { refresher, calls } = make({ uptimeMs: 20 * HOUR, busy: true });
    expect(await refresher.tick()).toBe("skipped-busy");
    expect(calls.relaunches).toBe(0);
  });

  test("relaunch errors are contained and reported", async () => {
    const { refresher } = make({ uptimeMs: 7 * HOUR, failRelaunch: true });
    expect(await refresher.tick()).toBe("error");
    // a failed relaunch must not leave the refresher stuck "refreshing"
    expect(await refresher.tick()).toBe("error");
  });

  test("respects a custom threshold", async () => {
    const { refresher, calls } = make({ uptimeMs: 3 * HOUR, maxUptimeMs: 2 * HOUR });
    expect(await refresher.tick()).toBe("refreshed");
    expect(calls.relaunches).toBe(1);
  });
});

describe("parseEtime", () => {
  test("mm:ss", () => expect(parseEtime("04:09")).toBe(4 * 60_000 + 9_000));
  test("hh:mm:ss", () => expect(parseEtime("13:04:09")).toBe(13 * HOUR + 4 * 60_000 + 9_000));
  test("dd-hh:mm:ss", () => expect(parseEtime("2-03:00:00")).toBe(2 * 24 * HOUR + 3 * HOUR));
  test("garbage", () => expect(parseEtime("etimes: keyword not found")).toBe(null));
});
