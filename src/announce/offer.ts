/**
 * Putting a new capability in front of someone, without sending them an ad.
 *
 * The delivery mechanism is deliberately NOT a message. Nothing here ever
 * sends anything: when an eligible person writes in, a short block is added
 * to the turn they were already having, and the model decides whether there
 * is a natural opening. If there isn't, it says nothing and the block is
 * simply not used. That is the difference between Edmund mentioning something
 * in passing and Edmund interrupting to advertise.
 *
 * It also means the harness never has to suppress or rewrite a reply, which
 * is a standing rule in this codebase: the model's words stay the model's.
 * What the harness owns instead is WHO gets the chance and HOW OFTEN, and
 * those are enforced against rows in announcements.db, not against a prompt.
 *
 * Confirming it landed
 * --------------------
 * The link carries the recipient's own portal token, a 40-char HMAC unique to
 * their conversation. So "did the reply actually mention this?" has a
 * mechanical answer — is the token in the outbound text — rather than
 * depending on the model to report on itself. A model asked "did you mention
 * it?" will say yes; the outbound text cannot.
 *
 * An offer the model passes on is still spent. After `max_offers` chances the
 * pairing is exhausted and never raised again, because a natural opening that
 * has not appeared in three separate conversations is not going to, and
 * continuing to try is the definition of nagging.
 */

import type { Config } from "../config/config.ts";
import type { ChatDb } from "../imessage/db.ts";
import { loadPortalSecret, portalGeneration, portalToken, portalUrl } from "../portal/token.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import type { SessionKey } from "../sessions/key.ts";
import { log } from "../util/log.ts";
import { type Eligibility, checkEligibility } from "./eligibility.ts";
import { type Announcement, AnnouncementStore } from "./store.ts";

export type OfferDeps = {
  config: Config;
  dataDir: string;
  chatDb: ChatDb;
  contacts: ContactBook;
  guestTier: string | null;
  /** Injectable so tests neither open the real db nor need a secret file. */
  store?: AnnouncementStore;
  now?: () => number;
};

export type Offer = {
  announcement: Announcement;
  /** The recipient's own link, already resolved against the live base URL. */
  url: string;
  /** The 40-char portal token — the marker delivery is confirmed against. */
  token: string;
  /** Text appended to the turn envelope. */
  block: string;
};

/**
 * Choose something to surface for this conversation, or nothing.
 *
 * Nothing is by far the common answer, and the call is cheap: the eligibility
 * check short-circuits on session shape and cooldown before it touches
 * chat.db, so a group or a recently-pitched chat costs two comparisons.
 */
export function pickOffer(sessionKey: SessionKey, deps: OfferDeps): Offer | null {
  const cfg = deps.config.announcements;
  if (!cfg.enabled) return null;
  const now = (deps.now ?? Date.now)();

  const store = deps.store ?? new AnnouncementStore(deps.dataDir);
  const owned = !deps.store;
  try {
    const live = store.liveAnnouncements(now);
    if (live.length === 0) return null;

    for (const announcement of live) {
      const existing = store.delivery(announcement.id, sessionKey);
      // Terminal states are terminal. Told once is the whole promise.
      if (existing?.state === "delivered" || existing?.state === "exhausted") continue;
      if (existing && existing.offers >= cfg.max_offers) {
        store.markExhausted(announcement.id, sessionKey);
        continue;
      }
      // A re-offer waits out its own smaller cooldown, so a person who is
      // eligible every day does not see the same nudge in consecutive turns.
      if (existing && now - existing.last_offered_ms < cfg.reoffer_cooldown_days * 86_400_000) {
        continue;
      }

      const eligibility = checkEligibility({
        sessionKey,
        chatDb: deps.chatDb,
        contacts: deps.contacts,
        guestTier: deps.guestTier,
        // The global cooldown asks "how long since they heard about
        // something ELSE" — this announcement's own prior offers are
        // governed by reoffer_cooldown_days and max_offers above.
        lastOfferMs: store.lastOfferMs(sessionKey, announcement.id),
        config: cfg,
        minActiveDaysOverride: announcement.min_active_days,
        now,
      });
      if (!eligibility.eligible) return null;

      const secret = loadPortalSecret(deps.dataDir);
      const token = portalToken(
        secret,
        sessionKey,
        portalGeneration(deps.config.paths.data_dir, sessionKey),
      );
      const base = portalUrl(deps.config, secret, sessionKey);
      const url = `${base}${announcement.link_path ?? ""}`;

      store.recordOffer(announcement.id, sessionKey, now);
      log.info("announce", "offered a capability", {
        session: sessionKey,
        announcement: announcement.id,
        offer: (existing?.offers ?? 0) + 1,
        active_days: eligibility.activeDays,
      });
      return { announcement, url, token, block: renderBlock(announcement, url) };
    }
    return null;
  } catch (err) {
    // Never let this break a turn. A missed announcement costs nothing; a
    // turn that fails because of one is a real outage.
    log.warn("announce", "offer selection failed", { err: (err as Error).message });
    return null;
  } finally {
    if (owned) store.close();
  }
}

/**
 * The block appended to the envelope.
 *
 * Written to be easy to decline. The instruction that matters is the last
 * one: saying nothing is a correct outcome. Without that a model treats any
 * injected context as a task and will wedge it in somewhere, which produces
 * exactly the tonal break this feature exists to avoid.
 */
export function renderBlock(announcement: Announcement, url: string): string {
  return [
    "---",
    "",
    "[SOMETHING NEW YOU CAN DO — mention only if it genuinely fits]",
    "",
    announcement.body.trim(),
    "",
    `Their link: ${url}`,
    "",
    "This person talks to you often enough that this is worth them knowing. Work it in ONLY where it belongs — they asked about something related, they just hit the limit this solves, or the conversation has a natural pause you would have filled anyway. One sentence, in your voice, the way you would mention it to a friend. Paste the link as-is if you mention it.",
    "",
    "If there is no natural opening in THIS message, say nothing about it. That is the right answer most of the time and costs nothing — the moment will come round again. Never open with it, never append it to an unrelated reply, and never mention it twice.",
  ].join("\n");
}

/**
 * Did the reply carry it?
 *
 * Called from the single outbound choke point with the text actually being
 * sent. Confirms against the recipient's portal token — a marker the model
 * cannot produce by accident and would not include unless it pasted the link.
 */
export function confirmDelivery(
  sessionKey: SessionKey,
  offer: Offer,
  outboundText: string,
  deps: OfferDeps,
): boolean {
  const store = deps.store ?? new AnnouncementStore(deps.dataDir);
  const owned = !deps.store;
  try {
    if (!outboundText.includes(offer.token)) return false;
    store.markDelivered(offer.announcement.id, sessionKey, (deps.now ?? Date.now)());
    log.info("announce", "capability landed in a reply", {
      session: sessionKey,
      announcement: offer.announcement.id,
    });
    return true;
  } catch (err) {
    log.warn("announce", "delivery confirmation failed", { err: (err as Error).message });
    return false;
  } finally {
    if (owned) store.close();
  }
}

/** Why a given conversation is or isn't eligible — for `edmund announce status`. */
export function explainEligibility(sessionKey: SessionKey, deps: OfferDeps): Eligibility {
  const store = deps.store ?? new AnnouncementStore(deps.dataDir);
  const owned = !deps.store;
  try {
    return checkEligibility({
      sessionKey,
      chatDb: deps.chatDb,
      contacts: deps.contacts,
      guestTier: deps.guestTier,
      lastOfferMs: store.lastOfferMs(sessionKey),
      config: deps.config.announcements,
      now: (deps.now ?? Date.now)(),
    });
  } finally {
    if (owned) store.close();
  }
}
