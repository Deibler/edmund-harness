/**
 * Session-lock lease sizing + liveness/timeout behavior.
 *
 * The ceiling is an INACTIVITY bound, not a wall-clock cap: the Claude
 * worker heartbeats `touch(key)` on every stream event, so a long-but-alive
 * turn (a 40-minute video edit) extends its lease indefinitely while a
 * genuinely silent holder is released at `timeoutMs`. Holders that never
 * touch keep the old wall-clock semantics.
 */
import { describe, expect, test } from "bun:test";
import { SessionLocks, sessionLockTimeoutMs } from "../src/sessions/locks.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("sessionLockTimeoutMs", () => {
  test("sits just above the worker's own idle timeout", () => {
    const turn = 600_000; // config.claude.timeout_seconds = 600
    expect(sessionLockTimeoutMs(turn)).toBe(660_000);
    // The worker's idle reaper (1×) must fire BEFORE the lock ceiling so a
    // hung worker settles the section normally; the ceiling only catches
    // hangs outside a worker turn.
    expect(sessionLockTimeoutMs(turn)).toBeGreaterThan(turn);
    expect(sessionLockTimeoutMs(turn)).toBeLessThan(2 * turn);
  });
});

describe("SessionLocks timeout behavior", () => {
  test("a holder that finishes within the ceiling does not trip onTimeout", async () => {
    let timeouts = 0;
    const locks = new SessionLocks({ onTimeout: () => timeouts++ });
    const result = await locks.withLock(
      "k",
      async () => {
        await sleep(20);
        return "ok";
      },
      { timeoutMs: 200 },
    );
    expect(result).toBe("ok");
    expect(timeouts).toBe(0);
  });

  test("a genuinely silent overrun rejects the caller and fires onTimeout exactly once", async () => {
    let timeouts = 0;
    let seenElapsed = 0;
    const locks = new SessionLocks({
      onTimeout: (_key, elapsed) => {
        timeouts++;
        seenElapsed = elapsed;
      },
    });
    // fn() outlives the ceiling with no touches, then finishes cleanly.
    await expect(locks.withLock("k", async () => sleep(120), { timeoutMs: 30 })).rejects.toThrow(
      /session lock timeout/,
    );
    expect(timeouts).toBe(1);
    expect(seenElapsed).toBeGreaterThanOrEqual(30);
    // The late-completing fn must not surface as an unhandled rejection.
    await sleep(140);
    expect(timeouts).toBe(1); // still exactly once
  });

  test("the chain still serializes same-key holders", async () => {
    const locks = new SessionLocks();
    const order: string[] = [];
    const a = locks.withLock("k", async () => {
      order.push("a-start");
      await sleep(30);
      order.push("a-end");
    });
    const b = locks.withLock("k", async () => {
      order.push("b-start");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });
});

describe("SessionLocks liveness (touch)", () => {
  // NOTE on timing: touch() throttles re-arms to one per second, so these
  // tests use ceilings comfortably above 1s and heartbeat intervals that
  // outpace the throttle window.

  test("a holder that heartbeats outlives the ceiling and completes normally", async () => {
    let timeouts = 0;
    const locks = new SessionLocks({ onTimeout: () => timeouts++ });
    // Ceiling 1.3s; work runs 3.2s with a touch every 1.1s. Wall-clock is
    // ~2.5× the ceiling — under the old semantics this would have tripped.
    const heartbeat = setInterval(() => locks.touch("k"), 1_100);
    try {
      const result = await locks.withLock(
        "k",
        async () => {
          await sleep(3_200);
          return "done";
        },
        { timeoutMs: 1_300 },
      );
      expect(result).toBe("done");
      expect(timeouts).toBe(0);
    } finally {
      clearInterval(heartbeat);
    }
  }, 10_000);

  test("a holder that stops heartbeating is released one ceiling after its last touch", async () => {
    let timeouts = 0;
    const locks = new SessionLocks({ onTimeout: () => timeouts++ });
    // Touches every 400ms for the first ~2.2s, then silence. The 1s touch
    // throttle (seeded at acquisition) makes the last EFFECTIVE touch land
    // around t≈1.2-2.2s, so with a 1.4s ceiling the expiry fires around
    // t≈2.6-3.6s — clearly past where the un-touched ceiling (1.4s) would
    // have fired, and clearly before the 6s work completes.
    const startedAt = Date.now();
    let rejectedAt = 0;
    const heartbeat = setInterval(() => {
      if (Date.now() - startedAt < 2_200) locks.touch("k");
    }, 400);
    try {
      await expect(
        locks.withLock("k", async () => sleep(6_000), { timeoutMs: 1_400 }),
      ).rejects.toThrow(/no liveness/);
      rejectedAt = Date.now() - startedAt;
      expect(timeouts).toBe(1);
      // Released AFTER the plain ceiling (the touches bought time)...
      expect(rejectedAt).toBeGreaterThan(2_000);
      // ...but well before the work finished.
      expect(rejectedAt).toBeLessThan(5_500);
    } finally {
      clearInterval(heartbeat);
      await sleep(0);
    }
  }, 12_000);

  test("touching an idle key is a harmless no-op", () => {
    const locks = new SessionLocks();
    expect(() => locks.touch("nobody-home")).not.toThrow();
  });

  test("late touches from a released holder cannot extend the successor's lease", async () => {
    // Holder A times out silent; holder B acquires. A's stale extend must
    // no-op (its registry entry is gone), so B's own ceiling still governs.
    const locks = new SessionLocks({ onTimeout: () => {} });
    await expect(
      locks.withLock("k", async () => sleep(2_000), { timeoutMs: 1_100 }),
    ).rejects.toThrow(/session lock timeout/);
    // B: short, healthy holder — must complete despite A still running.
    const result = await locks.withLock("k", async () => "b-ok", { timeoutMs: 1_100 });
    expect(result).toBe("b-ok");
    await sleep(1_000); // let A's fn finish quietly (covered by its own handler)
  }, 10_000);
});
