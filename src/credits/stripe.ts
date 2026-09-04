import { createHmac, timingSafeEqual } from "node:crypto";
import { b64urlDecode } from "../portal/token.ts";
import type { FetchLike } from "./openrouter-keys.ts";

/**
 * The two Stripe touchpoints, without the SDK.
 *
 * Webhook signature (docs.stripe.com/webhooks, "Verify manually"):
 *   header  Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…][,v0=…]
 *   signed  "<t>.<raw body>"   — the body byte-for-byte as received
 *   mac     HMAC-SHA256(endpoint secret) → hex
 *   accept  any v1 matches (constant-time) AND |now − t| ≤ tolerance (300s)
 *   ignore  every scheme that is not v1 (downgrade protection)
 * An empty secret rejects everything: an unset secret must fail closed,
 * never authenticate the world (same posture as src/sms/signature.ts).
 *
 * Checkout Session (docs.stripe.com/api/checkout/sessions/create): one
 * inline-priced line item so no Product or Price has to exist in Stripe
 * beforehand — the portal picks the amount, Stripe charges it. The session
 * key travels in `metadata` (authoritative) and `client_reference_id`
 * (Stripe's reconciliation field, alphanumerics/dash/underscore ≤ 200).
 */

export const STRIPE_SIGNATURE_TOLERANCE_S = 300;

/** "Artificial Intelligence as a Service (AIaaS) - Cloud Based - Personal
 *  Use": access to hosted AI tools such as image generators, for personal
 *  use. On Stripe's Managed Payments eligible list (verified 2026-09-02). */
export const DEFAULT_TAX_CODE = "txcd_10105001";

export function parseStripeSignature(header: string): { t: number | null; v1: string[] } {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") {
      const n = Number.parseInt(v, 10);
      t = Number.isFinite(n) ? n : null;
    } else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) {
      v1.push(v.toLowerCase());
    }
  }
  return { t, v1 };
}

export function stripeSignedPayload(timestampSec: number, rawBody: string): string {
  return `${timestampSec}.${rawBody}`;
}

export function computeStripeSignature(
  secret: string,
  timestampSec: number,
  rawBody: string,
): string {
  return createHmac("sha256", secret)
    .update(stripeSignedPayload(timestampSec, rawBody), "utf8")
    .digest("hex");
}

export type SignatureVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: "no-secret" | "no-header" | "malformed" | "stale" | "mismatch" | "zero-tolerance";
      /** Seconds between our clock and the header's timestamp (stale only). */
      skewSec?: number;
      bodyBytes?: number;
    };

/** The same check, saying WHY it failed — for the log, never the body or
 *  the secret. A run of "mismatch" with sane skew means the secret or the
 *  body bytes differ; "stale" means the clock. */
export function explainStripeSignature(p: {
  secret: string;
  header: string | null | undefined;
  rawBody: string;
  nowSec?: number;
  toleranceSec?: number;
}): SignatureVerdict {
  if (!p.secret) return { ok: false, reason: "no-secret" };
  if (!p.header) return { ok: false, reason: "no-header" };
  const { t, v1 } = parseStripeSignature(p.header);
  if (t === null || v1.length === 0) return { ok: false, reason: "malformed" };
  const now = p.nowSec ?? Math.floor(Date.now() / 1000);
  const tol = p.toleranceSec ?? STRIPE_SIGNATURE_TOLERANCE_S;
  if (tol <= 0) return { ok: false, reason: "zero-tolerance" }; // disables the replay check; refuse to run that way
  if (Math.abs(now - t) > tol) return { ok: false, reason: "stale", skewSec: now - t };
  const expected = Buffer.from(computeStripeSignature(p.secret, t, p.rawBody), "utf8");
  for (const sig of v1) {
    const got = Buffer.from(sig, "utf8");
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true };
  }
  return {
    ok: false,
    reason: "mismatch",
    skewSec: now - t,
    bodyBytes: Buffer.byteLength(p.rawBody, "utf8"),
  };
}

export function verifyStripeSignature(p: {
  secret: string;
  header: string | null | undefined;
  rawBody: string;
  nowSec?: number;
  toleranceSec?: number;
}): boolean {
  return explainStripeSignature(p).ok;
}

// ── checkout ──────────────────────────────────────────────────────

export class StripeError extends Error {
  status: number;
  constructor(op: string, status: number, body: string) {
    super(`${op} ${status}: ${body.slice(0, 300)}`);
    this.name = "StripeError";
    this.status = status;
  }
}

export async function createCheckoutSession(p: {
  secretKey: string;
  amountCents: number;
  /** Alphanumerics, dashes, underscores; ≤ 200 chars. */
  clientReferenceId: string;
  sessionKey: string;
  productName: string;
  /** An existing Stripe Product (prod_…). When set, the line item references
   *  it so every top-up rolls up under one product in Stripe's reporting;
   *  otherwise the product is described inline by name. */
  productId?: string;
  /** Stripe product tax code (txcd_…) for the inline product. Accounts on
   *  Managed Payments refuse a line item whose product has none; the
   *  default is "AI as a Service — cloud based — personal use". */
  taxCode?: string;
  successUrl: string;
  cancelUrl: string;
  fetch?: FetchLike;
}): Promise<{ id: string; url: string }> {
  if (!p.secretKey)
    throw new StripeError("createCheckoutSession", 0, "keys.stripe_secret is not set");
  if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) {
    throw new StripeError("createCheckoutSession", 0, `bad amount ${p.amountCents}`);
  }
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(p.clientReferenceId)) {
    throw new StripeError("createCheckoutSession", 0, "client_reference_id has invalid characters");
  }
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", p.successUrl);
  form.set("cancel_url", p.cancelUrl);
  form.set("client_reference_id", p.clientReferenceId);
  form.set("metadata[session_key]", p.sessionKey);
  // The PaymentIntent is what Stripe lets us SEARCH by metadata later, so
  // the tag goes there too. This is how a person's payments are found
  // every time their page opens — there is no local ledger.
  form.set("payment_intent_data[metadata][session_key]", p.sessionKey);
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", "usd");
  form.set("line_items[0][price_data][unit_amount]", String(p.amountCents));
  if (p.productId) {
    form.set("line_items[0][price_data][product]", p.productId);
  } else {
    form.set("line_items[0][price_data][product_data][name]", p.productName);
    form.set("line_items[0][price_data][product_data][tax_code]", p.taxCode ?? DEFAULT_TAX_CODE);
  }
  form.set("submit_type", "pay");
  const res = await (p.fetch ?? fetch)("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${p.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new StripeError("createCheckoutSession", res.status, text);
  const json = JSON.parse(text) as { id?: string; url?: string };
  if (!json.id || !json.url) {
    throw new StripeError("createCheckoutSession", res.status, "response had no id/url");
  }
  return { id: json.id, url: json.url };
}

// ── events ────────────────────────────────────────────────────────

export type CheckoutCompleted = {
  /** The Stripe event id (`evt_…`), or `cs:<session>` when reconciled by
   *  polling rather than delivered by webhook. */
  eventId: string;
  checkoutSessionId: string;
  clientReferenceId: string | null;
  sessionKeyFromMetadata: string | null;
  /** What left the card, tax included. */
  amountTotalCents: number;
  /** The price before tax — what the credit is computed on. On Managed
   *  Payments Stripe adds and remits sales tax, so total > subtotal. */
  amountSubtotalCents: number;
  currency: string;
  paid: boolean;
};

/** The fields we act on, from a Checkout Session object (a webhook's
 *  `data.object`, or an item from `GET /v1/checkout/sessions`). */
export function checkoutFromSession(
  obj: Record<string, unknown>,
  eventId: string,
): CheckoutCompleted | null {
  if (typeof obj.id !== "string") return null;
  const meta = (obj.metadata ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    eventId,
    checkoutSessionId: obj.id,
    clientReferenceId: typeof obj.client_reference_id === "string" ? obj.client_reference_id : null,
    sessionKeyFromMetadata: typeof meta.session_key === "string" ? meta.session_key : null,
    amountTotalCents: num(obj.amount_total),
    amountSubtotalCents: num(obj.amount_subtotal),
    currency: typeof obj.currency === "string" ? obj.currency.toLowerCase() : "",
    paid: obj.payment_status === "paid",
  };
}

/** Pull the fields we act on out of a `checkout.session.completed` event.
 *  Null for any other event type or a malformed body. */
export function parseCheckoutCompleted(body: unknown): CheckoutCompleted | null {
  if (!body || typeof body !== "object") return null;
  const ev = body as {
    id?: unknown;
    type?: unknown;
    data?: { object?: Record<string, unknown> };
  };
  if (ev.type !== "checkout.session.completed" || typeof ev.id !== "string") return null;
  const obj = ev.data?.object;
  if (!obj) return null;
  return checkoutFromSession(obj, ev.id);
}

const WALLET_KEY_RE = /^imessage:dm:.+/;

/** Which wallet a checkout belongs to: `metadata.session_key` is
 *  authoritative; `client_reference_id` (the portal's b64url encoding of the
 *  same key) is the fallback. Null when neither names a DM wallet. */
export function sessionKeyFromCheckout(ev: CheckoutCompleted): string | null {
  const fromMeta = ev.sessionKeyFromMetadata;
  if (fromMeta && WALLET_KEY_RE.test(fromMeta)) return fromMeta;
  if (ev.clientReferenceId) {
    const decoded = b64urlDecode(ev.clientReferenceId);
    if (decoded && WALLET_KEY_RE.test(decoded)) return decoded;
  }
  return null;
}

export function stripeEventType(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const t = (body as { type?: unknown }).type;
  return typeof t === "string" ? t : null;
}
