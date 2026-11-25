/**
 * Is the daemon in the middle of something a restart would cut off?
 *
 * A turn in progress, or a call. The call is the one that used to be missed:
 * between two of a caller's sentences no worker is mid-turn, so a check of
 * the worker pool alone read "idle" in the middle of a conversation, and the
 * memory governor restarted the daemon there (2026-11-05 to 11-11, five
 * calls). Anything that restarts the daemon or takes its attention for
 * seconds asks this, never the pool by itself.
 */

import { isWorkerPoolBusy } from "../claude/runner.ts";
import { anyVoiceLive } from "../sessions/call-binding.ts";

export function daemonBusy(): boolean {
  return isWorkerPoolBusy() || anyVoiceLive();
}
