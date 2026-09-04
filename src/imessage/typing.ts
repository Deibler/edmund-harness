import { log } from "../util/log.ts";
import { invoke } from "./bridge/index.ts";

/**
 * Daemon-side typing indicator with explicit start/stop.
 *
 * Lifecycle:
 *  1. `start()` — called the moment the runner reports the model has
 *     actually begun emitting events (first `{type:"system"}` / first
 *     stdout chunk). NOT on inbound — we don't want a bubble for messages
 *     that won't get an answer (e.g. a gate-rejected message that races
 *     through, or a hung worker).
 *  2. Heartbeat keeps the bubble alive: set immediately, then refreshed every
 *     4s. iMessage typing notifications expire on the receiver side after
 *     ~5-10 s without renewal.
 *  3. `stop()` — called right before `sendDeliver` so the bubble clears just as
 *     the reply lands, rather than lingering after. The indicator is cleared
 *     explicitly rather than left to lapse: it outlives whoever set it, so a
 *     daemon that stopped renewing used to leave a bubble sitting on the other
 *     side until IMCore happened to time it out.
 *
 * Idempotent. Multiple `start()` calls are no-ops; `stop()` on a stopped
 * session is a no-op.
 */
export class TypingSession {
  private target: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private warnedOnce = false;

  // `isGroup` is still accepted so call sites did not have to change, but the
  // target is now addressed the same way either way: IMCore resolves a handle
  // or a chat GUID, so there is nothing to branch on.
  constructor(args: { isGroup: boolean; target: string }) {
    this.target = args.target;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pulse();
    // Refresh just before the 5s server-side expiration. Keeps the bubble
    // continuous; one missed pulse just means a brief fade, not a stuck
    // indicator.
    this.timer = setInterval(() => this.pulse(), 4000);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.set(false);
  }

  get active(): boolean {
    return this.running;
  }

  private pulse(): void {
    this.set(true);
  }

  /**
   * Sets or clears the indicator, fire-and-forget.
   *
   * A cosmetic bubble must never fail a turn or hold one up, so this is not
   * awaited and a failure is logged once per session rather than repeatedly —
   * a bridge that is down would otherwise log every 4 seconds.
   */
  private set(typing: boolean): void {
    void invoke("typing", { chat: this.target, typing }).catch((err: unknown) => {
      if (this.warnedOnce) return;
      this.warnedOnce = true;
      log.warn("auto-typing", "could not set the typing indicator", {
        err: err instanceof Error ? err.message : String(err),
        target: this.target,
      });
    });
  }
}
