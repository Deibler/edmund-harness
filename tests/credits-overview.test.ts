import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCreditRows,
  recentPaywallEvents,
} from "../dashboard/server/services/creditsOverview.ts";
import { ConfigSchema } from "../src/config/config.ts";
import { CreditStore } from "../src/credits/store.ts";

const OPERATOR = "+15550100001";
const ALICE = "imessage:dm:+15551230001";
const BOB = "imessage:dm:+15551230002";

function config(dataDir: string) {
  return ConfigSchema.parse({
    self: { handles: [] },
    allowlist: {},
    identity: {},
    paths: { data_dir: dataDir },
    alerts: { operator_handle: OPERATOR },
    credits: { enabled: true },
  });
}

describe("credits overview rows", () => {
  test("every known conversation appears with what it will pay with, wallet or not", () => {
    const dir = mkdtempSync(join(tmpdir(), "credits-overview-"));
    const store = new CreditStore(dir);
    store.setMode(BOB, "house");
    store.attachKey(ALICE, { hash: "h", apiKey: "sk-or-v1-a", limitUsd: 9, starterUsd: 0 });
    store.recordSeen(ALICE, { usageUsd: 2, remainingUsd: 7, limitUsd: 9 }, 5_000);
    const rows = buildCreditRows({
      config: config(dir),
      store,
      sessions: [
        { sessionKey: ALICE, lastInboundMs: 300 },
        { sessionKey: "sms:dm:+15551230001", lastInboundMs: 900 }, // same person, other channel
        { sessionKey: BOB, lastInboundMs: 200 },
        { sessionKey: `imessage:dm:${OPERATOR}`, lastInboundMs: 1000 },
        { sessionKey: "imessage:dm:+15551230003", lastInboundMs: 100 }, // never generated
        { sessionKey: "imessage:group:g1", lastInboundMs: 800 },
        { sessionKey: "mirror:pi-4", lastInboundMs: 999 }, // not a person
        { sessionKey: "agent:agent_1", lastInboundMs: 999 },
      ],
      label: (k) => `L:${k}`,
    });
    const byKey = new Map(rows.map((r) => [r.sessionKey, r]));
    expect([...byKey.keys()].sort()).toEqual(
      [
        ALICE,
        BOB,
        `imessage:dm:${OPERATOR}`,
        "imessage:dm:+15551230003",
        "imessage:group:g1",
      ].sort(),
    );
    const alice = byKey.get(ALICE)!;
    expect(alice.paysWith).toBe("wallet");
    expect(alice.hasKey).toBe(true);
    expect(alice.live).toBe(false); // the snapshot, until enrichLive asks OpenRouter
    expect(alice.remainingUsd).toBe(7);
    expect(alice.lastInboundMs).toBe(900); // the SMS thread was newer; one row, latest activity
    expect(byKey.get(BOB)!.paysWith).toBe("house-override");
    expect(byKey.get(`imessage:dm:${OPERATOR}`)!.paysWith).toBe("house-operator");
    const carol = byKey.get("imessage:dm:+15551230003")!;
    expect(carol.paysWith).toBe("wallet");
    expect(carol.hasKey).toBe(false);
    expect(carol.remainingUsd).toBeNull();
    expect(carol.paidTotalUsd).toBeNull();
    const group = byKey.get("imessage:group:g1")!;
    expect(group.kind).toBe("group");
    expect(group.paysWith).toBe("house-group");
    // people first (newest conversation on top), groups after
    expect(rows.map((r) => r.kind)).toEqual(["dm", "dm", "dm", "dm", "group"]);
    expect(rows[0]!.sessionKey).toBe(`imessage:dm:${OPERATOR}`);
    store.close();
  });

  test("a person added on the dashboard shows up before they ever text", () => {
    const dir = mkdtempSync(join(tmpdir(), "credits-overview-"));
    const store = new CreditStore(dir);
    store.setMode("imessage:dm:+15559990000", "house");
    const rows = buildCreditRows({ config: config(dir), store, sessions: [], label: (k) => k });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.paysWith).toBe("house-override");
    expect(rows[0]!.lastInboundMs).toBeNull();
    store.close();
  });

  test("paywall hits roll up per person and list newest first", () => {
    const dir = mkdtempSync(join(tmpdir(), "credits-overview-"));
    const store = new CreditStore(dir);
    store.recordEvent({
      sessionKey: ALICE,
      kind: "refused-exhausted",
      generation: "image",
      remainingUsd: 0,
      atMs: 1000,
    });
    store.recordEvent({
      sessionKey: ALICE,
      kind: "refused-short",
      generation: "video",
      remainingUsd: 3,
      atMs: 2000,
      detail: "needs $4",
    });
    store.recordEvent({
      sessionKey: BOB,
      kind: "refused-exhausted",
      generation: "audio",
      remainingUsd: 0,
      atMs: 4000,
    });
    const rows = buildCreditRows({
      config: config(dir),
      store,
      sessions: [
        { sessionKey: ALICE, lastInboundMs: 1 },
        { sessionKey: BOB, lastInboundMs: 2 },
      ],
      label: (k) => k,
    });
    const alice = rows.find((r) => r.sessionKey === ALICE)!;
    expect(alice.paywallHits).toBe(2);
    expect(alice.lastPaywallAtMs).toBe(2000);
    expect(alice.lastPaywallGeneration).toBe("video");
    const bob = rows.find((r) => r.sessionKey === BOB)!;
    expect(bob.paywallHits).toBe(1);

    const feed = recentPaywallEvents({ store, label: (k) => k });
    expect(feed.map((e) => [e.sessionKey, e.kind])).toEqual([
      [BOB, "refused-exhausted"],
      [ALICE, "refused-short"],
      [ALICE, "refused-exhausted"],
    ]);
    store.close();
  });
});
