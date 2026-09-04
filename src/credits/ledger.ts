import type { FetchLike } from "./openrouter-keys.ts";
import { StripeError } from "./stripe.ts";

/**
 * Stripe IS the payment ledger. Nothing about money is written locally:
 * every time a person opens their page, or Edmund is about to generate for
 * them, we ask Stripe what they have paid. The one thing that has to be
 * stable for that to work is the tag on each payment — `metadata.session_key`
 * on the Checkout Session and on its PaymentIntent (set at checkout
 * creation) — because PaymentIntents are what Stripe lets us search.
 *
 * Search indexing lags a little (Stripe says up to a minute), so a caller
 * that has JUST learned of a payment — the webhook — passes it in as
 * `known` and it is merged if search has not caught up yet.
 *
 * Receipts are Stripe's too: the charge's `receipt_url`, and the invoice
 * PDF when the checkout produced one (Managed Payments does).
 */

const API = "https://api.stripe.com/v1";

export type StripePayment = {
  paymentIntent: string;
  checkoutSession: string | null;
  createdMs: number;
  /** What left the card, tax included. */
  paidCents: number;
  /** The price before tax — the credit basis. Falls back to paidCents when
   *  the Checkout Session cannot be found. */
  subtotalCents: number;
  creditedUsd: number;
  currency: string;
  /** Stripe-hosted receipt for the charge, when there is one. */
  receiptUrl: string | null;
  /** Invoice PDF and hosted page, when the checkout created an invoice. */
  invoicePdfUrl: string | null;
  invoiceUrl: string | null;
};

export type StripeCredit = {
  payments: StripePayment[];
  totalPaidCents: number;
  totalCreditedUsd: number;
};

export type KnownSession = {
  checkoutSession: string;
  paymentIntent: string | null;
  createdMs: number;
  paidCents: number;
  subtotalCents: number;
  currency: string;
};

export function creditedUsdFor(cents: number, ratio: number): number {
  return Math.round(cents * ratio) / 100;
}

async function stripeGet<T>(secret: string, path: string, f: FetchLike): Promise<T> {
  const res = await f(`${API}${path}`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new StripeError(`GET ${path.split("?")[0]}`, res.status, text);
  return JSON.parse(text) as T;
}

type RawIntent = {
  id: string;
  created: number;
  amount_received?: number;
  amount?: number;
  currency?: string;
  status?: string;
  latest_charge?: string | { id: string; receipt_url?: string | null } | null;
};
type RawSession = {
  id: string;
  amount_subtotal?: number;
  amount_total?: number;
  payment_status?: string;
  payment_intent?: string | null;
  invoice?: string | null;
  currency?: string;
  created?: number;
};
type RawCharge = { id: string; receipt_url?: string | null };
type RawInvoice = { id: string; invoice_pdf?: string | null; hosted_invoice_url?: string | null };

/** Every succeeded payment tagged with this session key, straight from
 *  Stripe. `withReceipts: true` also fetches each payment's receipt and
 *  invoice links (the portal wants them; the sync before a generation does
 *  not pay for them). */
export async function stripeCreditFor(p: {
  secret: string;
  sessionKey: string;
  ratio: number;
  known?: KnownSession[];
  withReceipts?: boolean;
  fetch?: FetchLike;
}): Promise<StripeCredit> {
  const f = p.fetch ?? fetch;
  const q = encodeURIComponent(`metadata['session_key']:'${p.sessionKey}' AND status:'succeeded'`);
  const search = await stripeGet<{ data?: RawIntent[] }>(
    p.secret,
    `/payment_intents/search?query=${q}&limit=100`,
    f,
  );
  const payments: StripePayment[] = [];
  const seenSessions = new Set<string>();
  for (const pi of search.data ?? []) {
    if (pi.status !== "succeeded") continue;
    const paid = pi.amount_received ?? pi.amount ?? 0;
    // The pre-tax price and the invoice live on the Checkout Session; one
    // lookup per payment.
    let subtotal = paid;
    let session: string | null = null;
    let invoiceId: string | null = null;
    try {
      const s = await stripeGet<{ data?: RawSession[] }>(
        p.secret,
        `/checkout/sessions?payment_intent=${encodeURIComponent(pi.id)}&limit=1`,
        f,
      );
      const cs = s.data?.[0];
      if (cs) {
        session = cs.id;
        if (typeof cs.amount_subtotal === "number") subtotal = cs.amount_subtotal;
        invoiceId = typeof cs.invoice === "string" ? cs.invoice : null;
      }
    } catch {
      // keep the tax-inclusive amount rather than fail the whole read
    }
    let receiptUrl: string | null = null;
    let invoicePdfUrl: string | null = null;
    let invoiceUrl: string | null = null;
    if (p.withReceipts) {
      try {
        const ch = await stripeGet<{ data?: RawCharge[] }>(
          p.secret,
          `/charges?payment_intent=${encodeURIComponent(pi.id)}&limit=1`,
          f,
        );
        receiptUrl = ch.data?.[0]?.receipt_url ?? null;
      } catch {
        // a missing receipt link is not a missing payment
      }
      if (invoiceId) {
        try {
          const inv = await stripeGet<RawInvoice>(
            p.secret,
            `/invoices/${encodeURIComponent(invoiceId)}`,
            f,
          );
          invoicePdfUrl = inv.invoice_pdf ?? null;
          invoiceUrl = inv.hosted_invoice_url ?? null;
        } catch {
          // same
        }
      }
    }
    if (session) seenSessions.add(session);
    payments.push({
      paymentIntent: pi.id,
      checkoutSession: session,
      createdMs: pi.created * 1000,
      paidCents: paid,
      subtotalCents: subtotal,
      creditedUsd: creditedUsdFor(subtotal, p.ratio),
      currency: (pi.currency ?? "usd").toLowerCase(),
      receiptUrl,
      invoicePdfUrl,
      invoiceUrl,
    });
  }
  // A payment we were just told about that search has not indexed yet.
  for (const k of p.known ?? []) {
    if (seenSessions.has(k.checkoutSession)) continue;
    if (k.paymentIntent && payments.some((x) => x.paymentIntent === k.paymentIntent)) continue;
    payments.push({
      paymentIntent: k.paymentIntent ?? `pending:${k.checkoutSession}`,
      checkoutSession: k.checkoutSession,
      createdMs: k.createdMs,
      paidCents: k.paidCents,
      subtotalCents: k.subtotalCents,
      creditedUsd: creditedUsdFor(k.subtotalCents, p.ratio),
      currency: k.currency,
      receiptUrl: null,
      invoicePdfUrl: null,
      invoiceUrl: null,
    });
  }
  payments.sort((a, b) => b.createdMs - a.createdMs);
  const usd = payments.filter((x) => x.currency === "usd");
  return {
    payments,
    totalPaidCents: usd.reduce((n, x) => n + x.paidCents, 0),
    totalCreditedUsd: Math.round(usd.reduce((n, x) => n + x.creditedUsd, 0) * 100) / 100,
  };
}

/** One Checkout Session by id — how the webhook confirms what it was told
 *  before acting on it. */
export async function retrieveCheckoutSession(p: {
  secret: string;
  id: string;
  fetch?: FetchLike;
}): Promise<KnownSession | null> {
  const s = await stripeGet<RawSession>(
    p.secret,
    `/checkout/sessions/${encodeURIComponent(p.id)}`,
    p.fetch ?? fetch,
  );
  if (s.payment_status !== "paid") return null;
  const paid = s.amount_total ?? 0;
  return {
    checkoutSession: s.id,
    paymentIntent: typeof s.payment_intent === "string" ? s.payment_intent : null,
    createdMs: (s.created ?? Math.floor(Date.now() / 1000)) * 1000,
    paidCents: paid,
    subtotalCents: typeof s.amount_subtotal === "number" ? s.amount_subtotal : paid,
    currency: (s.currency ?? "usd").toLowerCase(),
  };
}
