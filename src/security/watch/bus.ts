/**
 * How the turn pipeline tells the watch what is happening, without knowing
 * the watch.
 *
 * The watch sits above the pipeline in the layering: it stops turns and
 * texts the operator. The pipeline sits below and is where a turn starts,
 * where a reply is sent and where a worker's event stream is read. So the
 * pipeline speaks to this, and the watch listens here once it has started.
 * With no watch running every call is a no-op, and a reply is never held up.
 */
import type { Asker } from "./tripwires.ts";

export type OutgoingVerdict = { allow: true } | { allow: false; reason: string };

type Listeners = {
  turnStarted: (session: string, turn: string, ask: string, asker: Asker) => void;
  turnEnded: (session: string, turn: string) => void;
  /** A tool call went ahead without the watch's answer. */
  hookSilent: (session: string, toolUseId: string, timedOut: boolean) => void;
  /** A reply the daemon itself is about to send. */
  outgoing: (session: string, text: string) => OutgoingVerdict;
};

let listeners: Partial<Listeners> = {};

/** The watch starts listening. Returns a function that stops it. */
export function listenToPipeline(next: Partial<Listeners>): () => void {
  listeners = next;
  return () => {
    if (listeners === next) listeners = {};
  };
}

const quiet = <T>(run: () => T, otherwise: T): T => {
  try {
    return run();
  } catch {
    // The watch failing must never be why a turn failed.
    return otherwise;
  }
};

export const pipeline = {
  turnStarted(session: string, turn: string, ask: string, asker: Asker): void {
    quiet(() => listeners.turnStarted?.(session, turn, ask, asker), undefined);
  },
  turnEnded(session: string, turn: string): void {
    quiet(() => listeners.turnEnded?.(session, turn), undefined);
  },
  hookSilent(session: string, toolUseId: string, timedOut: boolean): void {
    quiet(() => listeners.hookSilent?.(session, toolUseId, timedOut), undefined);
  },
  outgoing(session: string, text: string): OutgoingVerdict {
    return quiet(() => listeners.outgoing?.(session, text) ?? { allow: true }, { allow: true });
  },
};
