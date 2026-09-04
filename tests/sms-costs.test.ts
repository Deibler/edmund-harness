import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateInboundUsd, estimateOutboundUsd, reconcileSmsCosts } from "../src/sms/costs.ts";
import { SmsStore } from "../src/sms/store.ts";
import { SpendLedger } from "../src/spend/ledger.ts";

const CREDS = { accountSid: "ACtest", keySid: "SKtest", keySecret: "s" };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function scratch() {
  return mkdtempSync(join(tmpdir(), "sms-costs-"));
}

function stubMessages(messages: unknown[]) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ messages }), { status: 200 })) as typeof fetch;
}

describe("estimates", () => {
  test("scale with segments and floor at one", () => {
    expect(estimateOutboundUsd(1)).toBeCloseTo(0.0109, 4);
    expect(estimateOutboundUsd(3)).toBeCloseTo(0.0327, 4);
    expect(estimateOutboundUsd(0)).toBeCloseTo(0.0109, 4);
  });
  test("mms inbound costs more than sms inbound", () => {
    expect(estimateInboundUsd("mms")).toBeGreaterThan(estimateInboundUsd("sms"));
  });
});

describe("spend ledger", () => {
  test("record, reconcile, summarize — estimate falls back until price posts", () => {
    const store = new SmsStore(scratch());
    store.recordSpend({
      messageSid: "SMa",
      direction: "out",
      counterparty: "+15551230001",
      segments: 1,
      estUsd: 0.011,
    });
    store.recordSpend({
      messageSid: "SMb",
      direction: "in",
      counterparty: "+15551230001",
      segments: 1,
      estUsd: 0.0075,
    });
    let s = store.spendSummary(0);
    expect(s.outCount).toBe(1);
    expect(s.inCount).toBe(1);
    expect(s.unreconciled).toBe(2);
    expect(s.totalUsd).toBeCloseTo(0.0185, 4);
    store.reconcileSpend("SMa", 0.0079);
    s = store.spendSummary(0);
    expect(s.unreconciled).toBe(1);
    expect(s.totalUsd).toBeCloseTo(0.0079 + 0.0075, 4);
    store.close();
  });

  test("duplicate recordSpend for one sid is a no-op", () => {
    const store = new SmsStore(scratch());
    store.recordSpend({
      messageSid: "SMx",
      direction: "out",
      counterparty: "+1555",
      segments: 1,
      estUsd: 0.011,
    });
    store.recordSpend({
      messageSid: "SMx",
      direction: "out",
      counterparty: "+1555",
      segments: 1,
      estUsd: 0.011,
    });
    expect(store.spendSummary(0).outCount).toBe(1);
    store.close();
  });
});

describe("reconciler", () => {
  const msg = (over: Record<string, unknown> = {}) => ({
    sid: "SMchild1",
    direction: "outbound-api",
    from: "+15550100000",
    to: "+15551230001",
    price: null,
    num_segments: "1",
    date_created: new Date().toISOString(),
    status: "delivered",
    ...over,
  });

  test("discovers fan-out children it never saw, then prices them on the next pass", async () => {
    const dir = scratch();
    const store = new SmsStore(dir);
    stubMessages([msg()]);
    let r = await reconcileSmsCosts({
      creds: CREDS,
      store,
      dataDir: dir,
      ownNumber: "+15550100000",
    });
    expect(r).toEqual({ reconciled: 0, discovered: 1, pendingPrice: 1 });
    // price posts (negative, as Twilio reports charges)
    stubMessages([msg({ price: "-0.00790" })]);
    r = await reconcileSmsCosts({ creds: CREDS, store, dataDir: dir, ownNumber: "+15550100000" });
    expect(r).toEqual({ reconciled: 1, discovered: 0, pendingPrice: 0 });
    expect(store.spendRow("SMchild1")!.actualUsd).toBeCloseTo(0.0079, 5);
    store.close();
  });

  test("the sign is dropped and spend.db receives the ACTUAL, once", async () => {
    const dir = scratch();
    const store = new SmsStore(dir);
    stubMessages([msg({ sid: "SMonce", price: "-0.01100" })]);
    await reconcileSmsCosts({ creds: CREDS, store, dataDir: dir, ownNumber: "+15550100000" });
    // second sweep with same data must not double-book spend.db
    stubMessages([msg({ sid: "SMonce", price: "-0.01100" })]);
    await reconcileSmsCosts({ creds: CREDS, store, dataDir: dir, ownNumber: "+15550100000" });
    const ledger = new SpendLedger(dir);
    const sms = ledger.daily(1).filter((r) => r.subsystem === "sms");
    expect(sms.length).toBe(1);
    expect(sms[0]!.turns).toBe(1);
    expect(sms[0]!.costUsd).toBeCloseTo(0.011, 5);
    expect(ledger.totalCostFor("sms")).toBeCloseTo(0.011, 5);
    store.close();
  });

  test("inbound rows attribute the counterparty as the sender", async () => {
    const dir = scratch();
    const store = new SmsStore(dir);
    stubMessages([
      msg({
        sid: "MMin1",
        direction: "inbound",
        from: "+15551230001",
        to: "+15550100000",
        price: "-0.0150",
      }),
    ]);
    const r = await reconcileSmsCosts({
      creds: CREDS,
      store,
      dataDir: dir,
      ownNumber: "+15550100000",
    });
    expect(r!.discovered).toBe(1);
    expect(r!.reconciled).toBe(1);
    const s = store.spendSummary(0);
    expect(s.inCount).toBe(1);
    expect(s.totalUsd).toBeCloseTo(0.015, 4);
    store.close();
  });

  test("a failed sweep returns null and books nothing", async () => {
    const dir = scratch();
    const store = new SmsStore(dir);
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const r = await reconcileSmsCosts({
      creds: CREDS,
      store,
      dataDir: dir,
      ownNumber: "+15550100000",
    });
    expect(r).toBe(null);
    expect(store.spendSummary(0).inCount + store.spendSummary(0).outCount).toBe(0);
    store.close();
  });
});
