import type { CronStore } from "../cron/store.ts";
import { agentCompletionMessage, teamCompletionMessage } from "./messages.ts";
import type { AgentStore } from "./store.ts";

/**
 * Daemon-level zombie reaper. Runs on an interval from main.ts.
 *
 * Why this exists even though team-internal reaping already happens: the
 * existing teamReapZombies is called from inside agent-runner.ts on exit.
 * If every team member dies silently (e.g., bun crashed, OOM killed),
 * nobody reaches that exit hook and the whole team sits `running` forever.
 * Same for a single solo agent that hangs indefinitely. This sweep catches
 * those cases and sends Edmund the wake-up event so the user isn't left
 * hanging.
 */
export function reapStuckAgents(
  store: AgentStore,
  crons: CronStore,
  opts: { pendingStaleMs: number; runningStaleMs: number },
): void {
  const stuck = store.listStuck(opts);
  if (stuck.length === 0) return;

  const teamsTouched = new Set<string>();
  const reapedSolos: typeof stuck = [];

  for (const a of stuck) {
    try {
      // KILL before marking failed. Declaring an agent dead while its
      // `claude` process keeps running meant (a) tokens kept burning
      // after the verdict, and (b) the eventual real exit re-ran the
      // team-settle hook and fired a SECOND team-done wake-up. SIGTERM
      // the whole process group (runner detaches agents into their own
      // group); fall back to the single pid for pre-detach rows.
      if (a.pid) {
        try {
          process.kill(-a.pid, "SIGTERM");
        } catch {
          try {
            process.kill(a.pid, "SIGTERM");
          } catch {
            // already gone — exactly what we want
          }
        }
      }
      store.finish(a.id, "failed", null);
      const age = Math.round((Date.now() - a.spawnedAt) / 1000);
      console.warn(
        `[agents] reaper: ${a.id} stuck in ${a.status} for ${age}s, killed pid=${a.pid ?? "?"} and marked failed`,
      );
      if (a.teamId) teamsTouched.add(a.teamId);
      else reapedSolos.push(a);
    } catch (err) {
      console.error(`[agents] reaper: failed to mark ${a.id}: ${String(err).slice(0, 200)}`);
    }
  }

  // Fire per-solo wake-ups.
  for (const a of reapedSolos) {
    try {
      crons.create({
        sessionKey: a.parentSessionKey,
        systemEvent: agentCompletionMessage(
          a.id,
          a.task,
          "failed",
          "reaped by daemon (stuck without progress)",
        ),
        schedule: { kind: "once", atMs: Date.now() + 2000 },
      });
      crons.cancelPokes(a.parentSessionKey);
      console.log(`[agents] reaper: fired wake-up for solo ${a.id}`);
    } catch (err) {
      console.error(
        `[agents] reaper: solo wake-up failed for ${a.id}: ${String(err).slice(0, 200)}`,
      );
    }
  }

  // For each touched team: if it's now fully settled, fire ONE team event.
  for (const teamId of teamsTouched) {
    try {
      if (!store.teamFullySettled(teamId)) continue;
      const members = store.listTeam(teamId);
      const parentSessionKey = members[0]?.parentSessionKey;
      if (!parentSessionKey) continue;
      crons.create({
        sessionKey: parentSessionKey,
        systemEvent: teamCompletionMessage(teamId, store),
        schedule: { kind: "once", atMs: Date.now() + 2000 },
      });
      crons.cancelPokes(parentSessionKey);
      console.log(`[agents] reaper: fired team-done for ${teamId}`);
    } catch (err) {
      console.error(
        `[agents] reaper: team wake-up failed for ${teamId}: ${String(err).slice(0, 200)}`,
      );
    }
  }
}
