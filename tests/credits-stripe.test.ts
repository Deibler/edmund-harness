import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  computeStripeSignature,
  createCheckoutSession,
  parseCheckoutCompleted,
  parseStripeSignature,
  verifyStripeSignature,
} from "../src/credits/stripe.ts";

const SECRET = "whsec_test_secret_value";
const BODY = '{"id":"evt_1","object":"event","type":"checkout.session.completed"}';
const T = 1_700_000_000;

// The documented scheme, computed independently here rather than through
// the module under test, so a wrong implementation cannot agree with itself.
function docSignature(secret: string, t: number, body: string): string {
  return createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
}

describe("stripe signature", () => {
  test("implements HMAC-SHA256 over `t.body` exactly as documented", () => {
    expect(computeStripeSignature(SECRET, T, BODY)).toBe(docSignature(SECRET, T, BODY));
  });

  test("parses t and every v1, ignoring v0 and junk", () => {
    const h = `t=${T},v1=${"a".repeat(64)},v0=${"b".repeat(64)},v1=${"c".repeat(64)},x=1`;
    expect(parseStripeSignature(h)).toEqual({ t: T, v1: ["a".repeat(64), "c".repeat(64)] });
  });

  const header = (over: Partial<{ t: number; sig: string; secret: string }> = {}) => {
    const t = over.t ?? T;
    const sig = over.sig ?? docSignature(over.secret ?? SECRET, t, BODY);
    return `t=${t},v1=${sig}`;
  };

  test("accepts a valid signature inside the tolerance window", () => {
    expect(
      verifyStripeSignature({ secret: SECRET, header: header(), rawBody: BODY, nowSec: T + 100 }),
    ).toBe(true);
  });

  test("accepts when any one of several v1 values matches (secret roll)", () => {
    const h = `t=${T},v1=${"0".repeat(64)},v1=${docSignature(SECRET, T, BODY)}`;
    expect(verifyStripeSignature({ secret: SECRET, header: h, rawBody: BODY, nowSec: T })).toBe(
      true,
    );
  });

  test("rejects the wrong secret", () => {
    expect(
      verifyStripeSignature({
        secret: SECRET,
        header: header({ secret: "whsec_other" }),
        rawBody: BODY,
        nowSec: T,
      }),
    ).toBe(false);
  });

  test("rejects a body that changed after signing", () => {
    expect(
      verifyStripeSignature({ secret: SECRET, header: header(), rawBody: `${BODY} `, nowSec: T }),
    ).toBe(false);
  });

  test("rejects a timestamp outside the tolerance (replay)", () => {
    expect(
      verifyStripeSignature({ secret: SECRET, header: header(), rawBody: BODY, nowSec: T + 301 }),
    ).toBe(false);
    expect(
      verifyStripeSignature({ secret: SECRET, header: header(), rawBody: BODY, nowSec: T - 301 }),
    ).toBe(false);
  });

  test("rejects a header with only v0, no header, or an unset secret", () => {
    const v0 = `t=${T},v0=${docSignature(SECRET, T, BODY)}`;
    expect(verifyStripeSignature({ secret: SECRET, header: v0, rawBody: BODY, nowSec: T })).toBe(
      false,
    );
    expect(verifyStripeSignature({ secret: SECRET, header: null, rawBody: BODY, nowSec: T })).toBe(
      false,
    );
    expect(verifyStripeSignature({ secret: "", header: header(), rawBody: BODY, nowSec: T })).toBe(
      false,
    );
  });

  test("a zero tolerance is refused rather than disabling the replay check", () => {
    expect(
      verifyStripeSignature({
        secret: SECRET,
        header: header(),
        rawBody: BODY,
        nowSec: T,
        toleranceSec: 0,
      }),
    ).toBe(false);
  });
});

describe("checkout.session.completed parsing", () => {
  const event = {
    id: "evt_123",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_abc",
        object: "checkout.session",
        amount_total: 1000,
        currency: "usd",
        payment_status: "paid",
        client_reference_id: "aW1lc3NhZ2U6ZG06KzE1NTUxMjMwMDAx",
        metadata: { session_key: "imessage:dm:+15551230001" },
      },
    },
  };

  test("extracts the fields we act on", () => {
    expect(parseCheckoutCompleted(event)).toEqual({
      eventId: "evt_123",
      checkoutSessionId: "cs_test_abc",
      clientReferenceId: "aW1lc3NhZ2U6ZG06KzE1NTUxMjMwMDAx",
      sessionKeyFromMetadata: "imessage:dm:+15551230001",
      amountTotalCents: 1000,
      amountSubtotalCents: 0,
      currency: "usd",
      paid: true,
    });
  });

  test("other event types and malformed bodies are null", () => {
    expect(parseCheckoutCompleted({ ...event, type: "charge.refunded" })).toBeNull();
    expect(
      parseCheckoutCompleted({ id: "evt_1", type: "checkout.session.completed", data: {} }),
    ).toBeNull();
    expect(parseCheckoutCompleted(null)).toBeNull();
    expect(parseCheckoutCompleted("str")).toBeNull();
  });

  test("an unpaid session parses as paid=false", () => {
    const unpaid = {
      ...event,
      data: { object: { ...event.data.object, payment_status: "unpaid" } },
    };
    expect(parseCheckoutCompleted(unpaid)?.paid).toBe(false);
  });
});

describe("createCheckoutSession", () => {
  test("posts one inline-priced line item with the session key in metadata and reference", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init: init ?? {} };
      return new Response(
        JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" }),
        {
          status: 200,
        },
      );
    }) as typeof fetch;
    const r = await createCheckoutSession({
      secretKey: "sk_test_x",
      amountCents: 1000,
      clientReferenceId: "aW1lc3NhZ2U6ZG06KzE1NTUxMjMwMDAx",
      sessionKey: "imessage:dm:+15551230001",
      productName: "Edmund generation credit",
      successUrl: "https://p.example/u/k/t?paid=1#credits",
      cancelUrl: "https://p.example/u/k/t#credits",
      fetch: fetchStub,
    });
    expect(r).toEqual({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });
    const s = seen!;
    expect(s.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect((s.init.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_x");
    const form = new URLSearchParams(String(s.init.body));
    expect(form.get("mode")).toBe("payment");
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("1000");
    expect(form.get("line_items[0][price_data][currency]")).toBe("usd");
    expect(form.get("line_items[0][quantity]")).toBe("1");
    expect(form.get("metadata[session_key]")).toBe("imessage:dm:+15551230001");
    expect(form.get("client_reference_id")).toBe("aW1lc3NhZ2U6ZG06KzE1NTUxMjMwMDAx");
    expect(form.get("success_url")).toBe("https://p.example/u/k/t?paid=1#credits");
    // Managed Payments refuses an inline product with no tax code
    expect(form.get("line_items[0][price_data][product_data][tax_code]")).toBe("txcd_10105001");
    // the PaymentIntent carries the tag too — it is what Stripe lets us search by later
    expect(form.get("payment_intent_data[metadata][session_key]")).toBe("imessage:dm:+15551230001");
  });

  test("references an existing Stripe Product when one is configured", async () => {
    let body = "";
    const fetchStub = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(
        JSON.stringify({ id: "cs_2", url: "https://checkout.stripe.com/c/pay/cs_2" }),
      );
    }) as typeof fetch;
    await createCheckoutSession({
      secretKey: "sk_test_x",
      amountCents: 500,
      clientReferenceId: "ref",
      sessionKey: "imessage:dm:+15551230001",
      productName: "ignored when a product id is set",
      productId: "prod_123",
      successUrl: "https://a",
      cancelUrl: "https://b",
      fetch: fetchStub,
    });
    const form = new URLSearchParams(body);
    expect(form.get("line_items[0][price_data][product]")).toBe("prod_123");
    expect(form.get("line_items[0][price_data][product_data][name]")).toBeNull();
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("500");
  });

  test("refuses a bad amount or reference before calling Stripe", async () => {
    const never = (async () => {
      throw new Error("must not be called");
    }) as typeof fetch;
    const base = {
      secretKey: "sk_test_x",
      sessionKey: "k",
      productName: "x",
      successUrl: "https://a",
      cancelUrl: "https://b",
      fetch: never,
    };
    await expect(
      createCheckoutSession({ ...base, amountCents: 0, clientReferenceId: "ok" }),
    ).rejects.toThrow(/bad amount/);
    await expect(
      createCheckoutSession({ ...base, amountCents: 500, clientReferenceId: "has:colon" }),
    ).rejects.toThrow(/invalid characters/);
    await expect(
      createCheckoutSession({ ...base, secretKey: "", amountCents: 500, clientReferenceId: "ok" }),
    ).rejects.toThrow(/stripe_secret/);
  });
});
