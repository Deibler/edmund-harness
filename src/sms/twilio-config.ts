import { log } from "../util/log.ts";
import type { TwilioCreds } from "./client.ts";

/**
 * Keeps Twilio pointed at us — the self-healing half of the quick-tunnel
 * design.
 *
 * The webhook origin is a TryCloudflare quick tunnel, which rotates its
 * hostname every time the runner restarts. A statically configured webhook
 * would go stale the first time that happens and inbound SMS would die
 * silently — the exact failure the kitchen tunnel already taught us
 * ("verify with curl, the URL file lies"). So instead of asking a human to
 * keep Twilio current, the daemon re-points it: on boot and on every change
 * of the tunnel URL, two idempotent writes.
 *
 *  1. **Address Configuration** on our number: inbound to it auto-creates a
 *     Conversation (`AutoCreation.Type=default`) — the only mechanism that
 *     can receive a group MMS at all.
 *  2. **Global Conversations webhook**: `onMessageAdded` POSTs to the
 *     current tunnel URL. Global rather than per-conversation so messages in
 *     conversations created BEFORE a URL rotation still arrive at the new
 *     address.
 *
 * Both writes are safe to repeat; `ensureTwilioWebhooks` is called from an
 * interval and applies only when something actually changed.
 */

const CONV = "https://conversations.twilio.com/v1";

function auth(c: TwilioCreds): string {
  return `Basic ${Buffer.from(`${c.keySid}:${c.keySecret}`).toString("base64")}`;
}

let lastApplied: string | null = null;

/** Point Twilio's inbound machinery at `publicBase`. No-op when unchanged. */
export async function ensureTwilioWebhooks(params: {
  creds: TwilioCreds;
  publicBase: string;
  /** Our number, E.164 — the address whose inbound auto-creates conversations. */
  number: string;
}): Promise<boolean> {
  const base = params.publicBase.replace(/\/+$/, "");
  if (base === lastApplied) return true;
  const webhookUrl = `${base}/sms/conversations`;

  const okGlobal = await setGlobalWebhook(params.creds, webhookUrl);
  const okAddress = await setAddressAutoCreation(params.creds, params.number);
  if (okGlobal && okAddress) {
    lastApplied = base;
    log.info("sms", "twilio webhooks pointed at tunnel", { url: webhookUrl });
    return true;
  }
  return false;
}

/** Exposed for tests; resets the applied-URL memo. */
export function resetWebhookMemo(): void {
  lastApplied = null;
}

async function setGlobalWebhook(creds: TwilioCreds, url: string): Promise<boolean> {
  const form = new URLSearchParams();
  form.set("PostWebhookUrl", url);
  form.set("Method", "POST");
  form.append("Filters", "onMessageAdded");
  try {
    const res = await fetch(`${CONV}/Configuration/Webhooks`, {
      method: "POST",
      headers: { Authorization: auth(creds), "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!res.ok) {
      log.warn("sms", "global conversations webhook update failed", {
        status: res.status,
        body: (await res.text()).slice(0, 200),
      });
      return false;
    }
    return true;
  } catch (err) {
    log.warn("sms", "global conversations webhook update error", { err: String(err) });
    return false;
  }
}

/**
 * Ensure our number has an Address Configuration with autocreation enabled.
 * The address config itself does not carry the webhook URL (the global
 * webhook does); it exists so inbound SMS/MMS to the number lands in
 * Conversations instead of the classic (group-incapable) webhook path.
 */
async function setAddressAutoCreation(creds: TwilioCreds, number: string): Promise<boolean> {
  try {
    const list = await fetch(`${CONV}/Configuration/Addresses?PageSize=50`, {
      headers: { Authorization: auth(creds) },
    });
    if (!list.ok) return false;
    const json = (await list.json()) as {
      address_configurations?: { sid: string; address: string; type: string }[];
    };
    const existing = (json.address_configurations ?? []).find(
      (a) => a.type === "sms" && a.address === number,
    );
    const form = new URLSearchParams();
    form.set("AutoCreation.Enabled", "true");
    form.set("AutoCreation.Type", "default");
    if (existing) {
      const res = await fetch(`${CONV}/Configuration/Addresses/${existing.sid}`, {
        method: "POST",
        headers: {
          Authorization: auth(creds),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      });
      return res.ok;
    }
    form.set("Type", "sms");
    form.set("Address", number);
    form.set("FriendlyName", "edmund-sms autocreation");
    const res = await fetch(`${CONV}/Configuration/Addresses`, {
      method: "POST",
      headers: { Authorization: auth(creds), "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!res.ok) {
      log.warn("sms", "address configuration create failed", {
        status: res.status,
        body: (await res.text()).slice(0, 200),
      });
    }
    return res.ok;
  } catch (err) {
    log.warn("sms", "address configuration error", { err: String(err) });
    return false;
  }
}
