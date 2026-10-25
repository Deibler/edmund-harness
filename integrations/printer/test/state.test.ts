import { describe, expect, test } from "bun:test";
import { SAME_COLOR, colorDistance, colorName } from "../src/color.ts";
import { planFilaments, swapInstructions, trayFingerprint } from "../src/filament.ts";
import {
  decodeDeviceError,
  decodeHms,
  describeError,
  loadErrorDb,
  lookupCode,
} from "../src/hms.ts";
import { type Tray, hexBit, isActive, isIdle, mergeReport, normalize } from "../src/report.ts";

const tray = (id: number, type: string, color: string, idx = "GFL99") => ({
  id: String(id),
  state: 11,
  tray_type: type,
  tray_color: `${color.replace("#", "")}FF`,
  cols: [`${color.replace("#", "")}FF`],
  tray_info_idx: idx,
  tag_uid: "0000000000000000",
  remain: -1,
});

// A trimmed P2S report, shaped like the one read live on 2026-10-25.
const report = {
  command: "push_status",
  gcode_state: "RUNNING",
  mc_percent: 42,
  layer_num: 88,
  total_layer_num: 210,
  mc_remaining_time: 74,
  subtask_name: "Dragon",
  stg_cur: 0,
  spd_lvl: 2,
  nozzle_temper: 219.6,
  nozzle_target_temper: 220,
  bed_temper: 65,
  bed_target_temper: 65,
  nozzle_diameter: "0.4",
  nozzle_type: "HS01",
  fun: "64039FD1B3FF9CB3",
  ipcam: { rtsp_url: "disable", timelapse: "disable", tl_internal_free_kb: 571657 },
  lights_report: [{ node: "chamber_light", mode: "off" }],
  device: {
    ctc: { info: { temp: 29 } },
    cam: { timelapse_path: "/userdata/media/timelapse/v.mp4" },
  },
  hms: [],
  print_error: 0,
  ams: {
    tray_now: "1",
    ams: [
      {
        id: "0",
        humidity_raw: "42",
        temp: "32.5",
        tray: [
          tray(0, "PLA", "#FFFFFF", "GFA01"),
          tray(1, "PLA", "#2850E0"),
          tray(2, "PLA", "#161616"),
          { id: "3", state: 10 },
        ],
      },
    ],
  },
  vir_slot: [{ id: "255", tray_type: "", tray_color: "FFFFFF00" }],
};

describe("the printer's state", () => {
  test("names everything a person needs", () => {
    const st = normalize(report);
    expect(st.stateLabel).toBe("printing");
    expect(st.percent).toBe(42);
    expect(st.speedName).toBe("standard");
    expect(st.chamberTemp).toBe(29);
    expect(st.ams.trays.map((t) => `${t.label}:${t.loaded ? t.color : "empty"}`)).toEqual([
      "AMS 1 slot 1:#FFFFFF",
      "AMS 1 slot 2:#2850E0",
      "AMS 1 slot 3:#161616",
      "AMS 1 slot 4:empty",
    ]);
    expect(st.ams.active).toBe(1);
    expect(st.ams.external?.loaded).toBe(false);
    expect(st.ams.external?.trayId).toBe(255);
    expect(st.lastTimelapsePath).toContain("v.mp4");
    expect(isActive(st)).toBe(true);
    expect(isIdle(st)).toBe(false);
  });

  test("Developer Mode is read from bit 29 of fun: set means secured", () => {
    expect(hexBit("64039FD1B3FF9CB3", 29)).toBe(true);
    expect(normalize(report).developerMode).toBe(false);
    const open = (BigInt("0x64039FD1B3FF9CB3") & ~(1n << 29n)).toString(16);
    expect(normalize({ ...report, fun: open }).developerMode).toBe(true);
    expect(normalize({ ...report, fun: undefined }).developerMode).toBeNull();
  });

  test("a delta for one tray does not erase the other three", () => {
    const merged = mergeReport(report, {
      ams: { ams: [{ id: "0", tray: [{ id: "2", tray_color: "C12E1FFF" }] }] },
    });
    const st = normalize(merged);
    expect(st.ams.trays).toHaveLength(4);
    expect(st.ams.trays[2]!.color).toBe("#C12E1F");
    expect(st.ams.trays[0]!.color).toBe("#FFFFFF");
  });

  test("a scalar delta replaces, the rest stays", () => {
    const st = normalize(mergeReport(report, { mc_percent: 43 }));
    expect(st.percent).toBe(43);
    expect(st.taskName).toBe("Dragon");
  });
});

describe("Bambu's error text", () => {
  const db = loadErrorDb();

  test("a cancelled print reads as Bambu says it", () => {
    expect(decodeDeviceError(0x0300400c, db)?.text).toBe("The task was canceled.");
    expect(decodeDeviceError(0x0300400c, db)?.code).toBe("0300_400C");
    expect(decodeDeviceError(0, db)).toBeNull();
  });

  test("every way a person writes a code finds the same entry", () => {
    for (const c of ["0300_400C", "0300-400C", "0300400c", "50348044"]) {
      expect(lookupCode(c, db)?.text).toBe("The task was canceled.");
    }
  });

  test("HMS codes carry module and severity from their bits", () => {
    const known = Object.keys(db.hms).find((k) => k.startsWith("07"))!;
    const e = decodeHms(
      { attr: Number.parseInt(known.slice(0, 8), 16), code: Number.parseInt(known.slice(8), 16) },
      db,
    );
    expect(e.known).toBe(true);
    expect(e.module).toBe("AMS");
    expect(e.code).toMatch(/^07[0-9A-F]{2}_[0-9A-F]{4}_[0-9A-F]{4}_[0-9A-F]{4}$/);
    expect(describeError(e)).toContain(e.text);
    expect(lookupCode(`HMS_${e.code}`, db)?.text).toBe(e.text);
  });

  test("an unknown code says so rather than inventing a meaning", () => {
    const e = lookupCode("7F7F_7F7F_7F7F_7F7F", db)!;
    expect(e.known).toBe(false);
    expect(e.text).toContain("Not in Bambu's list");
  });

  test("the bundled list is the full catalogue", () => {
    expect(Object.keys(db.hms).length).toBeGreaterThan(1500);
    expect(Object.keys(db.errors).length).toBeGreaterThan(400);
  });
});

describe("color", () => {
  test("a design's red matches Bambu's red; white does not match light gray", () => {
    expect(colorDistance("#FF0000", "#C12E1F")).toBeLessThanOrEqual(SAME_COLOR);
    expect(colorDistance("#FFFFFF", "#C8C8C8")).toBeGreaterThan(SAME_COLOR - 0.5);
    expect(colorDistance("#C12E1F", "#FF6A13")).toBeGreaterThan(SAME_COLOR);
    expect(colorDistance("#AAAAAA", "#AAAAAA")).toBe(0);
  });

  test("colors get plain names", () => {
    expect(colorName("#C12E1F")).toBe("red");
    expect(colorName("#161616")).toBe("black");
    expect(colorName("#2850E0")).toBe("blue");
    expect(colorName("#FFFFFF")).toBe("white");
  });
});

describe("the filament plan", () => {
  const trays = normalize(report).ams.trays as Tray[];

  test("loaded colors are used where they are, by material and color", () => {
    const plan = planFilaments(
      [
        { index: 1, type: "PLA", color: "#FFFFFF", grams: 10 },
        { index: 2, type: "PLA", color: "#000000", grams: 2 },
      ],
      trays,
    );
    expect(plan.ok).toBe(true);
    expect(plan.amsMapping).toEqual([0, 2]);
    expect(plan.amsMapping2).toEqual([
      { ams_id: 0, slot_id: 0 },
      { ams_id: 0, slot_id: 2 },
    ]);
  });

  test("a missing color goes into the empty slot first, never a slot the job uses", () => {
    const plan = planFilaments(
      [
        { index: 1, type: "PLA", color: "#FFFFFF", grams: 10 },
        { index: 2, type: "PLA", color: "#C12E1F", grams: 3 },
      ],
      trays,
    );
    expect(plan.ok).toBe(false);
    expect(plan.swaps[0]!.slot.label).toBe("AMS 1 slot 4");
    expect(plan.swaps[0]!.replaces).toBeNull();
    expect(swapInstructions(plan)).toContain("Load red PLA");
  });

  test("with no empty slot, it swaps out a spool the job does not need", () => {
    const full = [
      ...trays.slice(0, 3),
      { ...trays[1]!, slot: 3, trayId: 3, label: "AMS 1 slot 4", color: "#00AE42" },
    ];
    const plan = planFilaments(
      [
        { index: 1, type: "PLA", color: "#FFFFFF", grams: 10 },
        { index: 2, type: "PLA", color: "#2850E0", grams: 3 },
        { index: 3, type: "PLA", color: "#C12E1F", grams: 1 },
      ],
      full,
    );
    const target = plan.swaps[0]!.slot.trayId;
    expect([0, 1]).not.toContain(target);
    expect(swapInstructions(plan)).toMatch(/Swap AMS 1 slot \d from/);
  });

  test("material must match: a PETG need never maps to PLA", () => {
    const plan = planFilaments([{ index: 1, type: "PETG", color: "#FFFFFF", grams: 5 }], trays);
    expect(plan.ok).toBe(false);
  });

  test("an accepted substitute is honoured, but only within the material", () => {
    const need = [{ index: 1, type: "PLA", color: "#66CCFF", grams: 5 }];
    expect(planFilaments(need, trays).ok).toBe(false);
    expect(planFilaments(need, trays, { 1: 1 }).amsMapping).toEqual([1]);
    expect(planFilaments([{ ...need[0]!, type: "PETG" }], trays, { 1: 1 }).ok).toBe(false);
  });

  test("more colors than slots is reported, not dropped", () => {
    const needs = ["#C12E1F", "#FF6A13", "#F4D80F", "#00AE42", "#6A3FA0"].map((c, i) => ({
      index: i + 1,
      type: "PLA",
      color: c,
      grams: 1,
    }));
    const plan = planFilaments(needs, trays);
    expect(plan.unplaceable.length).toBeGreaterThan(0);
    expect(swapInstructions(plan)).toContain("No free slot");
  });

  test("the fingerprint changes when a spool changes and not otherwise", () => {
    const a = trayFingerprint(trays);
    expect(trayFingerprint(trays)).toBe(a);
    const changed = trays.map((t) => (t.trayId === 2 ? { ...t, color: "#C12E1F" } : t));
    expect(trayFingerprint(changed)).not.toBe(a);
    expect(trayFingerprint(changed, [0])).toBe(trayFingerprint(trays, [0]));
  });
});
