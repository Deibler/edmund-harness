import type { SessionKey } from "../sessions/key.ts";
import { log, shortSession } from "../util/log.ts";

/**
 * Registry of in-flight deferred /compact runs, keyed by session.
 *
 * The deferred compact (scheduleDeferredCompact in turn.ts) holds the
 * session lock in its own locked section, so a user message that lands
 * mid-compact would otherwise wait minutes on a maintenance task.
 * pipeline.enqueue() calls abortActiveCompact() the moment real work
 * arrives: the compact's worker is torn down (turn-abort path), the lock
 * releases, and the user turn cold-resumes on the uncompacted session —
 * which simply re-trips the threshold on a later quiet moment.
 */
const active = new Map<SessionKey, AbortController>();

export function registerCompact(key: SessionKey): AbortController {
  const controller = new AbortController();
  active.set(key, controller);
  return controller;
}

/** Identity-checked so a stale clear can't drop a newer registration. */
export function clearCompact(key: SessionKey, controller: AbortController): void {
  if (active.get(key) === controller) active.delete(key);
}

/** Abort the in-flight compact for this session, if any. */
export function abortActiveCompact(key: SessionKey): boolean {
  const controller = active.get(key);
  if (!controller) return false;
  active.delete(key);
  log.info("auto-compact", "aborting — a message arrived mid-compact", {
    session: shortSession(key),
  });
  controller.abort("follow-up message arrived mid-compact");
  return true;
}

/** Test seam: how many compacts are currently registered. */
export function activeCompactCount(): number {
  return active.size;
}
