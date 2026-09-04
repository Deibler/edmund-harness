import type { Config } from "../config/config.ts";
import { chatIdFromKey, isDmSession, normalizeHandle } from "../sessions/key.ts";
import { getSpendLedger, localDay } from "../spend/ledger.ts";
import { type GuestStore, getGuestStore } from "./store.ts";

/**
 * Guest-access tier resolution + caps. Pure decisions live here; the gate
 * (src/gating/allowlist.ts) and the turn pipeline (src/channels/turn.ts)
 * both resolve through these functions so they can never disagree about
 * what a handle is. See docs/design/guest-access-plan.md.
 */

export type GuestTier = "keyed-guest" | "vouched";
export type GuestCampaign = Config["guest_campaigns"][number];

/** Per-handle rolling rate limit for guest/vouched DMs. */
export const GUEST_RATE_LIMIT = 10;
export const GUEST_RATE_WINDOW_MS = 10 * 60_000;

/** A campaign is active until its (optional) ISO expiry date. From that
 *  moment the key is inert AND replies to its guests stop. */
export function campaignIsActive(c: GuestCampaign, nowMs = Date.now()): boolean {
  if (!c.expires) return true;
  return nowMs < Date.parse(c.expires);
}

/** Look up an ACTIVE campaign by its key (case-insensitive). */
function activeCampaignByKey(
  config: Config,
  campaignKey: string,
  nowMs = Date.now(),
): GuestCampaign | null {
  const norm = campaignKey.trim().toLowerCase();
  for (const c of config.guest_campaigns) {
    if (c.key.trim().toLowerCase() === norm && campaignIsActive(c, nowMs)) return c;
  }
  return null;
}

/** Case-insensitive scan of a message for any active campaign key. */
export function scanForCampaignKey(
  text: string,
  config: Config,
  nowMs = Date.now(),
): GuestCampaign | null {
  const lower = text.toLowerCase();
  for (const c of config.guest_campaigns) {
    if (campaignIsActive(c, nowMs) && lower.includes(c.key.trim().toLowerCase())) return c;
  }
  return null;
}

export type ResolvedTier = "operator" | GuestTier | "unknown";

/**
 * What is this DM handle to us right now? Precedence: the allowlist wins
 * (an allowlisted handle is the operator tier even if it also appears
 * vouched), then an active key activation, then vouching. "unknown" means
 * the current gate would not admit this handle — including the case where
 * an activation exists but its campaign has expired or been removed, and
 * the case where guest access is switched off entirely.
 */
export function resolveDmTier(
  handle: string,
  config: Config,
  store: GuestStore,
  nowMs = Date.now(),
): ResolvedTier {
  const allowlisted =
    (config.allowlist.dm.length === 0 && config.security?.open_dm_allowlist === true) ||
    config.allowlist.dm.some((h) => normalizeHandle(h) === normalizeHandle(handle));
  if (allowlisted) return "operator";
  if (!config.guest_access.enabled) return "unknown";
  const activation = store.getActivation(handle);
  if (activation && activeCampaignByKey(config, activation.campaignKey, nowMs)) {
    return "keyed-guest";
  }
  if (store.isVouched(handle)) return "vouched";
  return "unknown";
}

/**
 * The turn pipeline's view of a DM session, re-resolved at turn time so a
 * campaign that expired (or a kill switch flipped) between gate and turn
 * still ends replies.
 */
export type GuestTurn =
  | { kind: "operator" }
  | { kind: "guest"; tier: GuestTier; campaign: GuestCampaign | null }
  | { kind: "blocked" };

export function resolveGuestTurn(
  handle: string,
  config: Config,
  store: GuestStore,
  nowMs = Date.now(),
): GuestTurn {
  const tier = resolveDmTier(handle, config, store, nowMs);
  if (tier === "operator") return { kind: "operator" };
  if (tier === "unknown") return { kind: "blocked" };
  const campaign =
    tier === "keyed-guest"
      ? activeCampaignByKey(config, store.getActivation(handle)?.campaignKey ?? "", nowMs)
      : null;
  return { kind: "guest", tier, campaign };
}

/** What the runner needs to build a guest worker's loadout. */
export type GuestLoadout = {
  tier: GuestTier;
  campaignKey: string | null;
  campaignContextPath: string | null;
};

/**
 * Derive the guest loadout for a session key — the runner's safety net.
 * Every runClaude call site (turn, recovery turn, cron fire) flows through
 * this, so a guest session invoked from a path that forgot to resolve the
 * tier still gets the reduced loadout instead of the full one.
 *
 * Returns undefined for the full operator loadout, "blocked" when the
 * session's guest admission has been revoked (campaign expired, key gone,
 * guest access switched off with the handle un-allowlisted) — the runner
 * refuses the turn rather than choosing a loadout for it.
 */
export function deriveGuestLoadout(
  sessionKey: string,
  config: Config,
  nowMs = Date.now(),
): GuestLoadout | "blocked" | undefined {
  if (!config.guest_access.enabled || !isDmSession(sessionKey)) return undefined;
  const store = getGuestStore(config.paths.data_dir);
  const turn = resolveGuestTurn(chatIdFromKey(sessionKey), config, store, nowMs);
  if (turn.kind === "operator") return undefined;
  if (turn.kind === "blocked") return "blocked";
  return {
    tier: turn.tier,
    campaignKey: turn.campaign?.key ?? null,
    campaignContextPath: turn.campaign?.context ?? null,
  };
}

export type GuestCapVerdict =
  | { ok: true }
  | { ok: false; cap: "rate" | "daily" | "spend"; scope: string; detail: string };

/**
 * Check every cap that applies to this guest turn. Order: the rolling
 * per-handle rate limit (cheap, applies to every tier), then the campaign's
 * daily message ceiling, then its lifetime spend ceiling via the ledger.
 */
export function checkGuestCaps(params: {
  handle: string;
  campaign: GuestCampaign | null;
  store: GuestStore;
  dataDir: string;
  nowMs?: number;
}): GuestCapVerdict {
  const { handle, campaign, store, dataDir } = params;
  const nowMs = params.nowMs ?? Date.now();
  const norm = normalizeHandle(handle);
  const recent = store.countRecentMessages(handle, nowMs - GUEST_RATE_WINDOW_MS);
  if (recent >= GUEST_RATE_LIMIT) {
    return {
      ok: false,
      cap: "rate",
      scope: rateCapScope(handle),
      detail: `${recent} messages in ${GUEST_RATE_WINDOW_MS / 60_000}min (limit ${GUEST_RATE_LIMIT})`,
    };
  }
  if (campaign?.max_messages_per_day != null) {
    const day = localDay(nowMs);
    const used = store.countCampaignDay(campaign.key, day);
    if (used >= campaign.max_messages_per_day) {
      return {
        ok: false,
        cap: "daily",
        scope: `daily:${campaign.key.trim().toLowerCase()}:${day}`,
        detail: `${used}/${campaign.max_messages_per_day} messages today for "${campaign.label}"`,
      };
    }
  }
  if (campaign?.max_spend_usd != null) {
    const spent = spentForCampaign(dataDir, campaign.key);
    if (spent >= campaign.max_spend_usd) {
      return {
        ok: false,
        cap: "spend",
        scope: `spend:${campaign.key.trim().toLowerCase()}`,
        detail: `$${spent.toFixed(2)} of $${campaign.max_spend_usd} lifetime budget for "${campaign.label}"`,
      };
    }
  }
  // The rolling window has room again — re-arm the rate decline so a future
  // burst gets its one polite notice instead of silent nothing.
  store.clearCapNotice(rateCapScope(norm));
  return { ok: true };
}

function rateCapScope(handle: string): string {
  return `rate:${normalizeHandle(handle)}`;
}

/** Ledger subsystem tag for a keyed guest's turns; vouched turns use plain
 *  "guest". Lifetime campaign spend = SUM over the campaign's tag. */
export function guestSpendSubsystem(campaignKey: string | null): string {
  return campaignKey ? `guest:${campaignKey.trim().toLowerCase()}` : "guest";
}

function spentForCampaign(dataDir: string, campaignKey: string): number {
  try {
    return getSpendLedger(dataDir).totalCostFor(guestSpendSubsystem(campaignKey));
  } catch {
    // Ledger trouble must not open the wallet: treat as over-cap only if we
    // can't read at all? No — failing CLOSED here would silence guests on a
    // transient DB hiccup. Fail open like the ghost's cap check does; the
    // next successful read enforces the ceiling again.
    return 0;
  }
}

/** The one polite decline a capped guest gets before silence. */
export function capDeclineText(cap: "rate" | "daily" | "spend"): string {
  switch (cap) {
    case "rate":
      return "You've caught me at my rate limit — give me a few minutes and I'll be able to reply again.";
    case "daily":
      return "I've hit my daily message limit for this conversation. Try me again tomorrow.";
    case "spend":
      return "This demo has reached its budget, so I have to stop here. Thanks for the conversation.";
  }
}
