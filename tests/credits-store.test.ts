import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreditStore } from "../src/credits/store.ts";

function fresh(): CreditStore {
  return new CreditStore(mkdtempSync(join(tmpdir(), "credits-store-")));
}
const KEY = "imessage:dm:+15551230001";

describe("credit wallets", () => {
  test("ensure creates once, in wallet mode with no key", () => {
    const s = fresh();
    const a = s.ensure(KEY, 1000);
    const b = s.ensure(KEY, 2000);
    expect(a.billingMode).toBe("wallet");
    expect(a.apiKey).toBeNull();
    expect(b.createdAtMs).toBe(1000);
    expect(s.list()).toHaveLength(1);
    s.close();
  });

  test("setMode works before any key exists and flips back", () => {
    const s = fresh();
    expect(s.setMode(KEY, "house").billingMode).toBe("house");
    expect(s.get(KEY)?.apiKey).toBeNull();
    expect(s.setMode(KEY, "wallet").billingMode).toBe("wallet");
    s.close();
  });

  test("attachKey records the plaintext key, hash and starter", () => {
    const s = fresh();
    const w = s.attachKey(KEY, { hash: "h1", apiKey: "sk-or-v1-x", limitUsd: 0, starterUsd: 0 });
    expect(w.keyHash).toBe("h1");
    expect(w.apiKey).toBe("sk-or-v1-x");
    expect(w.lastSeenRemainingUsd).toBe(0);
    s.close();
  });

  test("recordSeen is a display snapshot", () => {
    const s = fresh();
    s.attachKey(KEY, { hash: "h1", apiKey: "k", limitUsd: 5, starterUsd: 0 });
    s.recordSeen(KEY, { usageUsd: 1.25, remainingUsd: 3.75, limitUsd: 5 }, 9000);
    const w = s.get(KEY)!;
    expect(w.lastSeenUsageUsd).toBe(1.25);
    expect(w.lastSeenRemainingUsd).toBe(3.75);
    expect(w.lastSeenAtMs).toBe(9000);
    s.close();
  });
});

describe("credit events", () => {
  test("refusals roll up per session and list newest first", () => {
    const s = fresh();
    s.recordEvent({
      sessionKey: KEY,
      kind: "refused-exhausted",
      generation: "image",
      remainingUsd: 0,
      atMs: 1,
    });
    s.recordEvent({
      sessionKey: KEY,
      kind: "refused-short",
      generation: "video",
      remainingUsd: 3,
      atMs: 3,
    });
    const sum = s.eventSummaries().get(KEY)!;
    expect(sum.paywallHits).toBe(2);
    expect(sum.lastPaywallAtMs).toBe(3);
    expect(sum.lastPaywallGeneration).toBe("video");
    expect(s.recentEvents(10, true).map((e) => e.kind)).toEqual([
      "refused-short",
      "refused-exhausted",
    ]);
    expect(s.eventsFor(KEY)).toHaveLength(2);
    s.close();
  });

  test("rows once written for charged generations are dropped on open — OpenRouter is the record", () => {
    const dir = mkdtempSync(join(tmpdir(), "credits-store-"));
    const a = new CreditStore(dir);
    // The 2026-09-02 shape, written straight to the table.
    (a as unknown as { db: { exec(sql: string): void } }).db.exec(
      `INSERT INTO credit_events (session_key, kind, generation, at_ms, remaining_usd, cost_usd)
       VALUES ('${KEY}', 'charged', 'image', 5, 4.5, 0.05),
              ('${KEY}', 'refused-exhausted', 'image', 6, 0, NULL)`,
    );
    a.close();
    const b = new CreditStore(dir);
    expect(b.eventsFor(KEY).map((e) => e.kind)).toEqual(["refused-exhausted"]);
    b.close();
  });
});
