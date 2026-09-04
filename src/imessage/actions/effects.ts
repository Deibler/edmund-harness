import { Effects } from "imcore-bridge";

/**
 * The effect names the model uses, and the identifiers IMCore wants.
 *
 * The short names are what the `send_message` tool description offers and what
 * the model writes, so they are kept exactly as they were. The old CLI accepted
 * them directly and did this mapping itself; IMCore takes the full identifier.
 */
const EFFECT_IDS: Record<string, string> = {
  impact: Effects.bubble.impact,
  loud: Effects.bubble.loud,
  gentle: Effects.bubble.gentle,
  invisibleink: Effects.bubble.invisibleInk,
  echo: Effects.screen.echo,
  spotlight: Effects.screen.spotlight,
  balloons: Effects.screen.balloons,
  confetti: Effects.screen.confetti,
  love: Effects.screen.heart,
  lasers: Effects.screen.lasers,
  fireworks: Effects.screen.fireworks,
  celebration: Effects.screen.sparkles,
};

/** Effect names the tool descriptions advertise. */
export const EXPRESSIVE_EFFECTS = Object.keys(EFFECT_IDS) as readonly string[];

/**
 * The IMCore identifier for an effect name, or null if it is not one we offer.
 *
 * Null rather than a guess: an unrecognised effect should drop off the send and
 * let the text go, which is what the old path did.
 */
export function effectId(name: string | undefined): string | null {
  if (!name) return null;
  return EFFECT_IDS[name.trim().toLowerCase()] ?? null;
}
