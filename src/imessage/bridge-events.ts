import { log } from "../util/log.ts";
import { bridge, isBridgeHost } from "./bridge/index.ts";

export interface BridgeEventsHandle {
  stop: () => void;
}

/**
 * Wakes the chat.db drain the moment Messages sees anything.
 *
 * This is a latency accelerator and nothing more. chat.db remains the source of
 * truth and its poll always runs, so a quiet or broken event stream costs
 * latency rather than delivery. That separation is the fix for the failure that
 * started this: the old push source was the *only* inbound trigger, so when its
 * stream went silent while the subprocess stayed alive, messages sat unseen for
 * as long as it took someone to notice. There was a watchdog for it, an
 * evidence gate, a restart ladder and a fallback — all of which existed to
 * compensate for the stream being load-bearing. It no longer is.
 *
 * Events are treated as pings; none of them are parsed into messages. The drain
 * hydrates from chat.db exactly as it does when the poll wakes it, so there is
 * one parsing path regardless of what woke it.
 */
export function startBridgeEvents(opts: { onWake: () => void }): BridgeEventsHandle {
  // Only the process holding the bridge can subscribe. Everywhere else the poll
  // is the whole story, which is correct rather than degraded.
  if (!isBridgeHost()) return { stop: () => {} };

  let stopped = false;

  void (async () => {
    try {
      // The bridge outlives any single Messages.app, so this iterator keeps
      // working across a relaunch and never needs resubscribing.
      for await (const event of bridge().events()) {
        if (stopped) return;
        // Anything that touches a conversation is worth a look at chat.db. The
        // drain is idempotent and cheap when there is nothing new.
        if (WAKE_ON.has(event.type)) opts.onWake();
      }
    } catch (err) {
      // A dead stream degrades to poll-only. Logged loudly because the symptom
      // otherwise is a quiet latency regression rather than a failure.
      log.warn("bridge-events", "event stream ended, inbound is poll-only until restart", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  return {
    stop: () => {
      stopped = true;
    },
  };
}

/**
 * Events that mean chat.db may have changed.
 *
 * Typing and read receipts are deliberately absent: they fire constantly during
 * a live conversation and waking on them would poll chat.db for nothing.
 */
const WAKE_ON = new Set(["message", "message-sent", "message-updated", "chat-item"]);
