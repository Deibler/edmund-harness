import { describe, expect, test } from "bun:test";
import { trayFingerprint } from "../src/filament.ts";
import { loadErrorDb } from "../src/hms.ts";
import { type PrinterState, normalize } from "../src/report.ts";
import type { Watch } from "../src/store.ts";
import { allTrays, evaluateWatch, formatMinutes, statusLine } from "../src/watches.ts";

const db = loadErrorDb();
const st = (patch: Record<string, unknown>): PrinterState =>
  normalize({
    command: "push_status",
    gcode_state: "RUNNING",
    mc_percent: 10,
    layer_num: 5,
    total_layer_num: 100,
    mc_remaining_time: 90,
    subtask_name: "Dragon",
    hms: [],
    print_error: 0,
    ams: {
      ams: [
        {
          id: "0",
          tray: [
            { id: "0", state: 11, tray_type: "PLA", tray_color: "FFFFFFFF" },
            { id: "1", state: 10 },
          ],
        },
      ],
    },
    ...patch,
  });

const watch = (w: Partial<Watch>): Watch => ({
  id: 1,
  sessionKey: "s",
  kind: "progress",
  threshold: null,
  slot: null,
  note: "",
  jobId: null,
  printKey: "",
  createdMs: 0,
  firedMs: null,
  repeat: false,
  active: true,
  auto: false,
  baseline: "",
  ...w,
});
const ctx = (printKey = "P1", traysStable = true) => ({ printKey, traysStable, db });

describe("wake-ups", () => {
  test("progress fires at its percent on its own print, not on another", () => {
    const w = watch({ kind: "progress", threshold: 50, printKey: "P1" });
    expect(evaluateWatch(w, null, st({ mc_percent: 49 }), ctx())).toBeNull();
    expect(evaluateWatch(w, null, st({ mc_percent: 50 }), ctx())).toContain("50%");
    expect(evaluateWatch(w, null, st({ mc_percent: 80 }), ctx("P2"))).toBeNull();
    expect(evaluateWatch(w, null, st({ mc_percent: 80, gcode_state: "FINISH" }), ctx())).toBeNull();
  });

  test("layer fires at its layer", () => {
    const w = watch({ kind: "layer", threshold: 30 });
    expect(evaluateWatch(w, null, st({ layer_num: 29 }), ctx())).toBeNull();
    expect(evaluateWatch(w, null, st({ layer_num: 30 }), ctx())).toContain("layer 30 of 100");
  });

  test("finish fires on the edge into FINISH or FAILED, not on a printer sitting finished", () => {
    const w = watch({ kind: "finish", printKey: "P1" });
    expect(evaluateWatch(w, st({}), st({ gcode_state: "FINISH" }), ctx())).toBe(
      "the print finished",
    );
    expect(evaluateWatch(w, st({}), st({ gcode_state: "FAILED" }), ctx())).toContain(
      "stopped before finishing",
    );
    expect(
      evaluateWatch(w, st({ gcode_state: "FINISH" }), st({ gcode_state: "FINISH" }), ctx()),
    ).toBeNull();
    expect(evaluateWatch(w, st({}), st({ gcode_state: "FINISH" }), ctx("P2"))).toBeNull();
  });

  test("state fires on any change", () => {
    const w = watch({ kind: "state", repeat: true });
    expect(evaluateWatch(w, st({}), st({ gcode_state: "PAUSE" }), ctx())).toContain(
      "printing to paused",
    );
    expect(evaluateWatch(w, st({}), st({}), ctx())).toBeNull();
  });

  test("error fires on a new code only, in Bambu's words", () => {
    const w = watch({ kind: "error", repeat: true });
    const err = { attr: 0x03000000, code: 0x00030001 };
    expect(evaluateWatch(w, st({}), st({ hms: [err] }), ctx())).toContain("0300_0000_0003_0001");
    expect(evaluateWatch(w, st({ hms: [err] }), st({ hms: [err] }), ctx())).toBeNull();
    expect(evaluateWatch(w, st({}), st({ print_error: 0x0300400c }), ctx())).toContain(
      "The task was canceled.",
    );
  });

  test("filament fires when the AMS has settled on something new", () => {
    const before = st({});
    const after = st({
      ams: {
        ams: [
          {
            id: "0",
            tray: [
              { id: "0", state: 11, tray_type: "PLA", tray_color: "FFFFFFFF" },
              { id: "1", state: 11, tray_type: "PLA", tray_color: "C12E1FFF" },
            ],
          },
        ],
      },
    });
    const w = watch({ kind: "filament", baseline: trayFingerprint(allTrays(before)) });
    expect(evaluateWatch(w, before, after, ctx("", false))).toBeNull();
    expect(evaluateWatch(w, before, after, ctx("", true))).toContain("AMS 1 slot 2 red PLA");
    expect(evaluateWatch(w, before, before, ctx("", true))).toBeNull();
    const slot0 = watch({
      kind: "filament",
      slot: 0,
      baseline: trayFingerprint(allTrays(before), [0]),
    });
    expect(evaluateWatch(slot0, before, after, ctx("", true))).toBeNull();
  });

  test("status lines read like a person wrote them", () => {
    expect(statusLine(st({ mc_percent: 42, mc_remaining_time: 74 }))).toBe(
      '"Dragon" printing, 42%, layer 5/100, 1 h 14 min left',
    );
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(120)).toBe("2 h");
  });
});
