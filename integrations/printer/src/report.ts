/**
 * The printer's state, from its MQTT reports.
 *
 * A P-series printer sends the whole object on `pushall` and only the fields
 * that changed in each later `push_status`, so the raw report is merged
 * deltas-over-snapshot. Arrays of objects that carry an `id` (AMS units,
 * their trays) are merged by id, because a delta for one tray must not erase
 * the other three. Everything a person or the model reads comes from
 * `normalize`, which names things in words.
 */

export type Raw = Record<string, unknown>;

function isPlain(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasIds(a: unknown[]): a is Raw[] {
  return a.length > 0 && a.every((x) => isPlain(x) && "id" in x);
}

export function mergeReport(prev: Raw, delta: Raw): Raw {
  const out: Raw = { ...prev };
  for (const [k, v] of Object.entries(delta)) {
    const old = out[k];
    if (isPlain(v) && isPlain(old)) out[k] = mergeReport(old, v);
    else if (Array.isArray(v) && Array.isArray(old) && hasIds(v) && hasIds(old)) {
      const merged = old.map((o) => {
        const d = v.find((x) => String(x.id) === String(o.id));
        return d ? mergeReport(o, d) : o;
      });
      for (const d of v) if (!old.some((o) => String(o.id) === String(d.id))) merged.push(d);
      out[k] = merged;
    } else out[k] = v;
  }
  return out;
}

export type Tray = {
  /** AMS unit (0-based); 255 for the external spool holder. */
  unit: number;
  /** Slot within the unit (0-3). */
  slot: number;
  /** The id the print command maps to: unit * 4 + slot, or the external holder's own id. */
  trayId: number;
  /** "AMS 1 slot 2" or "external spool": how a person finds it. */
  label: string;
  loaded: boolean;
  type: string;
  /** "#RRGGBB", alpha dropped. Empty when nothing is loaded. */
  color: string;
  /** Every colour on a multi-colour spool. */
  colors: string[];
  /** Bambu filament id ("GFA00"); GFL99 and similar are generic. */
  infoIdx: string;
  subBrand: string;
  /** Read from an RFID tag (a Bambu spool) rather than set by hand. */
  rfid: boolean;
  remainPct: number | null;
  nozzleTempMin: number | null;
  nozzleTempMax: number | null;
};

export type HmsEntry = { attr: number; code: number };

export type PrinterState = {
  gcodeState: string;
  /** Plain-language state: "printing", "paused", "finished", "idle", … */
  stateLabel: string;
  stageId: number | null;
  stageLabel: string;
  percent: number | null;
  layer: number | null;
  totalLayers: number | null;
  remainingMin: number | null;
  taskName: string;
  gcodeFile: string;
  nozzle: { temp: number | null; target: number | null; diameter: string; type: string };
  bed: { temp: number | null; target: number | null };
  chamberTemp: number | null;
  speedLevel: number | null;
  speedName: string;
  lights: Record<string, string>;
  ams: {
    units: Array<{ id: number; humidityPct: number | null; tempC: number | null; name: string }>;
    trays: Tray[];
    external: Tray | null;
    /** trayId of the filament in the toolhead, or null. */
    active: number | null;
  };
  hms: HmsEntry[];
  printError: number;
  /** null when the report does not say. */
  developerMode: boolean | null;
  liveview: boolean;
  timelapseEnabled: boolean;
  lastTimelapsePath: string;
  storage: { usb: boolean; timelapseFreeKb: number | null };
  plateId: string;
  wifi: string;
};

const num = (v: unknown): number | null => {
  const n =
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const s = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const obj = (v: unknown): Raw => (isPlain(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function rgb(hex: string): string {
  const h = hex.replace(/^#/, "").trim();
  return /^[0-9a-fA-F]{6}/.test(h) ? `#${h.slice(0, 6).toUpperCase()}` : "";
}

export const STATE_LABELS: Record<string, string> = {
  IDLE: "idle",
  INIT: "starting up",
  PREPARE: "preparing",
  SLICING: "slicing",
  RUNNING: "printing",
  PAUSE: "paused",
  FINISH: "finished",
  FAILED: "failed or cancelled",
  OFFLINE: "offline",
};

/** Stage ids reported in `stg_cur`, from the community protocol work (ha-bambulab). */
export const STAGES: Record<number, string> = {
  0: "printing",
  1: "auto bed leveling",
  2: "preheating the bed",
  3: "vibration compensation",
  4: "changing filament",
  5: "M400 pause",
  6: "paused: filament ran out",
  7: "heating the hotend",
  8: "calibrating extrusion",
  9: "scanning the bed surface",
  10: "inspecting the first layer",
  11: "identifying the build plate",
  12: "calibrating the lidar",
  13: "homing the toolhead",
  14: "cleaning the nozzle tip",
  15: "checking extruder temperature",
  16: "paused by the user",
  17: "paused: front cover fell",
  18: "calibrating the lidar",
  19: "calibrating extrusion flow",
  20: "paused: nozzle temperature fault",
  21: "paused: bed temperature fault",
  22: "unloading filament",
  23: "paused: skipped step",
  24: "loading filament",
  25: "calibrating motor noise",
  26: "paused: AMS lost",
  27: "paused: heatbreak fan too slow",
  28: "paused: chamber temperature fault",
  29: "cooling the chamber",
  30: "paused by G-code",
  31: "motor noise showoff",
  32: "paused: nozzle covered in filament",
  33: "paused: cutter error",
  34: "paused: first layer problem",
  35: "paused: nozzle clog",
  40: "high-temperature bed leveling",
  47: "bed leveling, phase 1",
  48: "bed leveling, phase 2",
  49: "heating the chamber",
  50: "cooling the bed",
  51: "printing calibration lines",
  52: "checking material",
  54: "waiting for the bed to heat",
  55: "checking material position",
  58: "thermal preconditioning",
  64: "preparing the hotend",
  69: "cooling the nozzle",
  72: "detecting the hotend type",
  73: "checking build plate alignment",
  74: "checking the bed for objects",
  76: "pre-extruding",
  77: "preparing the AMS",
};

export const SPEEDS: Record<number, string> = {
  1: "silent",
  2: "standard",
  3: "sport",
  4: "ludicrous",
};

function tray(unit: number, t: Raw): Tray {
  const slot = num(t.id) ?? 0;
  const external = unit === 255;
  const loaded = !!s(t.tray_type) && num(t.state) !== 10;
  const colors = arr(t.cols)
    .map((c) => rgb(s(c)))
    .filter(Boolean);
  const remain = num(t.remain);
  return {
    unit,
    slot,
    // The external holder reports its own id (254 on X1-era firmware, 255 on
    // the P2S); the print command expects that same number.
    trayId: external ? slot : unit * 4 + slot,
    label: external ? "external spool" : `AMS ${unit + 1} slot ${slot + 1}`,
    loaded,
    type: loaded ? s(t.tray_type) : "",
    color: loaded ? rgb(s(t.tray_color)) : "",
    colors: loaded ? colors : [],
    infoIdx: loaded ? s(t.tray_info_idx) : "",
    subBrand: s(t.tray_sub_brands),
    rfid: !!s(t.tag_uid) && !/^0+$/.test(s(t.tag_uid)),
    remainPct: remain !== null && remain >= 0 ? remain : null,
    nozzleTempMin: num(t.nozzle_temp_min),
    nozzleTempMax: num(t.nozzle_temp_max),
  };
}

/** True when bit `n` of a hex flag string is set. */
export function hexBit(hex: string, n: number): boolean | null {
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  return ((BigInt(`0x${hex}`) >> BigInt(n)) & 1n) === 1n;
}

export function normalize(raw: Raw): PrinterState {
  const p = obj(raw);
  const amsRoot = obj(p.ams);
  const units = arr(amsRoot.ams).map(obj);
  const trays = units.flatMap((u) => arr(u.tray).map((t) => tray(num(u.id) ?? 0, obj(t))));
  const vir = arr(p.vir_slot).map(obj);
  const vt = isPlain(p.vt_tray) ? p.vt_tray : (vir[0] ?? null);
  const external = vt ? tray(255, vt) : null;
  const nowTray = num(amsRoot.tray_now);
  const device = obj(p.device);
  const ipcam = obj(p.ipcam);
  const gcodeState = s(p.gcode_state) || "UNKNOWN";
  const stageId = num(p.stg_cur);
  const lights: Record<string, string> = {};
  for (const l of arr(p.lights_report).map(obj)) lights[s(l.node)] = s(l.mode);
  const speedLevel = num(p.spd_lvl);
  const fun = s(p.fun);
  const secured = fun ? hexBit(fun, 29) : null;
  return {
    gcodeState,
    stateLabel: STATE_LABELS[gcodeState] ?? gcodeState.toLowerCase(),
    stageId,
    stageLabel: stageId === null || stageId < 0 || stageId === 255 ? "" : (STAGES[stageId] ?? ""),
    percent: num(p.mc_percent),
    layer: num(p.layer_num),
    totalLayers: num(p.total_layer_num),
    remainingMin: num(p.mc_remaining_time),
    taskName: s(p.subtask_name),
    gcodeFile: s(p.gcode_file),
    nozzle: {
      temp: num(p.nozzle_temper),
      target: num(p.nozzle_target_temper),
      diameter: s(p.nozzle_diameter),
      type: s(p.nozzle_type),
    },
    bed: { temp: num(p.bed_temper), target: num(p.bed_target_temper) },
    chamberTemp: num(obj(obj(device.ctc).info).temp) ?? num(p.chamber_temper),
    speedLevel,
    speedName: speedLevel === null ? "" : (SPEEDS[speedLevel] ?? String(speedLevel)),
    lights,
    ams: {
      units: units.map((u) => ({
        id: num(u.id) ?? 0,
        humidityPct: num(u.humidity_raw),
        tempC: num(u.temp),
        name: `AMS ${(num(u.id) ?? 0) + 1}`,
      })),
      trays,
      external,
      active: nowTray === null || nowTray === 255 ? null : nowTray,
    },
    hms: arr(p.hms)
      .map(obj)
      .map((h) => ({ attr: num(h.attr) ?? 0, code: num(h.code) ?? 0 })),
    printError: num(p.print_error) ?? 0,
    developerMode: secured === null ? null : !secured,
    liveview: !!s(ipcam.rtsp_url) && s(ipcam.rtsp_url) !== "disable",
    timelapseEnabled: s(ipcam.timelapse) === "enable",
    lastTimelapsePath: s(obj(device.cam).timelapse_path),
    storage: {
      usb: p.sdcard === true,
      timelapseFreeKb: num(ipcam.tl_internal_free_kb),
    },
    plateId: s(obj(device.plate).cur_id),
    wifi: s(p.wifi_signal),
  };
}

/** States in which a new print may be sent. */
export function isIdle(st: PrinterState): boolean {
  return ["IDLE", "FINISH", "FAILED"].includes(st.gcodeState);
}

/** States that mean a print is underway (including its preparation and pauses). */
export function isActive(st: PrinterState): boolean {
  return ["PREPARE", "RUNNING", "PAUSE", "SLICING", "INIT"].includes(st.gcodeState);
}
