import { FEATURES, type Feature, type Toolpaths } from "./gcode.ts";
import { Canvas, type RGB, hexRgb, shade } from "./raster.ts";

/**
 * Pictures of the sliced toolpaths, the way Bambu Studio's preview shows
 * them: from any side, coloured by feature or by filament, one layer at a
 * time, with the seams marked, or with the supports or overhangs picked out.
 */

export const VIEWS = [
  "iso",
  "iso_back",
  "top",
  "front",
  "back",
  "left",
  "right",
  "seams",
  "supports",
  "overhangs",
  "layer",
  "first_layer",
] as const;
export type View = (typeof VIEWS)[number];

/** Close to Bambu Studio's legend colours, so a person comparing the two sees the same thing. */
export const FEATURE_COLORS: Record<Feature, string> = {
  "Outer wall": "#FF7D38",
  "Inner wall": "#FFDA5C",
  "Overhang wall": "#4D7CFE",
  "Sparse infill": "#B03029",
  "Internal solid infill": "#9A5CC6",
  "Top surface": "#F2364D",
  "Bottom surface": "#5D6CC4",
  Bridge: "#4DB8D9",
  "Internal bridge": "#7AC9E0",
  "Gap infill": "#FFFFFF",
  Support: "#00C76A",
  "Support interface": "#127A43",
  "Support transition": "#4FA07A",
  Skirt: "#00A3A3",
  Brim: "#00A3A3",
  "Prime tower": "#8C8C8C",
  "Floating vertical shell": "#D9849A",
  Ironing: "#FF9FC4",
  Custom: "#5E5E5E",
  Other: "#7A7A7A",
};

const BG: RGB = [34, 35, 38];
const BED: RGB = [70, 72, 76];
const MUTED: RGB = [150, 152, 156];
const SEAM: RGB = [255, 40, 40];
const BED_SIZE = 256;

type Cam = { theta: number; phi: number };

const CAMERAS: Record<string, Cam> = {
  iso: { theta: -45, phi: 30 },
  iso_back: { theta: 135, phi: 30 },
  top: { theta: 0, phi: 90 },
  front: { theta: 0, phi: 0 },
  back: { theta: 180, phi: 0 },
  left: { theta: 90, phi: 0 },
  right: { theta: -90, phi: 0 },
};

/** Orthographic projection: screen x right, screen y down, depth toward the camera. */
export function projector(cam: Cam) {
  const t = (cam.theta * Math.PI) / 180;
  const p = (Math.min(cam.phi, 89.999) * Math.PI) / 180;
  const c = [-Math.sin(t) * Math.cos(p), -Math.cos(t) * Math.cos(p), Math.sin(p)];
  const r = [Math.cos(t), -Math.sin(t), 0];
  const f = [-c[0]!, -c[1]!, -c[2]!];
  const u = [
    r[1]! * f[2]! - r[2]! * f[1]!,
    r[2]! * f[0]! - r[0]! * f[2]!,
    r[0]! * f[1]! - r[1]! * f[0]!,
  ];
  return (x: number, y: number, z: number): [number, number, number] => [
    x * r[0]! + y * r[1]! + z * r[2]!,
    -(x * u[0]! + y * u[1]! + z * u[2]!),
    x * c[0]! + y * c[1]! + z * c[2]!,
  ];
}

export type RenderOptions = {
  view: View;
  layer?: number;
  colorBy?: "feature" | "filament";
  filamentColors?: string[];
  size?: number;
};

function segColor(t: Toolpaths, i: number, o: RenderOptions): RGB {
  if (o.colorBy === "filament") return hexRgb(o.filamentColors?.[t.tool[i]!] ?? "#CCCCCC");
  return hexRgb(FEATURE_COLORS[FEATURES[t.feature[i]!] ?? "Other"]);
}

const isSupport = (f: number) =>
  ["Support", "Support interface", "Support transition"].includes(FEATURES[f]!);
const isOverhang = (f: number) =>
  ["Overhang wall", "Bridge", "Internal bridge"].includes(FEATURES[f]!);

export function render(t: Toolpaths, o: RenderOptions): { png: Buffer; caption: string } {
  const size = o.size ?? 1024;
  const canvas = new Canvas(size, size, BG);
  const flat = o.view === "layer" || o.view === "first_layer";
  const camName = flat
    ? "top"
    : ["seams", "supports", "overhangs"].includes(o.view)
      ? "iso"
      : o.view;
  const proj = projector(CAMERAS[camName] ?? CAMERAS.iso!);
  const layerIdx =
    o.view === "first_layer" ? 0 : Math.max(0, Math.min(t.layers.length - 1, (o.layer ?? 1) - 1));

  // Fit the part, not the whole bed.
  const b = t.bbox;
  const corners: Array<[number, number, number]> = [];
  for (const x of [b.minX, b.maxX])
    for (const y of [b.minY, b.maxY])
      for (const z of [flat ? 0 : b.minZ, flat ? 0 : b.maxZ]) corners.push(proj(x, y, z));
  let minX = Math.min(...corners.map((c) => c[0]));
  let maxX = Math.max(...corners.map((c) => c[0]));
  let minY = Math.min(...corners.map((c) => c[1]));
  let maxY = Math.max(...corners.map((c) => c[1]));
  const minD = Math.min(...corners.map((c) => c[2]));
  const maxD = Math.max(...corners.map((c) => c[2]));
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxX = BED_SIZE;
    minY = 0;
    maxY = BED_SIZE;
  }
  const margin = 0.08 * size;
  const scale = Math.min(
    (size - 2 * margin) / Math.max(1e-6, maxX - minX),
    (size - 2 * margin) / Math.max(1e-6, maxY - minY),
  );
  const ox = (size - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = (size - (maxY - minY) * scale) / 2 - minY * scale;
  const toScreen = (x: number, y: number, z: number): [number, number, number] => {
    const [sx, sy, d] = proj(x, y, z);
    return [sx * scale + ox, sy * scale + oy, d];
  };
  const width = Math.max(1, Math.min(5, Math.round(scale * 0.45)));
  const depthShade = (d: number) => 0.55 + 0.45 * ((d - minD) / Math.max(1e-6, maxD - minD));

  // The bed outline and a coarse grid, for orientation.
  if (!["front", "back", "left", "right"].includes(camName)) {
    for (let g = 0; g <= BED_SIZE; g += 32) {
      const a = toScreen(g, 0, 0);
      const c = toScreen(g, BED_SIZE, 0);
      canvas.line(a[0], a[1], -1e9, c[0], c[1], -1e9, BED, 1);
      const d = toScreen(0, g, 0);
      const e = toScreen(BED_SIZE, g, 0);
      canvas.line(d[0], d[1], -1e9, e[0], e[1], -1e9, BED, 1);
    }
  }

  const draw = (i: number, color: RGB, w = width) => {
    const k = i * 5;
    const z = t.xy[k + 4]!;
    const p0 = toScreen(t.xy[k]!, t.xy[k + 1]!, z);
    const p1 = toScreen(t.xy[k + 2]!, t.xy[k + 3]!, z);
    const c = flat ? color : shade(color, depthShade((p0[2] + p1[2]) / 2));
    canvas.line(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], c, w);
  };

  let caption = "";
  if (flat) {
    const L = t.layers[layerIdx];
    if (L) {
      const prev = t.layers[layerIdx - 1];
      if (prev) for (let i = prev.first; i < prev.end; i++) draw(i, [62, 64, 68], width);
      // Depth is irrelevant from the top within one layer; draw in order so later paths sit on top.
      for (let i = L.first; i < L.end; i++) {
        const k = i * 5;
        const p0 = toScreen(t.xy[k]!, t.xy[k + 1]!, 0);
        const p1 = toScreen(t.xy[k + 2]!, t.xy[k + 3]!, 0);
        canvas.line(p0[0], p0[1], 0, p1[0], p1[1], 0, segColor(t, i, o), width, true);
      }
      for (const s of t.seams) {
        if (s.layer !== layerIdx) continue;
        const p = toScreen(s.x, s.y, 0);
        canvas.dot(p[0], p[1], Math.max(3, width + 1), SEAM);
      }
      caption = `Layer ${layerIdx + 1} of ${t.layers.length} at Z ${L.z.toFixed(2)} mm, seen from above (red dots: where each outer wall loop starts).`;
    }
  } else {
    for (let i = 0; i < t.count; i++) {
      const f = t.feature[i]!;
      if (o.view === "seams") draw(i, f === 0 ? [205, 207, 210] : MUTED);
      else if (o.view === "supports")
        draw(i, isSupport(f) ? hexRgb(FEATURE_COLORS.Support) : MUTED);
      else if (o.view === "overhangs")
        draw(i, isOverhang(f) ? hexRgb(FEATURE_COLORS["Overhang wall"]) : MUTED);
      else draw(i, segColor(t, i, o));
    }
    if (o.view === "seams") {
      for (const s of t.seams) {
        const p = toScreen(s.x, s.y, s.z);
        // A seam hidden behind the part should not show through it.
        const px = Math.round(p[0]);
        const py = Math.round(p[1]);
        const idx = py * size + px;
        if (px >= 0 && py >= 0 && px < size && py < size && canvas.depth[idx]! > p[2] + 2) continue;
        canvas.dot(p[0], p[1], Math.max(2, width), SEAM);
      }
    }
    const names: Record<string, string> = {
      iso: "from the front right",
      iso_back: "from the back left",
      top: "from above",
      front: "from the front",
      back: "from the back",
      left: "from the left",
      right: "from the right",
      seams: "from the front right, seams in red",
      supports: "from the front right, supports in green",
      overhangs: "from the front right, overhang walls and bridges in blue",
    };
    caption = `Sliced toolpaths ${names[o.view] ?? ""}, ${o.colorBy === "filament" ? "colored by filament" : "colored by feature"}.`;
  }
  return { png: canvas.png(), caption };
}

/** The colors in a picture, as words, since the picture has no legend. */
export function legend(t: Toolpaths, o: RenderOptions): string {
  if (o.colorBy === "filament") {
    const tools = [...new Set(Array.from(t.tool.subarray(0, t.count)))].sort((a, b) => a - b);
    return tools.map((n) => `filament ${n + 1} = ${o.filamentColors?.[n] ?? "?"}`).join(", ");
  }
  const present = new Set(Array.from(t.feature.subarray(0, t.count)));
  return FEATURES.filter((_, i) => present.has(i))
    .map((f) => `${f} ${FEATURE_COLORS[f]}`)
    .join(", ");
}
