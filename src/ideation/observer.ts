import type { AgentStore } from "../agents/store.ts";
import type { Config } from "../config/config.ts";
import type { ChatDb } from "../imessage/db.ts";
import { readPersonFile } from "../persona/crud.ts";
import { hostAccess } from "../security/policy.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import { type SessionKey, chatIdFromKey } from "../sessions/key.ts";
import { chatGuidsForSession } from "../sessions/session-scope.ts";
import { log } from "../util/log.ts";
import { startBuild } from "./build.ts";
import { sweepDeliveries } from "./delivery.ts";
import { mayRun, runIdeator } from "./ideator.ts";
import { nextLookMs } from "./pacing.ts";
import { firstName, heldPage, heldPageText } from "./settle.ts";
import type { IdeationStore } from "./store.ts";

/**
 * When to look for something to build. After Edmund replies, the ideator
 * waits until the conversation has been quiet for a while (each reply resets
 * the wait), so it never competes with a live exchange for the machine or
 * reads a conversation mid-thought. Then, only for the people configured and
 * only when pacing allows (src/ideation/pacing.ts: jittered gaps between
 * pages, a backoff after a pass that found nothing, few pages a day across
 * everyone), it runs; a pick starts a build. Most quiet conversations end
 * with nothing happening at all.
 *
 * Each reply is also when a delivered link would have just appeared, so the
 * delivery sweep runs then too.
 */

/** Quiet for this long after the last reply before the ideator looks. */
const SETTLE_MS = 20 * 60_000;
export { RUN_INTERVAL_MS } from "./pacing.ts";

export type ObserverDeps = {
  config: Config;
  chatDb: ChatDb;
  contacts: ContactBook;
  store: IdeationStore;
  agents: AgentStore;
  /** Guest and vouched DMs share the `imessage:dm:` namespace; main.ts wires
   *  the same rule that keeps them out of ghost outreach. */
  isExcludedSession?: (sessionKey: SessionKey) => boolean;
};

/** `people = ["*"]`: everyone in a one-to-one iMessage chat who isn't a guest. */
const EVERYONE = "*";

/**
 * Whether this conversation is one the ideator may look at. The builder makes
 * the page with a shell (copy the template, install, build, check), and a
 * sandboxed deployment gives the model none, so there every build would fail
 * after the ideator had already been paid for: nothing runs at all. A guest
 * is never looked at, even when listed by name.
 */
export function eligible(
  config: Config,
  contacts: ContactBook,
  sessionKey: SessionKey,
  isExcludedSession?: (sessionKey: SessionKey) => boolean,
): boolean {
  if (!config.ideation.enabled) return false;
  if (hostAccess(config) !== "full") return false;
  if (!sessionKey.startsWith("imessage:dm:")) return false;
  if (isExcludedSession?.(sessionKey)) return false;
  if (config.ideation.people.includes(EVERYONE)) return true;
  const handle = contacts.canon(chatIdFromKey(sessionKey));
  return config.ideation.people.some((p) => contacts.canon(p) === handle);
}

export class IdeationObserver {
  private pending = new Map<SessionKey, ReturnType<typeof setTimeout>>();
  private running = new Set<SessionKey>();
  private stopped = false;

  constructor(
    private readonly deps: ObserverDeps,
    private readonly settleMs = SETTLE_MS,
  ) {}

  onMainReplied(sessionKey: SessionKey): void {
    const { config, contacts, isExcludedSession } = this.deps;
    if (this.stopped || !eligible(config, contacts, sessionKey, isExcludedSession)) return;
    try {
      const guids = chatGuidsForSession(sessionKey, this.deps.chatDb, this.deps.contacts);
      const n = sweepDeliveries(this.deps.store, this.deps.chatDb, sessionKey, guids);
      if (n > 0) log.info("ideation", "page link delivered", { session: sessionKey, n });
    } catch (err) {
      log.warn("ideation", "delivery sweep failed", { err: (err as Error).message });
    }
    const existing = this.pending.get(sessionKey);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.pending.delete(sessionKey);
      void this.runIfDue(sessionKey);
    }, this.settleMs);
    if (typeof t.unref === "function") t.unref();
    this.pending.set(sessionKey, t);
  }

  /**
   * For an inbound turn: the finished page waiting for a natural moment in
   * this conversation, as the block to add to the turn, or null. Swept
   * against chat.db first, because a link given in the last reply reaches
   * chat.db a moment after the send and must not be offered again.
   */
  heldPageBlock(sessionKey: SessionKey, nowMs = Date.now()): { id: string; block: string } | null {
    const { config, contacts, isExcludedSession, store, chatDb } = this.deps;
    if (this.stopped || !eligible(config, contacts, sessionKey, isExcludedSession)) return null;
    try {
      sweepDeliveries(store, chatDb, sessionKey, chatGuidsForSession(sessionKey, chatDb, contacts));
      const page = heldPage(store, sessionKey, nowMs);
      if (!page) return null;
      log.info("ideation", "held page offered in this turn", {
        session: sessionKey,
        page: page.id,
      });
      return { id: page.id, block: heldPageText(page, this.nameFor(sessionKey)) };
    } catch (err) {
      log.warn("ideation", "held page check failed", { err: (err as Error).message });
      return null;
    }
  }

  private nameFor(sessionKey: SessionKey): string {
    const handle = chatIdFromKey(sessionKey);
    return firstName(
      this.deps.contacts.displayName(handle) ??
        readPersonFile(handle)?.body.match(/^# (.+)$/m)?.[1],
    );
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  /** One pass for one person, if it is due. Exposed for tests and the CLI. */
  async runIfDue(sessionKey: SessionKey, nowMs = Date.now()): Promise<string> {
    if (this.stopped || this.running.has(sessionKey)) return "busy";
    const next = nextLookMs(this.deps.store.lastRun(sessionKey));
    if (next !== null && nowMs < next) return "ran recently";
    let gate: ReturnType<typeof mayRun>;
    try {
      gate = mayRun(this.deps, sessionKey, nowMs);
    } catch (err) {
      // Runs from a timer: nothing above would catch it.
      log.warn("ideation", "pacing check failed", { err: (err as Error).message });
      return "crashed";
    }
    if (!gate.ok) {
      this.deps.store.recordRun({
        sessionKey,
        ranMs: nowMs,
        outcome: "skipped",
        detail: gate.why,
        costUsd: null,
      });
      return gate.why;
    }
    this.running.add(sessionKey);
    try {
      const r = await runIdeator(this.deps, sessionKey, { asOfMs: nowMs });
      const detail = r.pick
        ? `picked "${r.pick.title}" (${r.pick.thread}, ${r.pick.days.length} days)`
        : [r.reason, ...r.turnedDown.map((d) => `turned down "${d.title}": ${d.why}`)].join(" | ");
      this.deps.store.recordRun({
        sessionKey,
        ranMs: nowMs,
        outcome: r.outcome,
        detail,
        costUsd: r.costUsd,
      });
      log.info("ideation", "ideator ran", {
        session: sessionKey,
        outcome: r.outcome,
        detail: detail.slice(0, 200),
      });
      if (!r.pick) return r.outcome;
      const row = startBuild(this.deps, sessionKey, r.pick, this.nameFor(sessionKey), nowMs);
      return row.status === "failed" ? "build could not start" : "building";
    } catch (err) {
      log.warn("ideation", "ideator pass crashed", {
        session: sessionKey,
        err: (err as Error).message,
      });
      return "crashed";
    } finally {
      this.running.delete(sessionKey);
    }
  }
}
