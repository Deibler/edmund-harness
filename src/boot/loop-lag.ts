/**
 * Says so when the daemon's main thread stops for a while.
 *
 * Everything the daemon does shares one thread: a call's audio, its turn
 * taking and Edmund's speech included. One synchronous query held it for a
 * median of 15.6 s every ten minutes for two weeks (2026-10-29 to 11-12), and
 * nothing recorded that it had: on a call it showed only as a caller talking
 * to nobody for 22 s. A timer that should fire every 100 ms and fires late
 * was stopped for that long, whatever stopped it.
 *
 * Reported from half a second while a call is up, when half a second is
 * heard. With no call up only a long stop is: the recall indexer's tick
 * stops the thread for a second or two every minute, and a line a minute
 * about that would bury the one that matters.
 */

export type LoopLagOptions = {
  intervalMs?: number;
  /** Late by more than this is reported while a call is live. */
  thresholdMs?: number;
  /** ...and by more than this when none is. */
  idleThresholdMs?: number;
  /** A call is live: reported with the stall, since that is who heard it. */
  onCall: () => boolean;
  report: (stall: { ms: number; onCall: boolean }) => void;
  now?: () => number;
};

export class LoopLagMonitor {
  private readonly intervalMs: number;
  private readonly thresholdMs: number;
  private readonly idleThresholdMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private expectedAt = 0;

  constructor(private readonly options: LoopLagOptions) {
    this.intervalMs = options.intervalMs ?? 100;
    this.thresholdMs = options.thresholdMs ?? 500;
    this.idleThresholdMs = options.idleThresholdMs ?? 5_000;
    this.now = options.now ?? (() => performance.now());
  }

  start(): void {
    if (this.timer) return;
    this.expectedAt = this.now() + this.intervalMs;
    this.timer = setInterval(() => this.beat(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One timer firing; public so a test can drive it with its own clock. */
  beat(): void {
    const now = this.now();
    const late = now - this.expectedAt;
    this.expectedAt = now + this.intervalMs;
    const onCall = this.options.onCall();
    if (late > (onCall ? this.thresholdMs : this.idleThresholdMs)) {
      this.options.report({ ms: Math.round(late), onCall });
    }
  }
}
