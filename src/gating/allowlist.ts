import type { Config } from "../config/config.ts";
import type { GuestCampaign, GuestTier } from "../guests/access.ts";
import { resolveDmTier, scanForCampaignKey } from "../guests/access.ts";
import type { GuestStore } from "../guests/store.ts";
import type { InboundMessage } from "../imessage/types.ts";
import { allInvocationNames } from "../orchestrators/registry.ts";
import { normalizeHandle } from "../sessions/key.ts";

export type Gate =
  | {
      allow: true;
      /** Guest-access tier for admitted non-allowlisted DM senders. Absent =
       *  the full operator/allowlisted tier (existing behavior). */
      tier?: GuestTier;
      /** Campaign whose key admitted a keyed guest (normalized lowercase). */
      campaignKey?: string;
      /** True on the very turn a buffered unknown sender presented a key. */
      activated?: boolean;
    }
  | {
      allow: false;
      reason:
        | "not-allowlisted"
        | "group-not-registered"
        | "not-mentioned"
        | "self"
        // Unknown DM sender under guest access: buffered + key-scanned, no
        // match — stay silent, never reach the model.
        | "guest-pending";
    };

/**
 * What the gate needs to run guest-access logic for unknown DM senders.
 * Absent (old callers, tests, guest_access disabled) ⇒ the gate behaves
 * exactly as it always has.
 */
export type GuestGateContext = {
  store: GuestStore;
  /** Fired exactly once, on the turn a buffered sender presents an active
   *  key — the caller alerts the operator ("<label> key activated by …"). */
  onActivation?: (ev: { handle: string; campaign: GuestCampaign }) => void;
  nowMs?: number;
};

/**
 * Decide whether the assistant should process this inbound message.
 *
 * DMs: sender must be in allowlist.dm (or list empty = allow all). With
 * guest access enabled, a non-allowlisted sender may still be admitted as
 * `keyed-guest` (presented an active campaign key) or `vouched` (shares a
 * registered group with us); everyone else is buffered and never answered.
 * Groups: chat must be in allowlist.groups AND the bot must be named in the text.
 *
 * We ignore messages where fromMe is true — that's either us (the assistant)
 * or the human typing on their own Mac. Either way, not something to react to.
 */
export function gateInbound(msg: InboundMessage, config: Config, guests?: GuestGateContext): Gate {
  if (msg.fromMe) return { allow: false, reason: "self" };

  if (msg.isGroup) {
    // An empty list is only "every group" when [security].open_group_allowlist
    // says so. Otherwise empty means none: the safe reading of an unfilled list.
    const registered =
      (config.allowlist.groups.length === 0 && config.security?.open_group_allowlist === true) ||
      config.allowlist.groups.includes(msg.chatGuid);
    if (!registered) return { allow: false, reason: "group-not-registered" };
    // Any orchestrator's invocation opens the gate — "edmund …" and
    // "desmond …" both pass; the router downstream picks WHO answers.
    // With no [[orchestrators]] configured this is exactly identity.names.
    if (!isAssistantMentioned(msg.text, allInvocationNames(config))) {
      return { allow: false, reason: "not-mentioned" };
    }
    return { allow: true };
  }

  // Same rule for DMs: an empty allowlist admits everyone only when
  // [security].open_dm_allowlist is set. Guest access below is unaffected.
  const allowed =
    (config.allowlist.dm.length === 0 && config.security?.open_dm_allowlist === true) ||
    config.allowlist.dm.some((h) => normalizeHandle(h) === normalizeHandle(msg.fromHandle));
  if (allowed) return { allow: true };
  if (guests && config.guest_access.enabled && msg.fromHandle) {
    return gateGuestDm(msg, config, guests);
  }
  return { allow: false, reason: "not-allowlisted" };
}

/**
 * The standard GuestGateContext: activation alerts the operator per the
 * plan ("<label> key activated by <handle>"). Shared by the live watcher
 * and boot catch-up so the two paths can't drift.
 */
export function guestGateFor(
  store: GuestStore,
  alert: {
    notify: (p: {
      category: string;
      error: string;
      context?: Record<string, string | number>;
    }) => Promise<boolean>;
  } | null,
): GuestGateContext {
  return {
    store,
    onActivation: ({ handle, campaign }) => {
      console.log(`[guest] "${campaign.label}" key activated by ${handle}`);
      void alert?.notify({
        category: "guest key activated",
        error: `${campaign.label} key activated by ${handle}`,
      });
    },
  };
}

/**
 * The unknown-DM path under guest access. Reads AND writes the guest store:
 * an unmatched message is buffered (capped + TTL'd) and logged as an
 * attempt; a message carrying an active campaign key persists the
 * activation so every later message from this handle admits directly.
 * The activating turn itself is allowed through — the turn pipeline drains
 * the buffered pre-key messages into its envelope as untrusted context.
 */
function gateGuestDm(msg: InboundMessage, config: Config, guests: GuestGateContext): Gate {
  const nowMs = guests.nowMs ?? Date.now();
  const tier = resolveDmTier(msg.fromHandle, config, guests.store, nowMs);
  if (tier === "keyed-guest") {
    const activation = guests.store.getActivation(msg.fromHandle);
    return { allow: true, tier, campaignKey: activation?.campaignKey };
  }
  if (tier === "vouched") return { allow: true, tier };

  const campaign = scanForCampaignKey(msg.text, config, nowMs);
  if (campaign) {
    guests.store.activate(msg.fromHandle, campaign.key, nowMs);
    guests.onActivation?.({ handle: msg.fromHandle, campaign });
    return {
      allow: true,
      tier: "keyed-guest",
      campaignKey: campaign.key.trim().toLowerCase(),
      activated: true,
    };
  }
  if (msg.text.trim().length > 0) {
    guests.store.bufferMessage(msg.fromHandle, msg.text, nowMs);
  }
  guests.store.recordAttempt(msg.fromHandle, nowMs);
  return { allow: false, reason: "guest-pending" };
}

/**
 * Name-prefix or @mention match. Case-insensitive.
 * Matches: "claude do X", "hey claude", "@claude", "claude, ...".
 */
export function isAssistantMentioned(text: string, names: string[]): boolean {
  const lower = text.toLowerCase();
  return names.some((name) => {
    const n = name.toLowerCase();
    const patterns = [new RegExp(`\\b${escapeRegex(n)}\\b`), new RegExp(`@${escapeRegex(n)}\\b`)];
    return patterns.some((re) => re.test(lower));
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip the assistant's name from the start of a group message so the
 * model sees the user's actual instruction, not "claude, claude, claude...".
 */
export function stripMention(text: string, names: string[]): string {
  let out = text.trim();
  for (const name of names) {
    const re = new RegExp(`^(hey |ok |@)?${escapeRegex(name)}[,:\\s]+`, "i");
    out = out.replace(re, "").trim();
  }
  return out;
}
