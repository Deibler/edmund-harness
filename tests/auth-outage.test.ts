import { describe, expect, test } from "bun:test";
import {
  OperatorAlert,
  isAuthFailure,
  isOperatorActionable,
  isRetryable,
} from "../src/alerts/operator-alert.ts";
import { retryPlan } from "../src/cron/fire.ts";
import { classifyError } from "../src/recovery/classify.ts";

// The strings every Claude call returned during the three login outages
// (2026-08-25, 09-23, 10-23), copied from the daemon log. None of them
// raised an alert before, because the matcher looked for "authentication"
// and "401" and the newest CLI wording has neither.
const OUTAGE_STRINGS = [
  "Failed to authenticate: OAuth session expired and could not be refreshed",
  "claude exited without result: Failed to authenticate: OAuth session expired and could not be refreshed",
  "Failed to authenticate. API Error: 401 Invalid authentication credentials",
  'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
  "Login expired · Please run /login",
];

describe("an expired login is an outage, not a quiet failure", () => {
  test("every outage string reads as an auth failure", () => {
    for (const s of OUTAGE_STRINGS) expect(isAuthFailure(s)).toBe(true);
  });

  test("every outage string alerts the operator and is retried", () => {
    for (const s of OUTAGE_STRINGS) {
      expect(isOperatorActionable(s)).toBe(true);
      expect(isRetryable(s)).toBe(true);
    }
  });

  test("every outage string classifies as auth_expired", () => {
    for (const s of OUTAGE_STRINGS) expect(classifyError(s)).toBe("auth_expired");
  });

  test("ordinary failures are not auth failures", () => {
    for (const s of [
      "claude timed out after 180s",
      "API Error: 529 overloaded",
      "web_fetch 403 forbidden for https://example.com",
      "the person said they could not authenticate on the bank site",
    ]) {
      expect(isAuthFailure(s)).toBe(false);
    }
  });

  test("the alert says what to do", () => {
    const alert = new OperatorAlert({ operatorHandle: "", minIntervalMinutes: 0 });
    const body = (alert as unknown as { formatBody: (p: object) => string }).formatBody({
      category: "model runner error",
      error: OUTAGE_STRINGS[0],
    });
    expect(body).toContain("/login");
  });
});

describe("scheduled jobs outlast a login outage", () => {
  test("ordinary failures keep three retries five minutes apart", () => {
    expect(retryPlan(1, "claude timed out")).toEqual({ max: 3, delayMs: 5 * 60_000 });
    expect(retryPlan(3, "claude timed out")).toEqual({ max: 3, delayMs: 5 * 60_000 });
  });

  test("auth failures back off and cover hours, not fifteen minutes", () => {
    const err = OUTAGE_STRINGS[0];
    const plan = Array.from({ length: retryPlan(1, err).max }, (_, i) => retryPlan(i + 1, err));
    const totalMs = plan.reduce((sum, p) => sum + p.delayMs, 0);
    expect(plan[0]?.delayMs).toBe(5 * 60_000);
    expect(plan[1]?.delayMs).toBe(10 * 60_000);
    expect(Math.max(...plan.map((p) => p.delayMs))).toBe(2 * 60 * 60_000);
    // The 10-23 outage lasted 63 minutes; 08-25's about 15 hours.
    expect(totalMs).toBeGreaterThan(8 * 60 * 60_000);
  });
});
