import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelInboundRetries,
  inboundRetryAlreadyAnswered,
  isInboundRetryEvent,
} from "../src/cron/retry-marker.ts";
import { CronStore } from "../src/cron/store.ts";

let dir: string;
let crons: CronStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "edmund-retrymark-"));
  crons = new CronStore(dir);
});
afterEach(() => {
  crons.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("isInboundRetryEvent", () => {
  test("matches inbound-retry events at any attempt number", () => {
    expect(
      isInboundRetryEvent("[Retry 1/3] A prior turn from Jordan did not complete.\nError: x"),
    ).toBe(true);
    expect(isInboundRetryEvent("[Retry 3/3] A prior turn from +1555 did not complete.")).toBe(true);
  });

  test("does NOT match scheduled-event retries or normal events", () => {
    // A daily-brief retry shares the [Retry] prefix but not the body.
    expect(isInboundRetryEvent("[Retry 1/3] Daily RFP brief: pull the feed and summarize")).toBe(
      false,
    );
    expect(isInboundRetryEvent("Self-poke: check the oven timer")).toBe(false);
    expect(isInboundRetryEvent("A prior turn from Jordan did not complete.")).toBe(false);
  });
});

describe("inboundRetryAlreadyAnswered", () => {
  const RETRY_EVENT = "[Retry 1/3] A prior turn from Jordan did not complete.\nError: x";
  const T0 = 1_750_000_000_000; // inbound
  const T_FAIL = T0 + 60_000; // retry queued at failure time

  test("skips when an outbound landed after the retry was queued", () => {
    // A later turn (recovery, fresh inbound, outbox flush) answered the burst.
    expect(
      inboundRetryAlreadyAnswered(
        { systemEvent: RETRY_EVENT, createdAt: T_FAIL },
        { lastInboundMs: T0, lastOutboundMs: T_FAIL + 30_000 },
      ),
    ).toBe(true);
  });

  test("fires when the only outbound is a mid-turn send from BEFORE the failure", () => {
    // Model sent "on it, gimme a sec" via send_message (bumping
    // last_outbound_ms), then the turn died. The heads-up is not the answer —
    // the retry must fire so the model can resume and decide for itself.
    expect(
      inboundRetryAlreadyAnswered(
        { systemEvent: RETRY_EVENT, createdAt: T_FAIL },
        { lastInboundMs: T0, lastOutboundMs: T0 + 10_000 },
      ),
    ).toBe(false);
  });

  test("fires when the session still owes a reply outright", () => {
    expect(
      inboundRetryAlreadyAnswered(
        { systemEvent: RETRY_EVENT, createdAt: T_FAIL },
        { lastInboundMs: T0, lastOutboundMs: 0 },
      ),
    ).toBe(false);
  });

  test("never claims a non-inbound-retry event", () => {
    expect(
      inboundRetryAlreadyAnswered(
        { systemEvent: "[Retry 1/3] Daily RFP brief: pull the feed", createdAt: T_FAIL },
        { lastInboundMs: T0, lastOutboundMs: T_FAIL + 30_000 },
      ),
    ).toBe(false);
  });
});

describe("cancelInboundRetries", () => {
  test("cancels only inbound retries, only for the given session", () => {
    const mk = (sessionKey: string, systemEvent: string) =>
      crons.create({
        sessionKey,
        systemEvent,
        schedule: { kind: "once", atMs: Date.now() + 60_000 },
      });

    const target = mk("dm:+1555", "[Retry 1/3] A prior turn from Jordan did not complete.");
    const otherKind = mk("dm:+1555", "[Retry 1/3] Daily brief retry");
    const otherSession = mk("dm:+1666", "[Retry 1/3] A prior turn from Nate did not complete.");

    const n = cancelInboundRetries(crons, "dm:+1555");
    expect(n).toBe(1);

    const activeIds = crons.listActive().map((j) => j.id);
    expect(activeIds).not.toContain(target.id);
    expect(activeIds).toContain(otherKind.id);
    expect(activeIds).toContain(otherSession.id);
  });

  test("never cancels a lost-reply resend cron — a lost outbound stays owed even after an unrelated successful send", () => {
    // scheduleLostReplyResend (channels/turn.ts) queues `[Undelivered reply]`
    // events after a permanent send error. If this event ever matched
    // isInboundRetryEvent, the first successful send for the session would
    // cancel it and the lost reply would silently never be re-sent (the exact
    // incident from 2026-07-20: the reformat instruction was cancelled by the
    // very next successful reply).
    const resendEvent = [
      "[Undelivered reply] A reply you previously composed for this chat failed to send and has been discarded — the user never saw it.",
      "Send error: Missing value for option text",
    ].join("\n");
    expect(isInboundRetryEvent(resendEvent)).toBe(false);

    const resend = crons.create({
      sessionKey: "dm:+1555",
      systemEvent: resendEvent,
      schedule: { kind: "once", atMs: Date.now() + 60_000 },
    });
    expect(cancelInboundRetries(crons, "dm:+1555")).toBe(0);
    expect(crons.listActive().map((j) => j.id)).toContain(resend.id);
  });

  test("no-op when nothing queued", () => {
    expect(cancelInboundRetries(crons, "dm:+1555")).toBe(0);
  });
});
