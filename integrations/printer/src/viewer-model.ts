import { gzipSync } from "bun";
import { type Mesh, meshBlocks, simplify } from "./mesh.ts";
import { zipEntries, zipEntry } from "./threemf.ts";

/**
 * The print page's 3D view: the objects on the printed plate, placed where
 * they print and colored by filament, as one compact file the browser draws.
 *
 * Built from the sliced .3mf in its own process (scripts/viewer-model.ts):
 * parsing a model part of tens of megabytes would otherwise hold the daemon.
 */

export const VIEWER_MAX_TRIANGLES = 150_000;

export type ViewerInfo = {
  version: 1;
  bed: { w: number; d: number };
  /** Filament colors; a triangle's byte is its filament number, from 1. */
  colors: string[];
  vertices: number;
  triangles: number;
  /** Positions are quantized to 16 bits across this box, in plate millimetres. */
  min: [number, number, number];
  max: [number, number, number];
  /** The prime tower, when the plate has one: a footprint and a height. */
  tower: { x0: number; y0: number; x1: number; y1: number; h: number } | null;
};

/**
 * The filament a painted triangle mostly shows. Bambu and Prusa store a
 * triangle's painting as a subdivision tree, written as hex and read from the
 * last character back: two bits give how many sides were split (0 for a leaf),
 * and a leaf's upper bits give its state, with 3 meaning "read one more nibble
 * and add 3". State 0 is the part's own filament; state n is filament n.
 */
export function paintState(code: string): number {
  if (!code) return 0;
  let pos = code.length - 1;
  const next = () => (pos >= 0 ? Number.parseInt(code[pos--] ?? "0", 16) || 0 : 0);
  const weight = new Map<number, number>();
  const walk = (share: number, depth: number) => {
    const nibble = next();
    const splits = nibble & 3;
    if (splits && depth < 24) {
      const children = splits + 1;
      for (let i = 0; i < children; i++) walk(share / children, depth + 1);
      return;
    }
    const state = nibble >> 2 === 3 ? next() + 3 : nibble >> 2;
    weight.set(state, (weight.get(state) ?? 0) + share);
  };
  walk(1, 0);
  let best = 0;
  let bestShare = -1;
  for (const [state, share] of weight) {
    if (share > bestShare) [best, bestShare] = [state, share];
  }
  return best;
}

type Matrix = number[];
const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** A 3MF transform: twelve numbers, a 3x3 then the translation, applied to row vectors. */
export function parseTransform(text: string | undefined): Matrix {
  const m = (text ?? "").trim().split(/\s+/).map(Number);
  return m.length === 12 && m.every(Number.isFinite) ? m : IDENTITY;
}

function apply(m: Matrix, x: number, y: number, z: number): [number, number, number] {
  return [
    x * m[0]! + y * m[3]! + z * m[6]! + m[9]!,
    x * m[1]! + y * m[4]! + z * m[7]! + m[10]!,
    x * m[2]! + y * m[5]! + z * m[8]! + m[11]!,
  ];
}

const attrs = (s: string) =>
  Object.fromEntries([...s.matchAll(/([\w:]+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!]));

type Part = { mesh: Mesh; paint: string[]; transform: Matrix; filament: number };

/** The parts of every object on `plate`, each with its transform into the plate's space. */
function plateParts(path: string, plate: number): Part[] {
  const text = (name: string) => zipEntry(path, name)?.toString("utf8") ?? "";
  const settings = text("Metadata/model_settings.config");

  // Which objects (and how many instances of each) sit on this plate.
  const onPlate = new Map<string, Set<number>>();
  // A project without plates (not from Bambu Studio) prints everything.
  const hasPlates = /<plate>/.test(settings);
  for (const p of settings.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const id = p[1]!.match(/key="plater_id" value="(\d+)"/)?.[1];
    if (Number(id) !== plate) continue;
    for (const inst of p[1]!.matchAll(/<model_instance>([\s\S]*?)<\/model_instance>/g)) {
      const obj = inst[1]!.match(/key="object_id" value="(\d+)"/)?.[1];
      const n = Number(inst[1]!.match(/key="instance_id" value="(\d+)"/)?.[1] ?? 0);
      if (obj) onPlate.set(obj, (onPlate.get(obj) ?? new Set()).add(n));
    }
  }
  // Each object's filament, and each part's where it has its own.
  const objectFilament = new Map<string, number>();
  const partFilament = new Map<string, number>();
  for (const o of settings.matchAll(/<object id="(\d+)">([\s\S]*?)<\/object>/g)) {
    const own = o[2]!.replace(/<part[\s\S]*?<\/part>/g, "");
    objectFilament.set(o[1]!, Number(own.match(/key="extruder" value="(\d+)"/)?.[1] ?? 1));
    for (const part of o[2]!.matchAll(/<part id="(\d+)"[^>]*>([\s\S]*?)<\/part>/g)) {
      const f = part[2]!.match(/key="extruder" value="(\d+)"/)?.[1];
      if (f) partFilament.set(`${o[1]}/${part[1]}`, Number(f));
    }
  }

  const main = text("3D/3dmodel.model");
  const files = new Map<string, Map<string, { mesh: Mesh; paint: string[] }>>();
  const meshesIn = (name: string) => {
    let found = files.get(name);
    if (found) return found;
    found = new Map();
    const xml = name === "3D/3dmodel.model" ? main : text(name);
    for (const o of xml.matchAll(/<object\s+([^>]*)>([\s\S]*?)<\/object>/g)) {
      const block = meshBlocks(o[2]!)[0];
      if (block) found.set(attrs(o[1]!).id ?? "", { mesh: block.mesh, paint: block.paint });
    }
    files.set(name, found);
    return found;
  };

  const objects = new Map<string, string>();
  for (const o of main.matchAll(/<object\s+([^>]*)>([\s\S]*?)<\/object>/g)) {
    objects.set(attrs(o[1]!).id ?? "", o[2]!);
  }
  const parts: Part[] = [];
  const seen = new Map<string, number>();
  for (const item of main.matchAll(/<item\s+([^>]*?)\/?>/g)) {
    const a = attrs(item[1]!);
    const id = a.objectid ?? "";
    const instance = seen.get(id) ?? 0;
    seen.set(id, instance + 1);
    if (a.printable === "0") continue;
    if (hasPlates && !onPlate.get(id)?.has(instance)) continue;
    const placed = parseTransform(a.transform);
    const body = objects.get(id) ?? "";
    const filament = objectFilament.get(id) ?? 1;
    const components = [...body.matchAll(/<component\s+([^>]*?)\/?>/g)].map((c) => attrs(c[1]!));
    if (components.length === 0) {
      const own = meshesIn("3D/3dmodel.model").get(id);
      if (own) parts.push({ ...own, transform: placed, filament });
      continue;
    }
    for (const c of components) {
      const file = (c["p:path"] ?? "/3D/3dmodel.model").replace(/^\//, "");
      const part = meshesIn(file).get(c.objectid ?? "");
      if (!part) continue;
      const local = parseTransform(c.transform);
      // The part's own transform, then the object's placement.
      const both: Matrix = [
        ...[0, 1, 2].flatMap((r) =>
          [0, 1, 2].map(
            (col) =>
              local[r * 3]! * placed[col]! +
              local[r * 3 + 1]! * placed[3 + col]! +
              local[r * 3 + 2]! * placed[6 + col]!,
          ),
        ),
        ...apply(placed, local[9]!, local[10]!, local[11]!),
      ];
      parts.push({
        ...part,
        transform: both,
        filament: partFilament.get(`${id}/${c.objectid}`) ?? filament,
      });
    }
  }
  return parts;
}

export async function buildViewerModel(
  path: string,
  plate: number,
): Promise<{ info: ViewerInfo; bin: Uint8Array }> {
  if (!zipEntries(path).includes("3D/3dmodel.model")) throw new Error("no model in this file");
  const parts = plateParts(path, plate);
  if (parts.length === 0) throw new Error(`nothing on plate ${plate}`);

  const settings = JSON.parse(
    zipEntry(path, "Metadata/project_settings.config")?.toString() || "{}",
  );
  const colors: string[] = (settings.filament_colour ?? []).map((c: string) => c.slice(0, 7));
  const area: string[] = settings.printable_area ?? [];
  const corners = area.map((p) => p.split("x").map(Number));
  const bed = {
    w: Math.max(...corners.map((c) => c[0] ?? 0), 0) || 256,
    d: Math.max(...corners.map((c) => c[1] ?? 0), 0) || 256,
  };

  const total = parts.reduce((n, p) => n + p.mesh.indices.length / 3, 0);
  const share = total > VIEWER_MAX_TRIANGLES ? VIEWER_MAX_TRIANGLES / total : 1;
  const positions: number[] = [];
  const indices: number[] = [];
  const filaments: number[] = [];
  for (const part of parts) {
    let mesh = part.mesh;
    let state = part.paint.map(paintState);
    if (share < 1) {
      // Painted islands are pinned by their labels and keep their edges; the
      // plain surface between is what thins.
      const labels = state.map((s) => (s && s !== part.filament ? String(s) : ""));
      const small = await simplify(mesh, share, labels);
      mesh = small.mesh;
      state = small.labels.map((l) => (l ? Number(l) : 0));
    }
    const base = positions.length / 3;
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3)
      positions.push(...apply(part.transform, p[i]!, p[i + 1]!, p[i + 2]!));
    for (const i of mesh.indices) indices.push(base + i);
    for (const s of state) filaments.push(s || part.filament);
  }

  // Into the plate's own coordinates. On the first plate the project's
  // placement already is the plate's; on any other it carries that plate's
  // offset in the grid of plates. The slicer's footprint for the plate tells
  // which, but only to within a few millimetres: it left 3.6 mm of the
  // axolotl's tail out (2026-10-25). So it only decides whole-plate moves.
  const min: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const max: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, positions[i + k]!);
      max[k] = Math.max(max[k]!, positions[i + k]!);
    }
  }
  const plateJson = JSON.parse(zipEntry(path, `Metadata/plate_${plate}.json`)?.toString() || "{}");
  const boxes: Array<{ bbox: number[]; name: string }> = plateJson.bbox_objects ?? [];
  const models = boxes.filter((b) => b.name !== "wipe_tower" && b.bbox?.length === 4);
  const shift = (sliced: number, ours: number) =>
    Math.abs(sliced - ours) < 20 ? 0 : sliced - ours;
  let dx = 0;
  let dy = 0;
  if (models.length) {
    const cx =
      (Math.min(...models.map((b) => b.bbox[0]!)) + Math.max(...models.map((b) => b.bbox[2]!))) / 2;
    const cy =
      (Math.min(...models.map((b) => b.bbox[1]!)) + Math.max(...models.map((b) => b.bbox[3]!))) / 2;
    dx = shift(cx, (min[0]! + max[0]!) / 2);
    dy = shift(cy, (min[1]! + max[1]!) / 2);
  } else if (min[0]! < 0 || min[0]! > bed.w || min[1]! < 0 || min[1]! > bed.d) {
    const stride = { x: bed.w * 1.2, y: bed.d * 1.2 };
    dx = -Math.floor(min[0]! / stride.x) * stride.x;
    dy = -Math.floor(min[1]! / stride.y) * stride.y;
  }
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = positions[i]! + dx;
    positions[i + 1] = positions[i + 1]! + dy;
  }
  min[0] = min[0]! + dx;
  max[0] = max[0]! + dx;
  min[1] = min[1]! + dy;
  max[1] = max[1]! + dy;
  min[2] = Math.max(0, min[2]!);

  const towerBox = boxes.find((b) => b.name === "wipe_tower" && b.bbox?.length === 4)?.bbox;
  const tower = towerBox
    ? { x0: towerBox[0]!, y0: towerBox[1]!, x1: towerBox[2]!, y1: towerBox[3]!, h: max[2]! }
    : null;

  const vertexCount = positions.length / 3;
  const triCount = indices.length / 3;
  const span = [0, 1, 2].map((k) => Math.max(1e-6, max[k]! - min[k]!));
  const q = new Uint16Array(positions.length);
  for (let i = 0; i < positions.length; i++) {
    const k = i % 3;
    q[i] = Math.round(((positions[i]! - min[k]!) / span[k]!) * 65535);
  }
  const padded = (q.byteLength + 3) & ~3;
  const raw = new Uint8Array(padded + triCount * 12 + triCount);
  raw.set(new Uint8Array(q.buffer), 0);
  raw.set(new Uint8Array(new Uint32Array(indices).buffer), padded);
  raw.set(Uint8Array.from(filaments), padded + triCount * 12);
  return {
    info: { version: 1, bed, colors, vertices: vertexCount, triangles: triCount, min, max, tower },
    bin: gzipSync(raw),
  };
}
