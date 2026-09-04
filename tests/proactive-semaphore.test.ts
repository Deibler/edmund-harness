/**
 * Unit tests for the brown-nose proactive semaphore.
 *
 * Covers:
 *   - At-most-N concurrent acquires (cap honored under load)
 *   - Stagger floor (back-to-back acquire blocked until minSpacing)
 *   - Release is idempotent
 *   - Snapshot reports the correct in-flight count
 */
import { describe, expect, test } from "bun:test";
import { ProactiveSemaphore } from "../src/proactive/semaphore.ts";

describe("ProactiveSemaphore", () => {
  test("at-most-N concurrent — 10 attempts, cap 3, exactly 3 acquire", () => {
    const sem = new ProactiveSemaphore(3, 0);
    const results = Array.from({ length: 10 }, () => sem.tryAcquire(0));
    const acquired = results.filter((r) => r.acquired);
    const declined = results.filter((r) => !r.acquired);
    expect(acquired.length).toBe(3);
    expect(declined.length).toBe(7);
    for (const d of declined) {
      if (!d.acquired) expect(d.reason).toBe("cap_full");
    }
  });

  test("releasing slots lets the next acquire succeed", () => {
    const sem = new ProactiveSemaphore(2, 0);
    const a = sem.tryAcquire(0);
    const b = sem.tryAcquire(0);
    const c = sem.tryAcquire(0);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    expect(c.acquired).toBe(false);

    if (a.acquired) a.release();
    // After release, last-release-at is bumped to now() which can block
    // the next acquire via the stagger gate. Use minSpacing=0 above so
    // this test isolates the cap dimension. tryAcquire(0) puts the
    // wall-clock check far in the past relative to the released-now
    // timestamp; pass a future "now" to also clear the stagger.
    const d = sem.tryAcquire(Date.now() + 1_000_000);
    expect(d.acquired).toBe(true);
  });

  test("stagger floor blocks back-to-back acquire within minSpacing", () => {
    const sem = new ProactiveSemaphore(5, 1000); // 1s spacing
    const a = sem.tryAcquire(0);
    expect(a.acquired).toBe(true);
    if (a.acquired) a.release();
    // Acquire immediately after release — wall clock < minSpacing apart.
    const b = sem.tryAcquire(Date.now());
    expect(b.acquired).toBe(false);
    if (!b.acquired) expect(b.reason).toBe("stagger");
  });

  test("stagger allows acquire once minSpacing elapses", () => {
    const sem = new ProactiveSemaphore(5, 100);
    const a = sem.tryAcquire(0);
    expect(a.acquired).toBe(true);
    if (a.acquired) a.release();
    // Synthetically advance the clock by passing a later "now" to
    // tryAcquire. (Real callers pass Date.now(); the parameter exists
    // exactly for test determinism.)
    const lateNow = Date.now() + 500;
    const b = sem.tryAcquire(lateNow);
    expect(b.acquired).toBe(true);
  });

  test("release is idempotent — calling it twice doesn't double-decrement", () => {
    const sem = new ProactiveSemaphore(1, 0);
    const a = sem.tryAcquire(0);
    expect(a.acquired).toBe(true);
    if (a.acquired) {
      a.release();
      a.release(); // no-op
    }
    expect(sem.snapshot().inFlight).toBe(0);
  });

  test("snapshot reports current state", () => {
    const sem = new ProactiveSemaphore(2, 0);
    const a = sem.tryAcquire(0);
    expect(sem.snapshot().inFlight).toBe(1);
    expect(sem.snapshot().cap).toBe(2);
    if (a.acquired) a.release();
    expect(sem.snapshot().inFlight).toBe(0);
  });

  test("after cap clears, subsequent acquires resume normally", () => {
    const sem = new ProactiveSemaphore(3, 0);
    // First wave: fill the cap.
    const wave1 = [sem.tryAcquire(0), sem.tryAcquire(0), sem.tryAcquire(0)];
    const wave1Declined = sem.tryAcquire(0);
    expect(wave1Declined.acquired).toBe(false);
    // Release everything.
    for (const r of wave1) if (r.acquired) r.release();
    // Second wave: should all acquire (advance clock past stagger).
    const lateNow = Date.now() + 1_000_000;
    const wave2 = [sem.tryAcquire(lateNow), sem.tryAcquire(lateNow), sem.tryAcquire(lateNow)];
    expect(wave2.every((r) => r.acquired)).toBe(true);
  });
});
