import { SAME_COLOR, colorDistance, colorName } from "./color.ts";
import type { Tray } from "./report.ts";

/**
 * Which spool prints which part, and what has to change on the AMS first.
 *
 * A sliced job names its filaments by number (1-based, as Bambu Studio does),
 * each with a material and a colour. The planner matches each to a loaded
 * tray of the same material within SAME_COLOR, and for the ones it cannot
 * match it says exactly which slot to load what into, preferring empty slots
 * and never one this job needs.
 */

export type Need = {
  /** Filament number in the project, 1-based. */
  index: number;
  type: string;
  color: string;
  grams: number;
  /** Bambu filament id the job was sliced with ("GFA00"), when known. */
  infoIdx?: string;
};

export type Assignment = { need: Need; tray: Tray; distance: number };
export type Swap = { need: Need; slot: Tray; replaces: Tray | null };

export type Plan = {
  ok: boolean;
  assignments: Assignment[];
  swaps: Swap[];
  /** Index = project filament - 1; value = tray id, -1 unused. */
  amsMapping: number[];
  amsMapping2: Array<{ ams_id: number; slot_id: number }>;
  /** Unmatched needs with no slot left to load them into. */
  unplaceable: Need[];
};

const sameMaterial = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

export function describeTray(t: Tray): string {
  if (!t.loaded) return `${t.label} (empty)`;
  return `${t.label}: ${colorName(t.color)} ${t.type} (${t.color})`;
}

export function describeNeed(n: Need): string {
  return `${colorName(n.color)} ${n.type} (${n.color}, filament ${n.index}, ${n.grams.toFixed(1)} g)`;
}

/**
 * Match needs to trays. `prefer` pins a filament to a tray when the person
 * has accepted a substitute ("the lighter blue is fine"); a pin to a tray of
 * another material is ignored, because that is not a colour choice.
 */
export function planFilaments(
  needs: Need[],
  trays: Tray[],
  prefer: Record<number, number> = {},
): Plan {
  const loaded = trays.filter((t) => t.loaded);
  const assignments: Assignment[] = [];
  const unmatched: Need[] = [];
  const order = [...needs].sort((a, b) => b.grams - a.grams);
  for (const need of order) {
    const pinned = prefer[need.index];
    const pin =
      pinned !== undefined
        ? loaded.find((t) => t.trayId === pinned && sameMaterial(t.type, need.type))
        : undefined;
    if (pin) {
      assignments.push({ need, tray: pin, distance: colorDistance(pin.color, need.color) });
      continue;
    }
    let best: Tray | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const t of loaded) {
      if (!sameMaterial(t.type, need.type)) continue;
      const d = colorDistance(t.color, need.color);
      if (d < bestD) {
        best = t;
        bestD = d;
      }
    }
    if (best && bestD <= SAME_COLOR) assignments.push({ need, tray: best, distance: bestD });
    else unmatched.push(need);
  }

  const used = new Set(assignments.map((a) => a.tray.trayId));
  const amsSlots = trays.filter((t) => t.unit !== 255);
  // Empty slots first, then slots holding something this job does not use.
  const free = [
    ...amsSlots.filter((t) => !t.loaded),
    ...amsSlots.filter((t) => t.loaded && !used.has(t.trayId)),
  ];
  const swaps: Swap[] = [];
  const unplaceable: Need[] = [];
  for (const need of unmatched) {
    const slot = free.shift();
    if (!slot) {
      unplaceable.push(need);
      continue;
    }
    swaps.push({ need, slot, replaces: slot.loaded ? slot : null });
  }

  const maxIndex = Math.max(0, ...needs.map((n) => n.index));
  const amsMapping = Array.from({ length: maxIndex }, () => -1);
  const amsMapping2 = Array.from({ length: maxIndex }, () => ({ ams_id: 255, slot_id: 255 }));
  for (const a of assignments) {
    amsMapping[a.need.index - 1] = a.tray.trayId;
    amsMapping2[a.need.index - 1] =
      a.tray.unit === 255
        ? { ams_id: 255, slot_id: 0 }
        : { ams_id: a.tray.unit, slot_id: a.tray.slot };
  }
  return {
    ok: unmatched.length === 0,
    assignments: assignments.sort((a, b) => a.need.index - b.need.index),
    swaps,
    amsMapping,
    amsMapping2,
    unplaceable,
  };
}

/** The ask to whoever is at the printer, in the order they would do it. */
export function swapInstructions(plan: Plan): string {
  const lines = plan.swaps.map((s) =>
    s.replaces
      ? `Swap ${s.slot.label} from ${colorName(s.replaces.color)} ${s.replaces.type} to ${colorName(s.need.color)} ${s.need.type} (${s.need.color}).`
      : `Load ${colorName(s.need.color)} ${s.need.type} (${s.need.color}) into ${s.slot.label}, which is empty.`,
  );
  for (const n of plan.unplaceable) {
    lines.push(
      `No free slot left for ${describeNeed(n)}: the AMS needs a fifth slot or a simpler design.`,
    );
  }
  return lines.join("\n");
}

/** A stable fingerprint of what is loaded where, to tell whether the AMS changed since a yes. */
export function trayFingerprint(trays: Tray[], ids?: number[]): string {
  const keep = ids ? trays.filter((t) => ids.includes(t.trayId)) : trays;
  return keep
    .map((t) => `${t.trayId}:${t.loaded ? `${t.type.toUpperCase()}/${t.color}/${t.infoIdx}` : "-"}`)
    .sort()
    .join("|");
}
