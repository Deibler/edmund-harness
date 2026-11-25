/** True if a session has been quiet long enough to count as "stale" — used
 *  to gate optional context (history-on-cold-start, recall) that's only
 *  worth paying for when the conversation is being picked up after a gap.
 *  Quiet means no one wrote and no turn ran: a group Edmund posted in
 *  minutes ago (a reminder, a proactive message) is not idle because no one
 *  has written to him in three days. */
export function isSessionStale(
  session: { lastInboundMs: number; lastOutboundMs: number; lastTurnMs: number } | null,
  idleHours: number,
): boolean {
  const lastActivityMs = Math.max(
    session?.lastInboundMs ?? 0,
    session?.lastOutboundMs ?? 0,
    session?.lastTurnMs ?? 0,
  );
  if (!lastActivityMs || idleHours <= 0) return false;
  return Date.now() - lastActivityMs > idleHours * 3_600_000;
}
