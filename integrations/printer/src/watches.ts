import { colorName } from "./color.ts";
import { trayFingerprint } from "./filament.ts";
import {
  type DecodedError,
  type ErrorDb,
  decodeDeviceError,
  decodeHms,
  describeError,
} from "./hms.ts";
import { type PrinterState, isActive } from "./report.ts";
import type { Watch } from "./store.ts";

/**
 * When a watch fires. Pure over (watch, previous state, current state) so
 * every kind can be tested without a printer.
 *
 * Progress and layer watches belong to one print (`printKey`); a watch set
 * while nothing is printing binds to the next print that starts, and never
 * carries over to the one after. A finish watch fires on the edge into
 * FINISH or FAILED, not on a printer that is merely sitting finished. A
 * filament watch waits for the AMS to settle, because a spool swap reads
 * as several changes while the RFID and colour are read.
 */

export type Firing = { watch: Watch; reason: string };

export type EvalContext = {
  /** Identity of the print underway now, "" when none. */
  printKey: string;
  /** True once the current tray fingerprint has held long enough to count. */
  traysStable: boolean;
  db: ErrorDb;
};

const ENDED = ["FINISH", "FAILED"];

export function evaluateWatch(
  w: Watch,
  prev: PrinterState | null,
  cur: PrinterState,
  ctx: EvalContext,
): string | null {
  const samePrint = !w.printKey || w.printKey === ctx.printKey;
  switch (w.kind) {
    case "progress":
      if (!isActive(cur) || !samePrint || w.threshold === null || cur.percent === null) return null;
      return cur.percent >= w.threshold ? `the print reached ${cur.percent}%` : null;
    case "layer":
      if (!isActive(cur) || !samePrint || w.threshold === null || cur.layer === null) return null;
      return cur.layer >= w.threshold
        ? `the print reached layer ${cur.layer} of ${cur.totalLayers ?? "?"}`
        : null;
    case "finish":
      if (!prev || !isActive(prev) || !ENDED.includes(cur.gcodeState)) return null;
      if (w.printKey && w.printKey !== ctx.printKey) return null;
      return cur.gcodeState === "FINISH"
        ? "the print finished"
        : "the print stopped before finishing";
    case "state":
      if (!prev || prev.gcodeState === cur.gcodeState) return null;
      return `the printer went from ${prev.stateLabel} to ${cur.stateLabel}`;
    case "error": {
      const fresh = newErrors(prev, cur, ctx.db);
      return fresh.length ? `the printer reported: ${fresh.map(describeError).join("; ")}` : null;
    }
    case "filament": {
      if (!ctx.traysStable) return null;
      const ids = w.slot === null ? undefined : [w.slot];
      const now = trayFingerprint(allTrays(cur), ids);
      if (!w.baseline || w.baseline === now) return null;
      return `the filament changed: ${describeTrays(cur, ids)}`;
    }
  }
  return null;
}

export function allTrays(st: PrinterState) {
  return st.ams.external ? [...st.ams.trays, st.ams.external] : st.ams.trays;
}

export function describeTrays(st: PrinterState, ids?: number[]): string {
  const trays = allTrays(st).filter((t) => !ids || ids.includes(t.trayId));
  return trays
    .map((t) =>
      t.loaded ? `${t.label} ${colorName(t.color)} ${t.type} (${t.color})` : `${t.label} empty`,
    )
    .join(", ");
}

/** HMS entries and print errors in `cur` that were not in `prev`. */
export function newErrors(
  prev: PrinterState | null,
  cur: PrinterState,
  db: ErrorDb,
): DecodedError[] {
  const key = (h: { attr: number; code: number }) => `${h.attr}:${h.code}`;
  const had = new Set((prev?.hms ?? []).map(key));
  const out = cur.hms.filter((h) => !had.has(key(h))).map((h) => decodeHms(h, db));
  if (cur.printError && cur.printError !== (prev?.printError ?? 0)) {
    const e = decodeDeviceError(cur.printError, db);
    if (e) out.push(e);
  }
  return out;
}

/** One line on where the print stands, for wake-ups and replies. */
export function statusLine(st: PrinterState): string {
  const parts = [`${st.taskName ? `"${st.taskName}" ` : ""}${st.stateLabel}`];
  if (isActive(st) && st.percent !== null) parts.push(`${st.percent}%`);
  if (isActive(st) && st.layer !== null && st.totalLayers)
    parts.push(`layer ${st.layer}/${st.totalLayers}`);
  if (isActive(st) && st.remainingMin !== null)
    parts.push(`${formatMinutes(st.remainingMin)} left`);
  if (st.stageLabel && st.stageLabel !== "printing") parts.push(st.stageLabel);
  return parts.join(", ");
}

export function formatMinutes(min: number): string {
  if (min < 60) return `${Math.max(0, Math.round(min))} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}
