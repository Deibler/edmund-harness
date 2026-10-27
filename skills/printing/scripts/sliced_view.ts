/**
 * Save the sliced view of a print-ready file as one PNG to send people: the
 * toolpaths from the front right beside the first layer from above, both in
 * the real filament colours.
 *
 *   bun skills/printing/scripts/sliced_view.ts <file.gcode.3mf> <out.png>
 */
import { writeFileSync } from "node:fs";
import sharp from "sharp";
import { parseGcode } from "../../../integrations/printer/src/gcode.ts";
import { render } from "../../../integrations/printer/src/preview.ts";
import { readSliced, zipEntry } from "../../../integrations/printer/src/threemf.ts";

const [file, out] = process.argv.slice(2);
if (!file || !out) throw new Error("usage: sliced_view.ts <file.gcode.3mf> <out.png>");

const plate = readSliced(file).gcodePlates[0];
if (plate === undefined) throw new Error(`${file} has no G-code; slice it first`);
const t = parseGcode(zipEntry(file, `Metadata/plate_${plate}.gcode`)!.toString("utf8"));
const project = zipEntry(file, "Metadata/project_settings.config")?.toString("utf8") ?? "{}";
const filamentColors = ((JSON.parse(project).filament_colour ?? []) as string[]).map((c) =>
  c.slice(0, 7),
);

const size = 1024;
const views = (["iso", "first_layer"] as const).map(
  (view) => render(t, { view, colorBy: "filament", filamentColors, size }).png,
);
const sheet = await sharp({
  create: { width: size * 2, height: size, channels: 3, background: { r: 34, g: 35, b: 38 } },
})
  .composite(views.map((input, i) => ({ input, left: i * size, top: 0 })))
  .png()
  .toBuffer();
writeFileSync(out, sheet);
console.log(out);
