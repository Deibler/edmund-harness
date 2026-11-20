import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../agents/types.ts";
import type { Config } from "../config/config.ts";
import { CronStore } from "../cron/store.ts";
import { checkActiveHours, nextActiveStartMs } from "../ghost/budget.ts";
import { type BrownNosePrefs, DEFAULT_ACTIVE_HOURS_DM, GhostPrefsStore } from "../ghost/prefs.ts";
import type { ChatDb } from "../imessage/db.ts";
import { readPersonFile } from "../persona/crud.ts";
import { ContactBook } from "../sessions/contacts.ts";
import { type SessionKey, chatIdFromKey } from "../sessions/key.ts";
import { chatGuidsForSession } from "../sessions/session-scope.ts";
import { log } from "../util/log.ts";
import { sweepDeliveries } from "./delivery.ts";
import { isHeld } from "./pacing.ts";
import { type Ideation, IdeationStore } from "./store.ts";

/**
 * What happens when a build's sub-agent stops, however it stops (finished,
 * crashed, reaped, cancelled): every path goes through notifyParent, which
 * hands ideation builds here instead of the ordinary completion wake-up.
 *
 * The ordinary wake-up tells Edmund to relay the result, and on a failure to
 * "tell the user what came through". For a page nobody asked for, a failure
 * is nobody's business: it is recorded and goes no further.
 *
 * When a page passes its check, Edmund decides how to give it, the way a
 * friend who made you something would. The ideator always starts 20 minutes
 * after a conversation goes quiet and a build takes about ten, so sending
 * every page the moment it is ready would put each link half an hour after
 * the talk that prompted it, every time. People learn a rhythm like that
 * within a couple of pages, and then it reads as a system. So:
 *
 *  - Held (the usual case): from the moment it is ready, the page rides along
 *    on their next messages (`heldPageText`), and Edmund brings it up when one
 *    of them gives him an opening. Measured over 30 days of one-to-one chats,
 *    people write again a median 2.9 hours after a conversation ends (p90 19
 *    hours), so the moment usually comes within a day. If it hasn't come by a
 *    random moment in their hours one to three days on, he sends it as a
 *    fresh message.
 *  - Soon (about one page in three): he sends it a little after he finishes
 *    it, at a random moment in the next hour and a half, as a friend texts
 *    "made you this". Never while they are mid-conversation (then it is held,
 *    and comes up in that conversation), and never outside their hours.
 *
 * Either way the scheduled message is only a fallback: it is skipped when the
 * link is already in chat.db (`pageStillToGive`), so a page is given once.
 */

export const IDEATION_READY_HEAD = "[You built something in the background";

const HOME_TZ = "America/New_York";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** About this share of pages is sent soon after it is finished, not held. */
export const SOON_SHARE = 1 / 3;
/** "Soon": a random moment this long after the page is ready. */
export const SOON_WINDOW_MS: readonly [number, number] = [5 * MINUTE, 90 * MINUTE];
/** A held page that hasn't come up is sent at a random moment in this range. */
export const FALLBACK_WINDOW_MS: readonly [number, number] = [20 * HOUR, 72 * HOUR];
/** They wrote this recently: the conversation is still going, so hold it for that. */
export const TALKING_MS = 15 * MINUTE;

export type DeliveryPlan = { kind: "soon" | "held"; atMs: number };
type Hours = Pick<BrownNosePrefs, "activeHours" | "timezone">;

/**
 * A uniformly random moment in [fromMs, toMs] that falls inside their hours,
 * or null when none does. Drawn by rejection (uniform draws, keep the first
 * inside their hours), which is about two checks when their hours cover half
 * the range. Only when they cover a sliver of it does it fall back to listing
 * candidates 5 minutes apart, shifted by one random offset.
 */
export function randomActiveMoment(
  hours: Hours,
  fromMs: number,
  toMs: number,
  random: () => number,
): number | null {
  const ok = (t: number) => checkActiveHours(hours as BrownNosePrefs, t).ok;
  for (let n = 0; n < 64; n++) {
    const t = fromMs + Math.floor(random() * (toMs - fromMs + 1));
    if (ok(t)) return t;
  }
  const STEP = 5 * MINUTE;
  const offset = Math.floor(random() * STEP);
  const inHours: number[] = [];
  for (let t = fromMs + offset; t <= toMs; t += STEP) {
    if (ok(t)) inHours.push(t);
  }
  if (inHours.length === 0) return null;
  return inHours[Math.min(inHours.length - 1, Math.floor(random() * inHours.length))] ?? null;
}

/** When, and how, a page that just passed its check is given to them. */
export function planDelivery(input: {
  hours: Hours;
  nowMs: number;
  /** Their last message in this chat, if known. */
  lastInboundMs: number | null;
  random: () => number;
}): DeliveryPlan {
  const { nowMs, random } = input;
  const hours = input.hours.activeHours.length
    ? input.hours
    : { ...input.hours, activeHours: DEFAULT_ACTIVE_HOURS_DM };
  const talking = input.lastInboundMs !== null && nowMs - input.lastInboundMs < TALKING_MS;
  if (!talking && random() < SOON_SHARE) {
    const at = randomActiveMoment(
      hours,
      nowMs + SOON_WINDOW_MS[0],
      nowMs + SOON_WINDOW_MS[1],
      random,
    );
    if (at !== null) return { kind: "soon", atMs: at };
  }
  const at =
    randomActiveMoment(
      hours,
      nowMs + FALLBACK_WINDOW_MS[0],
      nowMs + FALLBACK_WINDOW_MS[1],
      random,
    ) ??
    nextActiveStartMs(hours, nowMs + FALLBACK_WINDOW_MS[0]) ??
    nowMs + FALLBACK_WINDOW_MS[0];
  return { kind: "held", atMs: at };
}

export function firstName(display: string | null | undefined): string {
  const first = (display ?? "").trim().split(/\s+/)[0];
  return first && !/^[+\d]/.test(first) ? first : "them";
}

function shortDays(days: string[]): string {
  return days
    .map((d) =>
      new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
    )
    .join(", ");
}

function weekday(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { weekday: "long", timeZone: HOME_TZ });
}

/** The scheduled message: sent soon after the page is done, or a held page's fallback. */
export function ideationReadyMessage(
  i: Ideation,
  name: string,
  kind: DeliveryPlan["kind"] = "soon",
): string {
  const when =
    kind === "soon"
      ? "You finished it a little while ago."
      : `You finished it on ${weekday(i.readyMs ?? i.createdMs)} and were keeping it for a natural moment in your conversation. None has come up, so give it to them now.`;
  return [
    `${IDEATION_READY_HEAD} for ${name}, unasked, because they keep coming back to "${i.thread}". It passed its check and is live.]`,
    "",
    `What it is: ${i.title}. ${i.pitch}`,
    `Link: ${i.url}`,
    `Why you made it: ${i.why}`,
    `They asked about it on: ${shortDays(i.days)}.`,
    "",
    `${when} Send it as its own message, the way you'd text a friend something you made them, in one or two short messages: what it is, that their questions are why you made it, and one thing to try first. Put the link on its own line so it shows as a preview. Don't say you were waiting or that it was scheduled.`,
    "If the conversation is in the middle of something that matters more, or sending it now makes no sense, reply KEEP_QUIET: it stays yours to give when they next write.",
  ].join("\n");
}

/**
 * The block added to their inbound turns while a finished page waits for a
 * natural moment. Written to be easy to pass on, like the capability offers
 * in src/announce/offer.ts: without "saying nothing is right" a model treats
 * any injected context as a task and wedges it into an unrelated reply.
 */
export function heldPageText(i: Ideation, name: string): string {
  return [
    "---",
    "",
    `[A PAGE YOU MADE FOR ${name.toUpperCase()}, NOT YET GIVEN: bring it up only when it fits]`,
    "",
    `You built this unasked because they keep coming back to "${i.thread}" (they asked about it on ${shortDays(i.days)}). It is live and they haven't seen it.`,
    `What it is: ${i.title}. ${i.pitch}`,
    `Link: ${i.url}`,
    "",
    `Give it to them if this message opens the door: they bring up ${i.thread} or something near it, you're about to answer a question the page answers better, or the conversation has an easy pause you'd have filled anyway. Deal with what they said first, then say it the way a friend would, in a sentence or two, with the link on its own line so it shows as a preview and one thing to try first.`,
    "",
    "If this message is about something else that matters, or they're busy, upset or in a hurry, say nothing about it. That is often the right answer; it will still be here next time. Never mention it without the link, never open with it, and never mention it twice.",
  ].join("\n");
}

export type SettleDeps = {
  dataDir: string;
  crons: Pick<CronStore, "create">;
  /** This person's accepted hours, when they set any (ghost prefs). */
  prefsFor: (sessionKey: string) => Pick<BrownNosePrefs, "activeHours" | "timezone"> | null;
  nameFor: (sessionKey: string) => string;
  /** Their last message in the chat, so a page finished mid-conversation is held for it. */
  lastInboundMsFor?: (sessionKey: string) => number | null;
  store?: IdeationStore;
  nowMs?: number;
  /** Injectable so tests can pin the draw. */
  random?: () => number;
};

/**
 * Settle the build this agent was running, if it was one. True when it was
 * (the caller must then send no completion wake-up of its own).
 */
export function settleIdeation(deps: SettleDeps, agent: Pick<Agent, "id" | "status">): boolean {
  const store = deps.store ?? new IdeationStore(deps.dataDir);
  try {
    const row = store.byAgent(agent.id);
    if (!row) return false;
    const now = deps.nowMs ?? Date.now();
    if (row.status === "building") {
      store.markFailed(row.id, `the builder stopped (${agent.status}) without publishing`);
      return true;
    }
    if (row.status !== "ready" || !row.url) return true;
    const hours = deps.prefsFor(row.sessionKey) ?? {
      activeHours: DEFAULT_ACTIVE_HOURS_DM,
      timezone: HOME_TZ,
    };
    // markAnnounced is what makes the page "held": from here on their
    // inbound turns carry it (listUndelivered), whichever plan is drawn.
    if (store.markAnnounced(row.id, now)) {
      const plan = planDelivery({
        hours,
        nowMs: now,
        lastInboundMs: deps.lastInboundMsFor?.(row.sessionKey) ?? null,
        random: deps.random ?? Math.random,
      });
      deps.crons.create({
        sessionKey: row.sessionKey,
        systemEvent: ideationReadyMessage(row, deps.nameFor(row.sessionKey), plan.kind),
        schedule: { kind: "once", atMs: plan.atMs },
        harnessWritten: true,
      });
      log.info("ideation", "page ready", {
        session: row.sessionKey,
        page: row.id,
        plan: plan.kind,
        send_at: new Date(plan.atMs).toISOString(),
      });
    }
    return true;
  } finally {
    if (!deps.store) store.close();
  }
}

/**
 * notifyParent's entry point: settle `agent` if it was building a page, with
 * the real stores. Ordinary agents cost one file check: when no page was
 * ever built here, ideations.db does not exist and nothing is opened.
 */
export function settleIdeationBuild(
  dataDir: string,
  agent: Pick<Agent, "id" | "status" | "teamId">,
): boolean {
  if (agent.teamId || !existsSync(join(dataDir, "ideations.db"))) return false;
  const store = new IdeationStore(dataDir);
  try {
    if (!store.byAgent(agent.id)) return false;
    const crons = new CronStore(dataDir);
    const prefs = new GhostPrefsStore(dataDir);
    try {
      return settleIdeation(
        {
          dataDir,
          crons,
          prefsFor: (key) => prefs.get(key),
          nameFor: (key) =>
            firstName(readPersonFile(chatIdFromKey(key))?.body.match(/^# (.+)$/m)?.[1]),
          lastInboundMsFor: (key) => lastInboundMs(dataDir, key),
          store,
        },
        agent,
      );
    } finally {
      crons.close();
      prefs.close();
    }
  } finally {
    store.close();
  }
}

/** The page waiting for a natural moment in this conversation, if one is. */
export function heldPage(store: IdeationStore, sessionKey: string, nowMs: number): Ideation | null {
  return (
    store
      .listUndelivered()
      .find((i) => i.sessionKey === sessionKey && i.url !== null && isHeld(i, nowMs)) ?? null
  );
}

const PAGE_ID_IN_EVENT = /\/i\/([0-9a-f]{32})\//;

/**
 * Checked when the scheduled message is about to fire: is the page still
 * theirs to receive? Not when Edmund already gave it in conversation (the
 * link is in chat.db, swept here first since that may have happened a
 * moment ago) and not when it was taken down. When the answer cannot be
 * read, it fires: the wake itself tells him to stay quiet if it makes no
 * sense, and his conversation history shows what he already sent.
 */
export function pageStillToGive(
  config: Pick<Config, "paths" | "contacts">,
  sessionKey: string,
  systemEvent: string,
  chatDb?: ChatDb,
): boolean {
  const id = systemEvent.match(PAGE_ID_IN_EVENT)?.[1];
  if (!id || !existsSync(join(config.paths.data_dir, "ideations.db"))) return true;
  let store: IdeationStore | null = null;
  try {
    store = new IdeationStore(config.paths.data_dir);
    if (chatDb) {
      const contacts = new ContactBook(config.contacts ?? []);
      const guids = chatGuidsForSession(sessionKey as SessionKey, chatDb, contacts);
      sweepDeliveries(store, chatDb, sessionKey, guids);
    }
    const row = store.get(id);
    return row !== null && row.status === "ready" && row.deliveredMs === null;
  } catch (err) {
    log.warn("ideation", "could not check whether a page was given", {
      err: (err as Error).message,
    });
    return true;
  } finally {
    store?.close();
  }
}

/** Their last message in this chat, from the daemon's session table (read only). */
export function lastInboundMs(dataDir: string, sessionKey: string): number | null {
  const path = join(dataDir, "state.db");
  if (!existsSync(path)) return null;
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const r = db
      .query("SELECT last_inbound_ms AS ms FROM sessions WHERE session_key = ?")
      .get(sessionKey) as { ms: number } | null;
    return r?.ms ? r.ms : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
