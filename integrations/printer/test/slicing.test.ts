import { describe, expect, test } from "bun:test";
import { describeToolpaths, parseGcode, seamSummary } from "../src/gcode.ts";
import { designId, stripHtml } from "../src/makerworld.ts";
import { type PageStatus, renderPage } from "../src/page.ts";
import { legend, projector, render } from "../src/preview.ts";
import { applyOverrides } from "../src/profiles.ts";
import { encodePng } from "../src/raster.ts";
import {
  notApplied,
  parseConfigBlock,
  parseSlicerLog,
  safeName,
  sliceArgs,
} from "../src/slicer.ts";
import { parseSliceInfo } from "../src/threemf.ts";

/** A two-layer square with an outer wall that starts at a corner, infill, a tool change and an arc. */
function gcode(seamAt: (layer: number) => [number, number]): string {
  const lines = [
    "G90",
    "M83",
    "; FEATURE: Custom",
    "G1 X1 Y1 E5 ; purge line before layer 1, not part of the print",
  ];
  for (let l = 0; l < 4; l++) {
    const z = 0.2 * (l + 1);
    const [sx, sy] = seamAt(l);
    lines.push(
      "; CHANGE_LAYER",
      `; Z_HEIGHT: ${z.toFixed(1)}`,
      "; LAYER_HEIGHT: 0.2",
      `G1 Z${z.toFixed(1)}`,
    );
    if (l === 2) lines.push("T1");
    lines.push("; FEATURE: Outer wall", `G1 X${sx} Y${sy} F9000`);
    const corners: Array<[number, number]> = [
      [100, 100],
      [120, 100],
      [120, 120],
      [100, 120],
    ];
    const start = corners.findIndex(([x, y]) => x === sx && y === sy);
    for (let k = 1; k <= 4; k++) {
      const [x, y] = corners[(start + k) % 4]!;
      lines.push(`G1 X${x} Y${y} E0.5`);
    }
    lines.push(
      "; FEATURE: Sparse infill",
      "G1 X102 Y102",
      "G1 X118 Y118 E0.4",
      "G2 X118 Y102 I0 J-8 E0.3",
    );
  }
  return lines.join("\n");
}

describe("reading the toolpaths", () => {
  const t = parseGcode(gcode(() => [100, 100]));

  test("layers, features, tool changes and the bounding box", () => {
    expect(t.layers).toHaveLength(4);
    expect(t.layers[0]!.z).toBeCloseTo(0.2);
    expect(t.toolChanges).toBe(1);
    expect(t.bbox.minX).toBe(100);
    expect(t.bbox.maxY).toBe(120);
    expect(t.count).toBeGreaterThan(4 * 5);
  });

  test("the purge before the first layer is not part of the print", () => {
    expect(t.bbox.minX).toBeGreaterThan(1);
  });

  test("a seam is where each outer loop starts", () => {
    expect(t.seams).toHaveLength(4);
    expect(t.seams.every((s) => s.x === 100 && s.y === 100)).toBe(true);
    expect(seamSummary(t)).toContain("lined up toward the front-left");
  });

  test("seams that move every layer read as scattered", () => {
    const corners: Array<[number, number]> = [
      [100, 100],
      [120, 100],
      [120, 120],
      [100, 120],
    ];
    expect(seamSummary(parseGcode(gcode((l) => corners[l % 4]!)))).toContain("scattered");
  });

  test("the summary names supports, seams and changes", () => {
    const d = describeToolpaths(t).join("\n");
    expect(d).toContain("4 layers");
    expect(d).toContain("Supports: none");
    expect(d).toContain("Filament changes: 1");
  });
});

describe("pictures of the toolpaths", () => {
  const t = parseGcode(gcode(() => [100, 100]));

  test("every view renders a real PNG", () => {
    for (const view of [
      "iso",
      "top",
      "front",
      "seams",
      "supports",
      "layer",
      "first_layer",
    ] as const) {
      const r = render(t, { view, layer: 2, size: 256 });
      expect([...r.png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(r.caption.length).toBeGreaterThan(10);
    }
  });

  test("the camera conventions: front sees X across and Z up, top sees Y up", () => {
    const front = projector({ theta: 0, phi: 0 });
    expect(front(10, 0, 0)[0]).toBeCloseTo(10);
    expect(front(0, 0, 10)[1]).toBeCloseTo(-10);
    const top = projector({ theta: 0, phi: 90 });
    expect(top(0, 10, 0)[1]).toBeCloseTo(-10, 3);
  });

  test("the legend lists what is drawn", () => {
    expect(legend(t, { view: "iso" })).toContain("Outer wall");
    expect(
      legend(t, { view: "iso", colorBy: "filament", filamentColors: ["#FFFFFF", "#000000"] }),
    ).toContain("filament 2 = #000000");
  });

  test("the PNG encoder writes a valid header for odd sizes", () => {
    const png = encodePng(3, 2, new Uint8Array(18));
    expect(png.readUInt32BE(16)).toBe(3);
    expect(png.readUInt32BE(20)).toBe(2);
  });
});

describe("the slicer's words", () => {
  const log = [
    "[2026-10-25 16:44:30.509] [0x1] [warning] plate 1: found NON_CRITICAL slicing warnings: It seems object tee.stl has floating cantilever. Please re-orient the object or enable support generation.",
    "[2026-10-25 16:44:31.086] [0x1] [warning] plate 1: found slicing warnings: Object can't be printed for empty layer between 10 and 20.2., no_check=0",
    "[2026-10-25 16:44:31.090] [0x1] [error] got error when validate: Filament does not match the plate",
    "[2026-10-25 16:44:31.099] [0x1] [error]   Invalid T command (T65535).",
  ].join("\n");

  test("warnings and errors come out as the app shows them", () => {
    const r = parseSlicerLog(log);
    expect(r.warnings).toContain(
      "It seems object tee.stl has floating cantilever. Please re-orient the object or enable support generation.",
    );
    expect(r.warnings).toContain("Object can't be printed for empty layer between 10 and 20.2.");
    expect(r.errors).toEqual(["Filament does not match the plate"]);
  });

  test("what was applied is read back from the G-code, not assumed", () => {
    const cfg = parseConfigBlock(
      "; CONFIG_BLOCK_START\n; brim_type = outer_only\n; wall_loops = 3\n; nozzle_temperature = 220,220\n; CONFIG_BLOCK_END\n",
    );
    expect(cfg.brim_type).toBe("outer_only");
    expect(
      notApplied({ brim_type: "outer_only", wall_loops: 3, nozzle_temperature: 220 }, cfg),
    ).toEqual([]);
    expect(notApplied({ wall_loops: 4, bogus: 1 }, cfg)).toEqual([
      "wall_loops (asked 4, slicer used 3)",
      "bogus (no such setting)",
    ]);
  });

  test("overrides take the profile's own shape", () => {
    const p = applyOverrides(
      { name: "x", wall_loops: "2", bridge_speed: ["50", "50"] },
      { wall_loops: 4, bridge_speed: 30, enable: true },
    );
    expect(p.profile.wall_loops).toBe("4");
    expect(p.profile.bridge_speed).toEqual(["30", "30"]);
    expect(p.unknown).toEqual(["enable"]);
  });

  test("the CLI call carries plate, transforms and the plate to slice", () => {
    const a = sliceArgs({
      datadir: "/d",
      settingsFiles: ["/m.json", "/p.json"],
      filamentFiles: ["/f1.json"],
      colors: ["#FFFFFF"],
      outDir: "/o",
      outName: "x.gcode.3mf",
      mode: "print",
      model: "/m.3mf",
      scale: 1.5,
      rotate: { z: 90, x: 0 },
      plateIndex: 2,
    });
    expect(a.join(" ")).toContain("--slice 2");
    expect(a.join(" ")).toContain("--scale 1.5");
    expect(a.join(" ")).toContain("--rotate 90");
    expect(a).not.toContain("--rotate-x");
    expect(a.at(-1)).toBe("/m.3mf");
  });

  test("slice info gives each filament's grams and the plate's time", () => {
    const xml = `<config><plate><metadata key="index" value="1"/><metadata key="prediction" value="935"/><metadata key="weight" value="3.66"/><metadata key="support_used" value="false"/><object identify_id="15" name="cube.stl" skipped="false" /><filament id="1" tray_info_idx="GFA00" type="PLA" color="#00AE42" used_m="1.21" used_g="3.66"/></plate></config>`;
    const [p] = parseSliceInfo(xml);
    expect(p).toEqual({
      index: 1,
      predictionS: 935,
      weightG: 3.66,
      needs: [{ index: 1, type: "PLA", color: "#00AE42", grams: 3.66, infoIdx: "GFA00" }],
      supportUsed: false,
      objects: ["cube.stl"],
    });
  });

  test("names are safe on the printer and on disk", () => {
    expect(safeName("Sam's dragon!.gcode.3mf")).toBe("Sams_dragon");
    expect(safeName("../../etc")).toBe("....etc");
  });
});

describe("MakerWorld", () => {
  test("a model id from a link, an id, or nothing", () => {
    expect(
      designId("https://makerworld.com/en/models/2735519-articulated-dragon#profileId-3032581"),
    ).toBe(2735519);
    expect(designId("2735519")).toBe(2735519);
    expect(designId("a dragon")).toBeNull();
  });

  test("descriptions lose their HTML", () => {
    expect(
      stripHtml("<h2><strong>Dragon</strong></h2><p>Fun &amp; flexible</p><ul><li>PLA</li></ul>"),
    ).toBe("Dragon\nFun & flexible\n- PLA");
  });
});

describe("the print page", () => {
  const status: PageStatus = {
    title: "<script>alert(1)</script>",
    requester: "Sam",
    printer: "the P2S",
    phase: "printing",
    phaseLabel: "Printing",
    stage: "",
    percent: 42,
    layer: 1,
    totalLayers: 2,
    remainingMin: 10,
    etaMs: null,
    startedMs: null,
    endedMs: null,
    nozzle: { temp: 220, target: 220 },
    bed: { temp: 65, target: 65 },
    speed: "standard",
    filaments: [],
    estimateS: 600,
    live: true,
    hasPreview: false,
    hasFinalPhoto: false,
    hasTimelapse: false,
    updatedMs: 0,
  };
  const html = renderPage(status);

  test("a title cannot inject a script", () => {
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("\\u003cscript>alert(1)\\u003c/script>");
  });

  test("it fetches its data by relative paths under its own token", () => {
    expect(html).toContain('"status.json?t="');
    expect(html).toContain('"frame.jpg?t="');
    expect(html).not.toMatch(/fetch\("\//);
  });

  test("no emoji anywhere on the page", () => {
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  test("it is private and phone-sized", () => {
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).toContain("width=device-width");
  });
});
