/**
 * The sliced toolpaths, read back from the G-code the printer will run.
 *
 * Bambu Studio annotates its output: `; CHANGE_LAYER` and `; Z_HEIGHT:` at
 * each layer, `; FEATURE: Outer wall` (or Sparse infill, Support, Bridge…)
 * before each kind of extrusion, `T<n>` for a filament change. That is enough
 * to rebuild the preview the app shows: every extrusion as a segment tagged
 * with its layer, feature and filament, and the seam of every outer wall
 * loop (where the loop starts after a travel). Arcs (G2/G3 from arc fitting)
 * are flattened into short segments.
 */

export const FEATURES = [
  "Outer wall",
  "Inner wall",
  "Overhang wall",
  "Sparse infill",
  "Internal solid infill",
  "Top surface",
  "Bottom surface",
  "Bridge",
  "Internal bridge",
  "Gap infill",
  "Support",
  "Support interface",
  "Support transition",
  "Skirt",
  "Brim",
  "Prime tower",
  "Floating vertical shell",
  "Ironing",
  "Custom",
  "Other",
] as const;

export type Feature = (typeof FEATURES)[number];

const FEATURE_INDEX = new Map<string, number>(FEATURES.map((f, i) => [f.toLowerCase(), i]));
export const OUTER_WALL = 0;
const OTHER = FEATURES.indexOf("Other");

export function featureIndex(name: string): number {
  return FEATURE_INDEX.get(name.trim().toLowerCase()) ?? OTHER;
}

export type Toolpaths = {
  /** Segments as x0,y0,x1,y1,z per entry. */
  xy: Float32Array;
  feature: Uint8Array;
  tool: Uint8Array;
  layerOf: Uint16Array;
  count: number;
  layers: Array<{ z: number; height: number; first: number; end: number }>;
  seams: Array<{ x: number; y: number; z: number; layer: number }>;
  toolChanges: number;
  /** Extruded filament length per feature, mm of filament. */
  extruded: number[];
  /** Path length per feature, mm. */
  pathLength: number[];
  bbox: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  travelMoves: number;
  retractions: number;
};

class Grow {
  xy = new Float32Array(5 * 65536);
  feature = new Uint8Array(65536);
  tool = new Uint8Array(65536);
  layerOf = new Uint16Array(65536);
  count = 0;
  push(x0: number, y0: number, x1: number, y1: number, z: number, f: number, t: number, l: number) {
    if (this.count === this.feature.length) {
      const n = this.feature.length * 2;
      const xy = new Float32Array(5 * n);
      xy.set(this.xy);
      this.xy = xy;
      const fe = new Uint8Array(n);
      fe.set(this.feature);
      this.feature = fe;
      const to = new Uint8Array(n);
      to.set(this.tool);
      this.tool = to;
      const la = new Uint16Array(n);
      la.set(this.layerOf);
      this.layerOf = la;
    }
    const i = this.count++;
    this.xy[i * 5] = x0;
    this.xy[i * 5 + 1] = y0;
    this.xy[i * 5 + 2] = x1;
    this.xy[i * 5 + 3] = y1;
    this.xy[i * 5 + 4] = z;
    this.feature[i] = f;
    this.tool[i] = t;
    this.layerOf[i] = Math.min(l, 65535);
  }
}

function word(line: string, letter: string): number | null {
  const i = line.indexOf(letter);
  if (i < 0) return null;
  // The letter must start a word (" X12.3"), not sit inside a comment.
  const semi = line.indexOf(";");
  if (semi >= 0 && i > semi) return null;
  if (i > 0 && line[i - 1] !== " ") {
    const again = line.indexOf(` ${letter}`);
    if (again < 0 || (semi >= 0 && again > semi)) return null;
    return Number.parseFloat(line.slice(again + 2));
  }
  return Number.parseFloat(line.slice(i + 1));
}

export function parseGcode(text: string): Toolpaths {
  const out = new Grow();
  const layers: Toolpaths["layers"] = [];
  const seams: Toolpaths["seams"] = [];
  const extruded = FEATURES.map(() => 0);
  const pathLength = FEATURES.map(() => 0);
  let x = 0;
  let y = 0;
  let z = 0;
  let absXY = true;
  let absE = false;
  let feature = OTHER;
  let tool = 0;
  let toolChanges = 0;
  let layer = -1;
  let layerZ = 0;
  let layerH = 0;
  /** True until the first extrusion after a travel inside an outer wall: that point is a seam. */
  let loopStart = true;
  let travelMoves = 0;
  let retractions = 0;
  let inPrint = false;
  const bbox = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  };

  const extrude = (x1: number, y1: number, e: number) => {
    if (layer < 0) return;
    if (feature === OUTER_WALL && loopStart) seams.push({ x, y, z: layerZ, layer });
    loopStart = false;
    out.push(x, y, x1, y1, layerZ, feature, tool, layer);
    const len = Math.hypot(x1 - x, y1 - y);
    extruded[feature]! += e;
    pathLength[feature]! += len;
    bbox.minX = Math.min(bbox.minX, x, x1);
    bbox.maxX = Math.max(bbox.maxX, x, x1);
    bbox.minY = Math.min(bbox.minY, y, y1);
    bbox.maxY = Math.max(bbox.maxY, y, y1);
    bbox.minZ = Math.min(bbox.minZ, layerZ);
    bbox.maxZ = Math.max(bbox.maxZ, layerZ);
  };

  let pos = 0;
  while (pos < text.length) {
    let nl = text.indexOf("\n", pos);
    if (nl < 0) nl = text.length;
    const line = text.slice(pos, nl).trim();
    pos = nl + 1;
    if (!line) continue;
    if (line[0] === ";") {
      if (line.startsWith("; FEATURE:")) {
        feature = featureIndex(line.slice(10));
        loopStart = true;
      } else if (line.startsWith("; CHANGE_LAYER") || line.startsWith(";LAYER_CHANGE")) {
        layer++;
        layers.push({ z: layerZ, height: layerH, first: out.count, end: out.count });
        inPrint = true;
      } else if (line.startsWith("; Z_HEIGHT:")) {
        layerZ = Number.parseFloat(line.slice(11));
        const L = layers[layers.length - 1];
        if (L) L.z = layerZ;
      } else if (line.startsWith("; LAYER_HEIGHT:")) {
        layerH = Number.parseFloat(line.slice(15));
        const L = layers[layers.length - 1];
        if (L) L.height = layerH;
      }
      continue;
    }
    const c = line[0];
    if (c === "T") {
      const n = Number.parseInt(line.slice(1), 10);
      // Tool 0 until told otherwise; a change counts once the print proper has begun.
      if (Number.isFinite(n) && n < 64) {
        if (n !== tool && inPrint) toolChanges++;
        tool = n;
      }
      continue;
    }
    if (c === "M") {
      if (line.startsWith("M83")) absE = false;
      else if (line.startsWith("M82")) absE = true;
      continue;
    }
    if (c !== "G") continue;
    const g = Number.parseInt(line.slice(1), 10);
    if (g === 90) {
      absXY = true;
      continue;
    }
    if (g === 91) {
      absXY = false;
      continue;
    }
    if (g === 92) {
      continue;
    }
    if (g !== 0 && g !== 1 && g !== 2 && g !== 3) continue;
    const X = word(line, "X");
    const Y = word(line, "Y");
    const Z = word(line, "Z");
    const E = word(line, "E");
    const nx = X === null ? x : absXY ? X : x + X;
    const ny = Y === null ? y : absXY ? Y : y + Y;
    if (Z !== null) z = absXY ? Z : z + Z;
    const e = E === null ? 0 : absE ? 0 : E;
    if (E !== null && e < 0) retractions++;
    const moving = nx !== x || ny !== y;
    if (g === 2 || g === 3) {
      const I = word(line, "I") ?? 0;
      const J = word(line, "J") ?? 0;
      const cx = x + I;
      const cy = y + J;
      const r = Math.hypot(I, J);
      const a0 = Math.atan2(y - cy, x - cx);
      let a1 = Math.atan2(ny - cy, nx - cx);
      if (g === 2 && a1 >= a0) a1 -= 2 * Math.PI;
      if (g === 3 && a1 <= a0) a1 += 2 * Math.PI;
      if (!moving) a1 = a0 + (g === 2 ? -2 : 2) * Math.PI;
      const steps = Math.max(2, Math.ceil((Math.abs(a1 - a0) * r) / 1.5));
      if (e <= 0) {
        travelMoves++;
        loopStart = true;
      }
      let px = x;
      let py = y;
      for (let k = 1; k <= steps; k++) {
        const a = a0 + ((a1 - a0) * k) / steps;
        const qx = k === steps ? nx : cx + r * Math.cos(a);
        const qy = k === steps ? ny : cy + r * Math.sin(a);
        if (e > 0) extrude(qx, qy, e / steps);
        x = qx;
        y = qy;
        px = qx;
        py = qy;
      }
      x = px;
      y = py;
      continue;
    }
    if (moving) {
      if (e > 0) extrude(nx, ny, e);
      else {
        travelMoves++;
        loopStart = true;
      }
      x = nx;
      y = ny;
    }
  }
  for (let i = 0; i < layers.length; i++)
    layers[i]!.end = i + 1 < layers.length ? layers[i + 1]!.first : out.count;
  return {
    xy: out.xy,
    feature: out.feature,
    tool: out.tool,
    layerOf: out.layerOf,
    count: out.count,
    layers,
    seams,
    toolChanges,
    extruded,
    pathLength,
    bbox,
    travelMoves,
    retractions,
  };
}

/** Where the seams sit: lined up on one side, or scattered. */
export function seamSummary(t: Toolpaths): string {
  if (t.seams.length === 0) return "no outer wall seams (no outer walls)";
  const cx = (t.bbox.minX + t.bbox.maxX) / 2;
  const cy = (t.bbox.minY + t.bbox.maxY) / 2;
  let sx = 0;
  let sy = 0;
  for (const s of t.seams) {
    const a = Math.atan2(s.y - cy, s.x - cx);
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  const n = t.seams.length;
  const R = Math.hypot(sx, sy) / n;
  const mean = (Math.atan2(sy, sx) * 180) / Math.PI;
  const dir = compass(mean);
  const perLayer = (n / Math.max(1, t.layers.length)).toFixed(1);
  if (R > 0.75)
    return `${n} seams (${perLayer} per layer), lined up toward the ${dir} side of the part`;
  if (R > 0.4) return `${n} seams (${perLayer} per layer), mostly toward the ${dir} side`;
  return `${n} seams (${perLayer} per layer), scattered around the part`;
}

function compass(deg: number): string {
  const d = (deg + 360) % 360;
  const names = [
    "right (+X)",
    "back-right",
    "back (+Y)",
    "back-left",
    "left (-X)",
    "front-left",
    "front (-Y)",
    "front-right",
  ];
  return names[Math.round(d / 45) % 8]!;
}

/** Plain-language facts about the toolpaths. */
export function describeToolpaths(t: Toolpaths): string[] {
  const lines: string[] = [];
  const { bbox } = t;
  if (t.count === 0) return ["The G-code has no extrusion moves."];
  lines.push(
    `${t.layers.length} layers, ${(bbox.maxZ).toFixed(2)} mm tall; footprint ${(bbox.maxX - bbox.minX).toFixed(1)} x ${(bbox.maxY - bbox.minY).toFixed(1)} mm at X ${bbox.minX.toFixed(0)}-${bbox.maxX.toFixed(0)}, Y ${bbox.minY.toFixed(0)}-${bbox.maxY.toFixed(0)}.`,
  );
  const first = t.layers[0];
  if (first) lines.push(`First layer ${first.height || first.z} mm.`);
  const total = t.pathLength.reduce((a, b) => a + b, 0);
  const shares = FEATURES.map((f, i) => ({ f, l: t.pathLength[i]! }))
    .filter((x) => x.l > 0)
    .sort((a, b) => b.l - a.l)
    .map((x) => `${x.f} ${((100 * x.l) / total).toFixed(0)}%`);
  lines.push(`Path by feature: ${shares.join(", ")}.`);
  const support = ["Support", "Support interface", "Support transition"].reduce(
    (a, f) => a + t.pathLength[FEATURES.indexOf(f as Feature)]!,
    0,
  );
  lines.push(
    support > 0 ? `Supports: yes (${(support / 1000).toFixed(1)} m of path).` : "Supports: none.",
  );
  const overhang = t.pathLength[FEATURES.indexOf("Overhang wall")]!;
  if (overhang > 0)
    lines.push(
      `Overhang walls: ${(overhang / 1000).toFixed(2)} m printed over air or steep slopes.`,
    );
  const bridge =
    t.pathLength[FEATURES.indexOf("Bridge")]! + t.pathLength[FEATURES.indexOf("Internal bridge")]!;
  if (bridge > 0) lines.push(`Bridges: ${(bridge / 1000).toFixed(2)} m.`);
  lines.push(`Seams: ${seamSummary(t)}.`);
  if (t.toolChanges) lines.push(`Filament changes: ${t.toolChanges}.`);
  lines.push(`${t.travelMoves} travel moves, ${t.retractions} retractions.`);
  return lines;
}
