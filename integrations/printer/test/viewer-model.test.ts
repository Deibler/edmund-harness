import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildViewerModel, paintState, parseTransform } from "../src/viewer-model.ts";

const dir = mkdtempSync(join(tmpdir(), "printer-viewer-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("painted triangles", () => {
  test("Bambu's codes decode to the filament they show", () => {
    // Seen in a real sliced file (2026-10-25): 3,379 "4", 639 "8", 34,243 "0C".
    expect(paintState("4")).toBe(1);
    expect(paintState("8")).toBe(2);
    expect(paintState("0C")).toBe(3);
    expect(paintState("")).toBe(0);
    // Split four ways: three children unpainted, one the third filament.
    expect(paintState("0C0003")).toBe(0);
  });

  test("a transform that is not twelve numbers is no transform", () => {
    expect(parseTransform("1 0 0 0 1 0 0 0 1 5 6 7")).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 6, 7]);
    expect(parseTransform("1 2 3")).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    expect(parseTransform(undefined)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  });
});

/** A sliced project in the shape Bambu Studio writes: one object of two parts. */
function project(): string {
  const root = join(dir, "p");
  mkdirSync(join(root, "3D", "Objects"), { recursive: true });
  mkdirSync(join(root, "Metadata"), { recursive: true });
  const tetra = (paint: string[]) =>
    `<mesh><vertices>
<vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/>
</vertices><triangles>
${[
  [0, 2, 1],
  [0, 1, 3],
  [0, 3, 2],
  [1, 2, 3],
]
  .map(
    ([a, b, c], i) =>
      `<triangle v1="${a}" v2="${b}" v3="${c}"${paint[i] ? ` paint_color="${paint[i]}"` : ""}/>`,
  )
  .join("\n")}
</triangles></mesh>`;
  writeFileSync(
    join(root, "3D", "Objects", "object_1.model"),
    `<?xml version="1.0"?><model><resources>
<object id="1" type="model">${tetra(["", "", "8", ""])}</object>
<object id="2" type="model">${tetra(["", "", "", ""])}</object>
</resources></model>`,
  );
  writeFileSync(
    join(root, "3D", "3dmodel.model"),
    `<?xml version="1.0"?><model xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources>
<object id="3" type="model"><components>
<component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
<component p:path="/3D/Objects/object_1.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 20 0 0"/>
</components></object>
</resources><build>
<item objectid="3" transform="1 0 0 0 1 0 0 0 1 100 50 0" printable="1"/>
</build></model>`,
  );
  writeFileSync(
    join(root, "Metadata", "model_settings.config"),
    `<config><object id="3"><metadata key="extruder" value="1"/>
<part id="1" subtype="normal_part"><metadata key="extruder" value="1"/></part>
<part id="2" subtype="normal_part"><metadata key="extruder" value="3"/></part>
</object>
<plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/></model_instance></plate>
</config>`,
  );
  writeFileSync(
    join(root, "Metadata", "project_settings.config"),
    JSON.stringify({
      filament_colour: ["#2850E0FF", "#161616", "#FFFFFF"],
      printable_area: ["0x0", "256x0", "256x256", "0x256"],
    }),
  );
  writeFileSync(
    join(root, "Metadata", "plate_1.json"),
    JSON.stringify({
      bbox_objects: [
        { name: "thing", bbox: [100, 50, 130, 60] },
        { name: "wipe_tower", bbox: [200, 200, 230, 240] },
      ],
    }),
  );
  const file = join(dir, "thing.gcode.3mf");
  const r = Bun.spawnSync(["/usr/bin/zip", "-qr", file, "."], { cwd: root });
  if (r.exitCode !== 0) throw new Error("zip failed");
  return file;
}

describe("the 3D view of a plate", () => {
  test("parts are placed, colored by filament and paint, and the tower comes along", async () => {
    const { info, bin } = await buildViewerModel(project(), 1);
    expect(info.triangles).toBe(8);
    expect(info.vertices).toBe(8);
    expect(info.bed).toEqual({ w: 256, d: 256 });
    expect(info.colors).toEqual(["#2850E0", "#161616", "#FFFFFF"]);
    // The object's placement (100, 50) plus the second part's own 20 mm.
    expect(info.min.map(Math.round)).toEqual([100, 50, 0]);
    expect(info.max.map(Math.round)).toEqual([130, 60, 10]);
    expect(info.tower).toEqual({ x0: 200, y0: 200, x1: 230, y1: 240, h: 10 });

    const raw = Bun.gunzipSync(new Uint8Array(bin));
    const padded = (info.vertices * 6 + 3) & ~3;
    const filaments = [...raw.subarray(padded + info.triangles * 12)];
    // Part 1 is filament 1 with one triangle painted the second; part 2 is filament 3.
    expect(filaments).toEqual([1, 1, 2, 1, 3, 3, 3, 3]);
  });

  test("a plate with nothing on it is an error, not an empty view", async () => {
    await expect(buildViewerModel(project(), 2)).rejects.toThrow("nothing on plate 2");
  });
});
