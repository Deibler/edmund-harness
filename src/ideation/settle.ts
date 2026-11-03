import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../agents/types.ts";
import { CronStore } from "../cron/store.ts";
import { nextActiveStartMs } from "../ghost/budget.ts";
import { type BrownNosePrefs, DEFAULT_ACTIVE_HOURS_DM, GhostPrefsStore } from "../ghost/prefs.ts";
import { readPersonFile } from "../persona/crud.ts";
import { chatIdFromKey } from "../sessions/key.ts";
import { type Ideation, IdeationStore } from "./store.ts";

/**
 * What happens when a build's sub-agent stops, however it stops (finished,
 * crashed, reaped, cancelled): every path goes through notifyParent, which
 * hands ideation builds here instead of the ordinary completion wake-up.
 *
 * The ordinary wake-up tells Edmund to relay the result, and on a failure to
 * "tell the user what came through". For a page nobody asked for, a failure
 * is nobody's business: it is recorded and goes no further. A page that
 * passed its check is offered to Edmund in that person's conversation, at
 * the next hour they accept messages, and he decides how to say it.
 */

export const IDEATION_READY_HEAD = "[You built something in the background";

const HOME_TZ = "America/New_York";
/** Never sooner than this after the build ends, so a reply in flight lands first. */
const MIN_DELAY_MS = 30_000;

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

export function ideationReadyMessage(i: Ideation, name: string): string {
  return [
    `${IDEATION_READY_HEAD} for ${name}, unasked, because they keep coming back to "${i.thread}". It passed its check and is live.]`,
    "",
    `What it is: ${i.title}. ${i.pitch}`,
    `Link: ${i.url}`,
    `Why you made it: ${i.why}`,
    `They asked about it on: ${shortDays(i.days)}.`,
    "",
    "Tell them now, in your own words and in one or two short messages: what it is, that you made it because of their questions, and one thing to try first. Put the link on its own line so it shows as a preview.",
    "If the conversation is in the middle of something that matters more, wait and bring it up when it fits. If sending it makes no sense at all, reply KEEP_QUIET.",
  ].join("\n");
}

export type SettleDeps = {
  dataDir: string;
  crons: Pick<CronStore, "create">;
  /** This person's accepted hours, when they set any (ghost prefs). */
  prefsFor: (sessionKey: string) => Pick<BrownNosePrefs, "activeHours" | "timezone"> | null;
  nameFor: (sessionKey: string) => string;
  store?: IdeationStore;
  nowMs?: number;
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
    const prefs = deps.prefsFor(row.sessionKey) ?? {
      activeHours: DEFAULT_ACTIVE_HOURS_DM,
      timezone: HOME_TZ,
    };
    const atMs = Math.max(nextActiveStartMs(prefs, now) ?? now, now + MIN_DELAY_MS);
    if (store.markAnnounced(row.id, now)) {
      deps.crons.create({
        sessionKey: row.sessionKey,
        systemEvent: ideationReadyMessage(row, deps.nameFor(row.sessionKey)),
        schedule: { kind: "once", atMs },
        harnessWritten: true,
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
