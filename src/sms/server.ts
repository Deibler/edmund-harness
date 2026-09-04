import { log } from "../util/log.ts";
import { publicUrlFor, validateTwilioSignature } from "./signature.ts";

/**
 * The daemon's SMS webhook listener.
 *
 * Loopback-only by construction — the only route in from outside is the
 * named Cloudflare tunnel pointed at this port, the same posture as the
 * dashboard's public listener. Twilio's calls arrive here as form-encoded
 * POSTs carrying X-Twilio-Signature, and every request is validated before a
 * byte of it is believed. An invalid signature is answered 403 and logged:
 * on a public URL that is either misconfiguration (wrong auth token, wrong
 * public_base_url) or someone knocking, and both deserve a log line.
 *
 * Responses are fast and empty (204). Twilio retries non-2xx quickly, and
 * the actual work — classification, consent, the model turn — happens after
 * the claim, so a slow model can never cause a webhook retry storm. The
 * handler is awaited only up to the enqueue.
 */
export type SmsServerOpts = {
  port: number;
  /** Auth token used to validate signatures. null = validation impossible;
   *  every request is rejected (fail closed, loudly). */
  authToken: string | null;
  /** Public origin Twilio dials. A function when the origin is a rotating
   *  quick tunnel — read per request so validation always compares against
   *  the URL Twilio was most recently pointed at. */
  publicBaseUrl: string | null | (() => string | null);
  onConversationMessage: (params: Record<string, string>) => Promise<void>;
  onStatus?: (params: Record<string, string>) => void;
};

export function startSmsServer(opts: SmsServerOpts): { stop: () => void; port: number } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/sms/health") {
        return new Response("ok", { status: 200 });
      }
      if (req.method !== "POST") return new Response("not found", { status: 404 });

      const params = await formParams(req);
      if (!validate(req, url, params, opts)) {
        log.warn("sms", "webhook signature rejected", { path: url.pathname });
        return new Response("forbidden", { status: 403 });
      }

      switch (url.pathname) {
        case "/sms/conversations": {
          try {
            await opts.onConversationMessage(params);
          } catch (err) {
            // Swallow after logging: a thrown handler would 500 and invite a
            // Twilio retry of a message we may have half-processed.
            log.warn("sms", "conversation handler failed", { err: String(err) });
          }
          return new Response(null, { status: 204 });
        }
        case "/sms/status": {
          opts.onStatus?.(params);
          return new Response(null, { status: 204 });
        }
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  const baseNow =
    typeof opts.publicBaseUrl === "function" ? opts.publicBaseUrl() : opts.publicBaseUrl;
  log.info("sms", `webhook listener on 127.0.0.1:${opts.port}`, {
    publicBase: baseNow ?? "(unset — signatures cannot validate)",
  });
  return { stop: () => server.stop(), port: opts.port };
}

async function formParams(req: Request): Promise<Record<string, string>> {
  const text = await req.text();
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(text)) out[k] = v;
  return out;
}

function validate(
  req: Request,
  url: URL,
  params: Record<string, string>,
  opts: SmsServerOpts,
): boolean {
  // Missing token or base URL = validation impossible = reject everything.
  // Fail closed: an unvalidatable inbound channel to the model is not a
  // degraded mode, it is an open door.
  const base = typeof opts.publicBaseUrl === "function" ? opts.publicBaseUrl() : opts.publicBaseUrl;
  if (!opts.authToken || !base) return false;
  return validateTwilioSignature({
    authToken: opts.authToken,
    url: publicUrlFor(base, url.pathname, url.search || undefined),
    params,
    signature: req.headers.get("X-Twilio-Signature"),
  });
}
