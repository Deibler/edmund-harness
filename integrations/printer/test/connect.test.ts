import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AxNode,
  checkSendDialog,
  find,
  mayPress,
  readImport,
  readPrintPage,
  readSendDialog,
  sameFilament,
  shownName,
  slotName,
  texts,
} from "../src/connect.ts";

/**
 * Bambu Connect's screens as Accessibility reported them on 2026-10-25
 * (Bambu Connect 2.5.0-beta.15), with the printer and account renamed. If
 * Bambu reworks a screen, these readers are what must change, and a send
 * refuses rather than guesses until they do.
 */

const screen = (name: string): AxNode =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "connect", `${name}.json`), "utf8"));

const importScreen = screen("import");
const printPage = screen("print-page");
const sendDialog = screen("send-dialog");
const device = screen("device");

describe("reading Bambu Connect", () => {
  test("the import confirmation names the file and offers Import", () => {
    const s = readImport(importScreen);
    expect(s?.file).toBe("Cube_test");
    expect(texts(s!.confirm)).toEqual(["Import Gcode 3MF"]);
    expect(texts(s!.cancel!)).toEqual(["Cancel"]);
  });

  test("the print page shows the imported file, its plate and its summary", () => {
    const p = readPrintPage(printPage);
    expect(p?.file).toBe("Cube_test.3mf");
    expect(p?.print.title).toBe("Print");
    expect(p?.plates.map((x) => x.n)).toEqual([1]);
    expect(p?.details).toMatchObject({
      "Compatible Printer": "P2S",
      "Bed type": "Textured PEI Plate",
      Time: "22m",
    });
  });

  test("the send dialog: printer, plate, the slot chosen per filament, and each option", () => {
    const d = readSendDialog(sendDialog);
    expect(d?.printer).toBe("Workshop P2S");
    expect(d?.bed).toBe("PEI");
    expect(d?.filaments).toEqual([{ slot: "A2", type: "PLA" }]);
    expect(d?.options.Timelapse?.checked).toBe("Off");
    expect(d?.options["Auto bed leveling"]?.checked).toBe("Auto");
    expect(d?.options["Flow dynamic calibration"]?.checked).toBe("Auto");
    expect(Object.keys(d!.options.Timelapse!.choices)).toEqual(["On", "Off"]);
    expect(texts(d!.send)).toEqual(["Send"]);
    expect(texts(d!.cancel!)).toEqual(["Cancel"]);
  });

  test("a name Bambu Connect escaped reads back as the name that was sent", () => {
    // 2026-10-25: a title with apostrophes showed as "Sam&#39;s dragon", and the
    // send waited for a name that never appeared.
    const escaped = JSON.parse(
      JSON.stringify(importScreen).replace(
        'the file \\"Cube_test\\"',
        'the file \\"Sam&#39;s dragon (for Alex&#39;s niece)\\"',
      ),
    );
    expect(readImport(escaped)?.file).toBe("Sam's dragon (for Alex's niece)");
    expect(shownName("Tom &amp; Jerry &quot;v2&quot;.3mf")).toBe('Tom & Jerry "v2"');
    expect(shownName("Cube_test.3mf")).toBe("Cube_test");
  });

  test("each reader answers only for its own screen", () => {
    expect(readImport(printPage)).toBeNull();
    expect(readSendDialog(printPage)).toBeNull();
    expect(readPrintPage(sendDialog)).toBeNull();
    expect(readPrintPage(importScreen)).toBeNull();
    expect(readSendDialog(device)).toBeNull();
  });
});

describe("checking the send dialog against the approved job", () => {
  const d = readSendDialog(sendDialog)!;
  const want = { printer: "Workshop P2S", slots: ["A2"], timelapse: false };

  test("everything matches: nothing to stop it", () => {
    expect(checkSendDialog(d, want)).toEqual([]);
  });

  test("another printer selected", () => {
    expect(checkSendDialog(d, { ...want, printer: "Garage X1C" }).join(" ")).toMatch(
      /"Workshop P2S" selected, not "Garage X1C"/,
    );
  });

  test("the printer's account name unknown", () => {
    expect(checkSendDialog(d, { ...want, printer: "" }).join(" ")).toMatch(
      /name on the Bambu account/,
    );
  });

  test("a filament from a different slot than the plan", () => {
    expect(checkSendDialog(d, { ...want, slots: ["A3"] }).join(" ")).toMatch(
      /filament 1 from A2; the approved plan uses A3/,
    );
  });

  test("another slot holding the same filament is as good as the planned one", () => {
    const tray = (slot: number, color: string, type = "PLA") => ({
      unit: 0,
      slot,
      trayId: slot,
      label: `AMS 1 slot ${slot + 1}`,
      loaded: true,
      type,
      color,
      colors: [],
      infoIdx: "",
      subBrand: "",
      rfid: false,
      remainPct: null,
      nozzleTempMin: null,
      nozzleTempMax: null,
    });
    // A2 and A4 both blue PLA: Bambu Connect choosing A2 for a plan of A4 is fine.
    const alike = sameFilament([tray(1, "#0A5AD3"), tray(3, "#0B5BD2"), tray(2, "#000000")]);
    expect(checkSendDialog(d, { ...want, slots: ["A4"], alike })).toEqual([]);
    // A3 is black: not the same filament, so still refused.
    expect(checkSendDialog(d, { ...want, slots: ["A3"], alike }).join(" ")).toMatch(/plan uses A3/);
    // Same color, different material: refused.
    const petg = sameFilament([tray(1, "#0A5AD3"), tray(3, "#0A5AD3", "PETG")]);
    expect(checkSendDialog(d, { ...want, slots: ["A4"], alike: petg }).join(" ")).toMatch(
      /plan uses A4/,
    );
  });

  test("a different number of filaments than the plan", () => {
    expect(checkSendDialog(d, { ...want, slots: ["A2", "A1"] }).join(" ")).toMatch(
      /lists 1 filament\(s\).*the plan has 2/,
    );
  });

  test("the timelapse not set the way the config says", () => {
    expect(checkSendDialog(d, { ...want, timelapse: true }).join(" ")).toMatch(
      /Timelapse is Off in Bambu Connect, not On/,
    );
  });
});

describe("what the driver may press", () => {
  const d = readSendDialog(sendDialog)!;

  test("the controls a send needs", () => {
    expect(mayPress(sendDialog, d.send)).toBeNull();
    expect(mayPress(sendDialog, d.cancel!)).toBeNull();
    expect(mayPress(sendDialog, d.options.Timelapse!.choices.On!)).toBeNull();
    expect(mayPress(printPage, readPrintPage(printPage)!.print)).toBeNull();
    expect(mayPress(importScreen, readImport(importScreen)!.confirm)).toBeNull();
  });

  const withWindow = (n: AxNode): AxNode => ({
    path: "",
    role: "AXApplication",
    children: [
      { path: "0", role: "AXWindow", children: [n] },
      { path: "1", role: "AXMenuBar" },
    ],
  });

  test("never the menu bar, where the system menu lives", () => {
    const shutDown: AxNode = { path: "1.0.0.15", role: "AXMenuItem", title: "Shut Down" };
    expect(mayPress(withWindow(shutDown), shutDown)).toMatch(/outside Bambu Connect's window/);
    // Even a label on the list, if it is not in a window.
    const send: AxNode = { path: "1.0.0.1", role: "AXMenuItem", title: "Send" };
    expect(mayPress(withWindow(send), send)).toMatch(/outside/);
  });

  test("never logging the printer out, unbinding, or pausing", () => {
    for (const title of ["unlink Log Out Printer", "Pause", "Delete"]) {
      const n: AxNode = { path: "0.0", role: "AXMenuItem", title };
      expect(mayPress(withWindow(n), n)).toMatch(/never pressed/);
    }
  });

  test("nothing that is not on the list, and nothing disabled", () => {
    const rename: AxNode = { path: "0.0", role: "AXMenuItem", title: "Rename" };
    expect(mayPress(withWindow(rename), rename)).toMatch(/not on the list/);
    const unload = find(device, (n) => n.role === "AXButton" && n.title === "Unload")!;
    expect(mayPress(device, unload)).toMatch(/not on the list|disabled/);
    const off: AxNode = { path: "0.0", role: "AXButton", title: "Send", disabled: true };
    expect(mayPress(withWindow(off), off)).toMatch(/disabled/);
  });
});

test("tray names as Bambu Connect writes them", () => {
  expect(slotName({ unit: 0, slot: 0 })).toBe("A1");
  expect(slotName({ unit: 0, slot: 3 })).toBe("A4");
  expect(slotName({ unit: 1, slot: 1 })).toBe("B2");
  expect(slotName({ unit: 255, slot: 0 })).toBe("Ext");
});
