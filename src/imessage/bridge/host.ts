import { type ImcoreBridge, type Supervisor, supervise } from "imcore-bridge";

import { log } from "../../util/log.ts";
import { BridgeNotRunningError } from "./errors.ts";

/**
 * The daemon's bridge into Messages.app, and the only one in the system.
 *
 * The injected code dials a socket with exactly one owner, so this process holds
 * it and everything else routes through the control server. `supervise` keeps it
 * up: it brings Messages back when nothing else will, and — the failure that
 * motivated moving off the old CLI — notices when the injected side stops
 * answering while the socket stays open, which no amount of retrying a send can
 * detect on its own.
 */
let supervisor: Supervisor | null = null;

export interface StartBridgeOptions {
  /** How often to prove the bridge still answers. Zero disables probing. */
  healthIntervalMs?: number;
  /** How long a probe may take before it counts as missed. */
  healthTimeoutMs?: number;
  /** Refuse, inside the injected code, every send targeting our own address. */
  blockSelfSends?: boolean;
}

/**
 * Starts supervising Messages, or returns the running supervisor.
 *
 * Idempotent so a second caller during boot cannot end up with two owners of
 * the socket, which would leave one of them permanently unable to bind.
 */
export async function startBridge(options: StartBridgeOptions = {}): Promise<Supervisor> {
  if (supervisor) return supervisor;

  const started = await supervise({
    healthIntervalMs: options.healthIntervalMs,
    healthTimeoutMs: options.healthTimeoutMs,
    blockSelfSends: options.blockSelfSends,
  });

  started.on("connected", (pid: number | undefined) => {
    log.info("bridge", "connected to Messages", { pid: pid ?? "unknown" });
  });
  started.on("disconnected", () => {
    log.warn("bridge", "lost the connection to Messages");
  });
  started.on("unhealthy", (missed: number, threshold: number) => {
    log.warn("bridge", "Messages did not answer a liveness probe", { missed, threshold });
  });
  started.on("relaunching", (reason: string, attempt: number) => {
    log.warn("bridge", "relaunching Messages", { reason, attempt });
  });
  started.on("relaunch-failed", (error: unknown, attempt: number, retryInMs: number) => {
    log.error("bridge", "relaunch failed", {
      attempt,
      retry_in_ms: retryInMs,
      err: error instanceof Error ? error.message : String(error),
    });
  });
  started.on("warning", (message: string) => {
    log.warn("bridge", message);
  });

  supervisor = started;
  log.info("bridge", "supervising Messages", {
    pid: started.bridge.pid ?? "unknown",
    connected: started.isConnected,
  });
  return started;
}

/** True when this process is the one holding the bridge. */
export function isBridgeHost(): boolean {
  return supervisor !== null;
}

/**
 * The live bridge.
 *
 * Throws rather than returning null: every caller needs it, and a nullable
 * accessor invites the silent no-op this migration exists to remove.
 */
export function bridge(): ImcoreBridge {
  if (!supervisor) throw new BridgeNotRunningError();
  return supervisor.bridge;
}

/**
 * Relaunches Messages because the caller has evidence the bridge is wedged.
 *
 * Better evidence than a probe: a send that just timed out says so now, rather
 * than up to one probe interval from now.
 */
export async function relaunchBridge(reason: string): Promise<void> {
  if (!supervisor) return;
  await supervisor.relaunch(reason);
}

/** Stops supervising and releases the socket. Leaves Messages.app running. */
export async function stopBridge(): Promise<void> {
  const running = supervisor;
  supervisor = null;
  await running?.stop();
}

/** Shortest gap between two registry rebuilds. A rebuild relaunches the user's
 *  Messages.app, so it is kept rare — the soft-retry phase carries the common
 *  flicker and the durable outbox carries a message past a longer poison. */
const HEAL_DEBOUNCE_MS = 5 * 60_000;
let lastHealAt = 0;
/** Concurrent callers ride one in-flight rebuild instead of queueing their own. */
let pendingHeal: Promise<void> | null = null;

/**
 * Rebuilds IMCore's chat registry by relaunching Messages.
 *
 * It deliberately does NOT restart imagent. Restarting imagent clears the
 * self-route poison, but imagent churn leaves Apple's IDS receive-registration
 * stale — after a run of imagent kills this account stopped RECEIVING messages
 * for hours while still reporting "Connected". Breaking every inbound message
 * to stop the occasional outbound misroute is the wrong trade. A Messages
 * relaunch re-resolves the chat objects from a settled imagent without
 * touching registration, and the injected block plus the soft-retry loop keep
 * a still-poisoned send from ever leaking in the meantime. See the memory note
 * [[imessage-delivered-delay-registration]].
 *
 * Answers "healed" when this call ran (or joined) a relaunch, "throttled" when
 * one ran too recently. A throttled recovery still does its bounded safe
 * resends, then returns a transient failure to the durable outbox if the
 * registry remains poisoned. It must not hold a control request open for up to
 * a minute and then relaunch Messages again: that behaviour created the
 * escalating relaunch storms visible in the daemon log.
 */
export async function healMessagingRegistry(reason: string): Promise<"healed" | "throttled"> {
  if (!supervisor) return "throttled";

  if (pendingHeal) {
    log.info("bridge", "registry heal already in flight — riding it", { reason });
    await pendingHeal;
    return "healed";
  }

  const elapsed = Date.now() - lastHealAt;
  if (elapsed < HEAL_DEBOUNCE_MS) {
    log.warn("bridge", "registry heal throttled — one already ran recently", {
      reason,
      retry_in_ms: HEAL_DEBOUNCE_MS - elapsed,
    });
    return "throttled";
  }

  lastHealAt = Date.now();
  const run = (async () => {
    log.warn("bridge", "relaunching Messages to re-resolve the chat registry", { reason });
    await supervisor.relaunch(`registry heal: ${reason}`);
  })();

  pendingHeal = run;
  try {
    await run;
  } finally {
    pendingHeal = null;
  }
  return supervisor ? "healed" : "throttled";
}
