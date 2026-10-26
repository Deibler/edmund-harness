import { colorDistance, colorName } from "./color.ts";
import { type Plan, describeNeed, describeTray, swapInstructions } from "./filament.ts";
import type { SendRoute } from "./gate.ts";
import { type ErrorDb, decodeDeviceError, decodeHms, describeError, wikiLink } from "./hms.ts";
import { type PrinterState, type Tray, isActive } from "./report.ts";
import type { Approval, Job, Watch } from "./store.ts";
import { formatMinutes, statusLine } from "./watches.ts";

/** The words a person (or the model) reads about the printer. */

export function trayLine(t: Tray): string {
  if (!t.loaded) return `${t.label}: empty`;
  const extra = [
    t.rfid ? "Bambu spool (RFID)" : "set by hand",
    t.remainPct !== null ? `${t.remainPct}% left` : "",
    t.infoIdx ? `id ${t.infoIdx}` : "",
  ].filter(Boolean);
  return `${describeTray(t)}, ${extra.join(", ")}`;
}

function routeLine(r: { route: SendRoute | null; problem: string } | undefined): string {
  if (!r) return "";
  if (r.route === "lan") return "Starts go over the LAN (Developer Mode is on).";
  if (r.route === "bambu_connect")
    return "Starts go through Bambu Connect on the Mac, so the printer stays in cloud mode and Bambu Handy keeps working.";
  return `Edmund cannot start prints right now: ${r.problem}`;
}

export function describeStatus(
  st: PrinterState,
  db: ErrorDb,
  extra: {
    name: string;
    via: string;
    modules?: Array<Record<string, unknown>>;
    /** How a start would reach the printer now (gate.chooseRoute). */
    route?: { route: SendRoute | null; problem: string };
  },
): string {
  const out: string[] = [];
  out.push(`${extra.name}: ${statusLine(st)}.`);
  if (isActive(st)) {
    out.push(
      `Nozzle ${st.nozzle.temp ?? "?"}/${st.nozzle.target ?? "?"} C, bed ${st.bed.temp ?? "?"}/${st.bed.target ?? "?"} C${st.chamberTemp !== null ? `, chamber ${st.chamberTemp} C` : ""}, speed ${st.speedName || "?"}.`,
    );
  } else {
    out.push(
      `Nozzle ${st.nozzle.temp ?? "?"} C, bed ${st.bed.temp ?? "?"} C${st.chamberTemp !== null ? `, chamber ${st.chamberTemp} C` : ""}. Nozzle: ${st.nozzle.diameter || "?"} mm ${st.nozzle.type || ""}.`.replace(
        / \./,
        ".",
      ),
    );
  }
  out.push("Filament:");
  for (const t of st.ams.trays)
    out.push(`  ${trayLine(t)}${st.ams.active === t.trayId ? " (in the toolhead now)" : ""}`);
  if (st.ams.external) out.push(`  ${trayLine(st.ams.external)}`);
  for (const u of st.ams.units) {
    if (u.humidityPct !== null || u.tempC !== null) {
      out.push(`  ${u.name}: humidity ${u.humidityPct ?? "?"}%, ${u.tempC ?? "?"} C inside.`);
    }
  }
  const errors = [
    ...st.hms.map((h) => decodeHms(h, db)),
    ...[decodeDeviceError(st.printError, db)].filter((e) => e !== null),
  ];
  if (errors.length) {
    out.push("Errors on the printer:");
    for (const e of errors) out.push(`  ${describeError(e)} Help: ${wikiLink(e)}`);
  } else out.push("No errors.");
  out.push(
    `Lights: chamber ${st.lights.chamber_light ?? "?"}. Camera stream: ${st.liveview ? "on" : "off (turn on LAN Only Liveview in the printer's network settings to see it)"}. ${routeLine(extra.route)}`,
  );
  if (st.storage.timelapseFreeKb !== null) {
    out.push(
      `Timelapse storage: ${(st.storage.timelapseFreeKb / 1024 / 1024).toFixed(2)} GB free.`,
    );
  }
  const fw = extra.modules?.find((m) => m.name === "ota");
  if (fw) out.push(`Firmware ${String(fw.sw_ver)}.`);
  return out.join("\n");
}

export function describeJob(job: Job, approval: Approval | null, url: string): string {
  const lines = [
    `Job ${job.id}: "${job.title}" for ${job.requester || "unknown"}, ${job.status.replace("_", " ")}.`,
    `File: ${job.file}`,
    `About ${formatMinutes(job.estimateS / 60)} of printing, ${job.weightG.toFixed(1)} g of filament.`,
    `Filament: ${job.needs.map(describeNeed).join("; ")}.`,
  ];
  if (job.designNote) lines.push(`Design confirmed: ${job.designNote}`);
  if (Object.keys(job.prefer).length) {
    lines.push(
      `Accepted substitutes: ${Object.entries(job.prefer)
        .map(([f, t]) => `filament ${f} from tray ${t}`)
        .join(", ")}.`,
    );
  }
  if (approval) {
    lines.push(
      `Approval (${approval.action}): ${approval.status}${approval.decidedText ? `, "${approval.decidedText}"` : ""}, asked ${new Date(approval.askedMs).toLocaleString("en-US", { timeZone: "America/New_York" })}.`,
    );
  }
  if (url && !["draft", "declined"].includes(job.status)) lines.push(`Page: ${url}`);
  if (job.endNote) lines.push(`Ended: ${job.endNote}`);
  return lines.join("\n");
}

export function describePlan(plan: Plan, trays: Tray[] = []): string {
  const lines: string[] = [];
  for (const a of plan.assignments) {
    lines.push(
      `Filament ${a.need.index} (${colorName(a.need.color)} ${a.need.type}, ${a.need.grams.toFixed(1)} g) from ${a.tray.label}, which holds ${colorName(a.tray.color)} ${a.tray.type} ${a.tray.color}${a.distance > 2 ? ` (color difference ${a.distance.toFixed(0)})` : ""}.`,
    );
  }
  if (plan.swaps.length || plan.unplaceable.length) {
    lines.push("Needs a change at the printer first:");
    lines.push(swapInstructions(plan));
    for (const s of plan.swaps) {
      const near = closestLoaded(s.need, trays);
      if (near) {
        lines.push(
          `  (Closest loaded to ${colorName(s.need.color)} ${s.need.type}: ${colorName(near.color)} ${near.type} in ${near.label}. If the person is happy with that, pin it with print_job update prefer {"${s.need.index}": ${near.trayId + 1}} instead of swapping.)`,
        );
      }
    }
  } else lines.push("Everything it needs is loaded.");
  return lines.join("\n");
}

function closestLoaded(need: Plan["swaps"][number]["need"], trays: Tray[]): Tray | null {
  let best: Tray | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const t of trays) {
    if (!t.loaded || t.unit === 255 || t.type.toUpperCase() !== need.type.toUpperCase()) continue;
    const d = colorDistance(t.color, need.color);
    if (d < bestD) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

export function describeWatch(w: Watch): string {
  const what =
    w.kind === "progress"
      ? `at ${w.threshold}%`
      : w.kind === "layer"
        ? `at layer ${w.threshold}`
        : w.kind === "filament"
          ? w.slot === null
            ? "when any filament changes"
            : `when ${trayLabel(w.slot)} changes`
          : w.kind === "finish"
            ? "when the print ends"
            : w.kind === "error"
              ? "on any new error"
              : "on any state change";
  return `#${w.id} ${what}${w.repeat ? " (every time)" : ""}${w.auto ? " (set automatically)" : ""}${w.note ? `: ${w.note}` : ""}`;
}

/** "AMS 1 slot 4" for tray id 3; the external holder by name. */
export function trayLabel(id: number): string {
  if (id >= 254) return "the external spool";
  return `AMS ${Math.floor(id / 4) + 1} slot ${(id % 4) + 1}`;
}
