import { describe, expect, test } from "bun:test";
import { creditedUsdFor, retrieveCheckoutSession, stripeCreditFor } from "../src/credits/ledger.ts";

const DM = "imessage:dm:+15551230001";

/** A fake Stripe: PaymentIntent search + Checkout Session lookups. */
function fakeStripe(p: {
  intents: Array<{ id: string; created: number; amount: number; status?: string }>;
  sessions: Record<
    string,
    { id: string; amount_subtotal: number; amount_total: number; payment_status?: string }
  >;
}) {
  const urls: string[] = [];
  const f = (async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("/payment_intents/search")) {
      return new Response(
        JSON.stringify({
          data: p.intents.map((i) => ({
            id: i.id,
            created: i.created,
            amount: i.amount,
            amount_received: i.amount,
            currency: "usd",
            status: i.status ?? "succeeded",
          })),
        }),
      );
    }
    const byPi = u.match(/checkout\/sessions\?payment_intent=([^&]+)/);
    if (byPi) {
      const s = Object.values(p.sessions).find(
        (x) => (x as { pi?: string }).pi === decodeURIComponent(byPi[1]!),
      );
      return new Response(JSON.stringify({ data: s ? [s] : [] }));
    }
    if (u.includes("/charges?payment_intent=")) {
      return new Response(
        JSON.stringify({
          data: [{ id: "ch_1", receipt_url: "https://pay.stripe.com/receipts/r1" }],
        }),
      );
    }
    if (u.includes("/invoices/")) {
      return new Response(
        JSON.stringify({
          id: "in_1",
          invoice_pdf: "https://pay.stripe.com/invoice/i1/pdf",
          hosted_invoice_url: "https://invoice.stripe.com/i/i1",
        }),
      );
    }
    const byId = u.match(/checkout\/sessions\/([^?]+)$/);
    if (byId) {
      const s = p.sessions[decodeURIComponent(byId[1]!)];
      return s ? new Response(JSON.stringify(s)) : new Response("nf", { status: 404 });
    }
    return new Response("nf", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, urls };
}

describe("credit math", () => {
  test("cents × ratio, rounded to a cent", () => {
    expect(creditedUsdFor(1000, 0.9)).toBe(9);
    expect(creditedUsdFor(500, 0.9)).toBe(4.5);
    expect(creditedUsdFor(333, 0.9)).toBe(3);
  });
});

describe("stripeCreditFor", () => {
  test("searches by the session tag and credits the pre-tax subtotal", async () => {
    const st = fakeStripe({
      intents: [{ id: "pi_1", created: 1000, amount: 530 }],
      sessions: {
        cs_1: {
          id: "cs_1",
          amount_subtotal: 500,
          amount_total: 530,
          ...({ pi: "pi_1" } as object),
        },
      },
    });
    const r = await stripeCreditFor({ secret: "sk", sessionKey: DM, ratio: 0.9, fetch: st.fetch });
    expect(st.urls[0]).toContain("/payment_intents/search?query=");
    expect(decodeURIComponent(st.urls[0]!)).toContain(`metadata['session_key']:'${DM}'`);
    expect(r.payments).toHaveLength(1);
    expect(r.payments[0]!.paidCents).toBe(530);
    expect(r.payments[0]!.subtotalCents).toBe(500);
    expect(r.payments[0]!.creditedUsd).toBe(4.5);
    expect(r.payments[0]!.checkoutSession).toBe("cs_1");
    expect(r.totalPaidCents).toBe(530);
    expect(r.totalCreditedUsd).toBe(4.5);
  });

  test("a payment search has not indexed yet is merged from `known`, and not doubled once it is", async () => {
    const known = {
      checkoutSession: "cs_new",
      paymentIntent: "pi_new",
      createdMs: 5000,
      paidCents: 1060,
      subtotalCents: 1000,
      currency: "usd",
    };
    const lagging = fakeStripe({ intents: [], sessions: {} });
    const r1 = await stripeCreditFor({
      secret: "sk",
      sessionKey: DM,
      ratio: 0.9,
      known: [known],
      fetch: lagging.fetch,
    });
    expect(r1.payments.map((p) => p.paymentIntent)).toEqual(["pi_new"]);
    expect(r1.totalCreditedUsd).toBe(9);

    const indexed = fakeStripe({
      intents: [{ id: "pi_new", created: 5, amount: 1060 }],
      sessions: {
        cs_new: {
          id: "cs_new",
          amount_subtotal: 1000,
          amount_total: 1060,
          ...({ pi: "pi_new" } as object),
        },
      },
    });
    const r2 = await stripeCreditFor({
      secret: "sk",
      sessionKey: DM,
      ratio: 0.9,
      known: [known],
      fetch: indexed.fetch,
    });
    expect(r2.payments).toHaveLength(1);
    expect(r2.totalCreditedUsd).toBe(9);
  });

  test("receipt and invoice links come along when asked for", async () => {
    const st = fakeStripe({
      intents: [{ id: "pi_1", created: 1000, amount: 530 }],
      sessions: {
        cs_1: {
          id: "cs_1",
          amount_subtotal: 500,
          amount_total: 530,
          ...({ pi: "pi_1", invoice: "in_1" } as object),
        },
      },
    });
    const withR = await stripeCreditFor({
      secret: "sk",
      sessionKey: DM,
      ratio: 0.9,
      withReceipts: true,
      fetch: st.fetch,
    });
    expect(withR.payments[0]!.receiptUrl).toBe("https://pay.stripe.com/receipts/r1");
    expect(withR.payments[0]!.invoicePdfUrl).toBe("https://pay.stripe.com/invoice/i1/pdf");
    expect(withR.payments[0]!.invoiceUrl).toBe("https://invoice.stripe.com/i/i1");
    const without = await stripeCreditFor({
      secret: "sk",
      sessionKey: DM,
      ratio: 0.9,
      fetch: st.fetch,
    });
    expect(without.payments[0]!.receiptUrl).toBeNull();
    expect(st.urls.filter((u) => u.includes("/charges")).length).toBe(1); // only the withReceipts call asked
  });

  test("falls back to the tax-inclusive amount when the session cannot be found", async () => {
    const st = fakeStripe({ intents: [{ id: "pi_x", created: 1, amount: 700 }], sessions: {} });
    const r = await stripeCreditFor({ secret: "sk", sessionKey: DM, ratio: 0.9, fetch: st.fetch });
    expect(r.payments[0]!.subtotalCents).toBe(700);
    expect(r.payments[0]!.creditedUsd).toBe(6.3);
  });

  test("retrieveCheckoutSession returns null for an unpaid session", async () => {
    const st = fakeStripe({
      intents: [],
      sessions: {
        cs_p: { id: "cs_p", amount_subtotal: 500, amount_total: 530, payment_status: "paid" },
        cs_u: { id: "cs_u", amount_subtotal: 500, amount_total: 500, payment_status: "unpaid" },
      },
    });
    const paid = await retrieveCheckoutSession({ secret: "sk", id: "cs_p", fetch: st.fetch });
    expect(paid?.subtotalCents).toBe(500);
    expect(paid?.paidCents).toBe(530);
    expect(await retrieveCheckoutSession({ secret: "sk", id: "cs_u", fetch: st.fetch })).toBeNull();
  });
});
