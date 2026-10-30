/**
 * Freeing a busy conversation for a call that is ringing.
 *
 * A call runs in the caller's own session, and a session runs one turn at a
 * time. If Edmund is mid-turn in that conversation when they call, the turn
 * has to let go before he can talk. It is asked first: the running turn is
 * shown a message at its next tool step telling it to hand its work to an
 * agent (handoff_current_work, which packages what is done and what remains)
 * and stop. The model knows its own progress better than anything here could.
 *
 * If it has not let go by the time the call should be answered, the turn is
 * interrupted, and what it was asked to do is given to a fresh agent so the
 * work is not lost. Either way the agents' results come back to the session as
 * wake-ups: spoken if the call is still going, texted if not, which is how
 * Edmund takes the work back over when the call ends.
 */

export type TakeoverDeps = {
  /** A turn is running in this session right now. */
  isBusy: (sessionKey: string) => boolean;
  /** Show the running turn a message at its next tool step. */
  inject: (sessionKey: string, text: string) => boolean;
  /** Abort the running turn. */
  interrupt: (sessionKey: string, reason: string) => boolean;
  /** What the running turn was asked to do, as the person said it. */
  inFlightRequest: (sessionKey: string) => string | null;
  /** Start an agent on `task` for this session; returns its id. */
  spawnHandoff: (sessionKey: string, task: string) => string;
  /** Agents this session started at or after `sinceMs`. */
  agentsSince: (sessionKey: string, sinceMs: number) => string[];
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const POLL_MS = 200;
/** After an interrupt, how long the aborted turn may take to release. */
const RELEASE_MS = 3_000;

export function handoffNotice(label: string): string {
  return [
    `[FaceTime] ${label} is calling you right now.`,
    "Hand off what you are doing with handoff_current_work, with everything the agent needs to finish it,",
    "then end this turn with one short line. You take the call next, and the agent's result comes back to you.",
  ].join(" ");
}

function handoffTask(label: string, request: string): string {
  return [
    `Edmund was working on this when ${label} called him on FaceTime, and could not hand it off himself.`,
    "Do the whole task from the start. Edmund will be told your result and will pass it on.",
    "",
    "What was asked:",
    request,
  ].join("\n");
}

/**
 * Make the session free for the call by `deadlineMs`. Returns the ids of the
 * agents now carrying its work (empty when it was idle).
 */
export async function clearForCall(
  deps: TakeoverDeps,
  sessionKey: string,
  label: string,
  deadlineMs: number,
): Promise<string[]> {
  if (!deps.isBusy(sessionKey)) return [];
  const startedAt = deps.now();
  // Read before anything changes: once interrupted the turn forgets it.
  const request = deps.inFlightRequest(sessionKey);
  deps.inject(sessionKey, handoffNotice(label));

  while (deps.now() < deadlineMs) {
    if (!deps.isBusy(sessionKey)) return deps.agentsSince(sessionKey, startedAt);
    await deps.sleep(POLL_MS);
  }

  deps.interrupt(sessionKey, `FaceTime call from ${label}`);
  const handedOff = deps.agentsSince(sessionKey, startedAt);
  const agents =
    handedOff.length > 0 || !request
      ? handedOff
      : [deps.spawnHandoff(sessionKey, handoffTask(label, request))];

  const releaseBy = deps.now() + RELEASE_MS;
  while (deps.isBusy(sessionKey) && deps.now() < releaseBy) await deps.sleep(POLL_MS);
  return agents;
}
