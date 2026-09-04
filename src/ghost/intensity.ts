/**
 * Brown-nose intensity scale (1-10).
 *
 * One operator-facing knob. Maps to the four effective parameters the
 * budget logic and ghost prompt consume:
 *
 *   - cooldownHours: minimum hours between fires per session
 *   - weeklyCap:     max main-model invocations per session per week
 *   - sweepMin/Max:  ghost-tick cadence (minutes, randomized)
 *   - eagerness:     prompt line describing how picky the ghost is
 *
 * Engagement decay still multiplies on top of cooldown/cap, regardless
 * of intensity — a level-10 chat that gets ignored still has its
 * cooldown doubled per the budget rules.
 *
 * Tune the table once we see real telemetry from decisions.jsonl.
 */

export type IntensityParams = {
  cooldownHours: number;
  weeklyCap: number;
  sweepMin: number; // minutes
  sweepMax: number; // minutes
  /** Drops into the ghost prompt verbatim. Different levels make the
   *  ghost actually behave differently, not just probability-wise. */
  eagerness: string;
};

const TABLE: Record<number, IntensityParams> = {
  1: {
    cooldownHours: 168,
    weeklyCap: 1,
    sweepMin: 240,
    sweepMax: 480,
    eagerness:
      "INTENSITY 1 (blue moon). Acting is extremely rare. Raise the bar dramatically — only proceed on an unmistakable, time-sensitive hook where the user would visibly miss out without your contribution. If you would describe the rationale as 'might be nice', return act:false.",
  },
  2: {
    cooldownHours: 96,
    weeklyCap: 1,
    sweepMin: 180,
    sweepMax: 360,
    eagerness:
      "INTENSITY 2. Very picky. The hook must be specific, timely, and tied to something stated in the chat. Generic helpfulness is not enough.",
  },
  3: {
    cooldownHours: 72,
    weeklyCap: 2,
    sweepMin: 150,
    sweepMax: 300,
    eagerness:
      "INTENSITY 3. Picky. Lean toward act:false. Act when the move would clearly land — a real artifact, a real time-sensitive insight, a real follow-through on a stated promise.",
  },
  4: {
    cooldownHours: 48,
    weeklyCap: 2,
    sweepMin: 120,
    sweepMax: 270,
    eagerness:
      "INTENSITY 4. Slightly cautious. Default is still no, but you can act on softer hooks when the user's recent rhythm shows they're engaged.",
  },
  5: {
    cooldownHours: 24,
    weeklyCap: 3,
    sweepMin: 90,
    sweepMax: 240,
    eagerness:
      "INTENSITY 5 (balanced default). Default to no. Act when there's a real hook AND the move materially helps — useful artifact, timely insight, follow-through on a promise. About 1-3 fires per week for an active user.",
  },
  6: {
    cooldownHours: 18,
    weeklyCap: 4,
    sweepMin: 75,
    sweepMax: 210,
    eagerness:
      "INTENSITY 6. Moderately eager. Lean toward acting when there's a hook, even if the hook is softer than usual.",
  },
  7: {
    cooldownHours: 12,
    weeklyCap: 5,
    sweepMin: 60,
    sweepMax: 180,
    eagerness:
      "INTENSITY 7. Lean toward acting when there's a real hook. The user wants frequent proactive presence; reward that with prompt follow-through and small thoughtful artifacts.",
  },
  8: {
    cooldownHours: 8,
    weeklyCap: 7,
    sweepMin: 45,
    sweepMax: 150,
    eagerness:
      "INTENSITY 8. Act when in doubt. The user has explicitly asked for high presence. Daily-ish is fine. Skip only when there's no signal at all.",
  },
  9: {
    cooldownHours: 6,
    weeklyCap: 10,
    sweepMin: 30,
    sweepMax: 120,
    eagerness:
      "INTENSITY 9. High presence mode. Almost-daily for active users is welcome. Skip only when the user is clearly busy or away.",
  },
  10: {
    cooldownHours: 4,
    weeklyCap: 14,
    sweepMin: 20,
    sweepMax: 90,
    eagerness:
      "INTENSITY 10 (frequent). Every active user likely gets something most weeks. Only skip when the chat is dead or you have zero signal. This is the user-requested ceiling — don't exceed it.",
  },
};

/**
 * Resolve an intensity value (any number — clamped to 1-10) to its
 * effective parameters. Non-integer inputs are floor()'d.
 */
export function resolveIntensity(intensity: number): IntensityParams {
  const i = Math.max(1, Math.min(10, Math.floor(intensity)));
  return TABLE[i]!;
}

/** All ten rows — useful for tests and for the `--show` CLI command. */
export function intensityTable(): Array<IntensityParams & { level: number }> {
  return Object.entries(TABLE)
    .map(([k, v]) => ({ level: Number(k), ...v }))
    .sort((a, b) => a.level - b.level);
}
