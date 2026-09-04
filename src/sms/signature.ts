import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Twilio request-signature validation.
 *
 * This is the ONLY thing standing between the public webhook and anyone who
 * knows the URL. Without it, a stranger can POST a crafted form body and make
 * Edmund believe a trusted contact texted him — which reaches the model, the
 * persona files, and the reply path. Treat a validation failure as hostile,
 * not as a bug to work around.
 *
 * The scheme (X-Twilio-Signature):
 *   1. Take the full request URL exactly as Twilio called it, including query.
 *   2. Append every POST parameter, sorted by key, as key + value with no
 *      separators at all.
 *   3. HMAC-SHA1 that string with the account's AUTH TOKEN (never an API key
 *      secret — an API key cannot sign, and using one silently fails every
 *      request), then base64.
 *
 * The URL must match what Twilio used byte for byte. Behind a tunnel or proxy
 * the locally-observed URL is usually `http://127.0.0.1:port/...`, which will
 * NOT match; `publicUrlFor` rebuilds it from the configured public base so the
 * comparison is against the address Twilio actually dialed.
 */

/** Rebuild the URL Twilio signed, from the configured public base + path. */
export function publicUrlFor(publicBase: string, path: string, query?: string): string {
  const base = publicBase.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  const q = query ? (query.startsWith("?") ? query : `?${query}`) : "";
  return `${base}${p}${q}`;
}

/** The exact string Twilio HMACs: URL followed by sorted key+value pairs. */
export function signatureBase(url: string, params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  let s = url;
  for (const k of keys) s += k + (params[k] ?? "");
  return s;
}

/** Compute the expected base64 signature for a request. */
export function computeSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  return createHmac("sha1", authToken).update(signatureBase(url, params), "utf8").digest("base64");
}

/**
 * Constant-time validation of a received `X-Twilio-Signature`.
 *
 * Returns false rather than throwing for every failure mode — a missing
 * header, a malformed base64 value, a length mismatch — so a caller can treat
 * "not valid" uniformly and never has to decide which exception means
 * "reject". An empty auth token is always invalid: an unset secret must fail
 * closed, never authenticate everything.
 */
export function validateTwilioSignature(params: {
  authToken: string;
  url: string;
  params: Record<string, string>;
  signature: string | null | undefined;
}): boolean {
  const { authToken, url, signature } = params;
  if (!authToken || !signature) return false;
  const expected = computeSignature(authToken, url, params.params);
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(expected, "base64");
    b = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  // timingSafeEqual throws on length mismatch, which would leak length via the
  // exception path; compare lengths first and still use the safe compare after.
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
