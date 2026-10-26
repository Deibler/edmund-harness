import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { MeshoptSimplifier } from "meshoptimizer";

/**
 * Keeping print files to the detail a nozzle can print.
 *
 * A 0.4 mm nozzle draws nothing finer than about a tenth of a millimetre, but
 * a mesh from marching cubes or a fine CAD export carries millions of
 * triangles anyway. One axolotl model (2026-10-25) had 1.43 million: 120 MB of
 * model data inside a 22 MB print file. Bambu Connect's import of it failed
 * where a 12-triangle part went through in a second, though the disk was also
 * nearly full then, so size alone is not proven to be the cause. Every
 * model passes through slicing, so slicing simplifies anything over the
 * budget before Bambu Studio sees it, moving no surface more than
 * MAX_DEVIATION_MM, which is under half a layer and invisible in plastic.
 *
 * Painted models (per-triangle colors, as MakerWorld multi-color files often
 * are) are left alone: simplifying them would scramble the paint.
 */

export const MAX_TRIANGLES = 300_000;
export const MAX_DEVIATION_MM = 0.05;

export type Mesh = { positions: Float32Array; indices: Uint32Array };

/* ── counting ──────────────────────────────────────────────────────────── */

function zipList(path: string): string[] {
  const r = spawnSync("/usr/bin/unzip", ["-Z1", path], { encoding: "utf8", maxBuffer: 16 << 20 });
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

function zipText(path: string, entry: string): string {
  const r = spawnSync("/usr/bin/unzip", ["-p", path, entry], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  return r.status === 0 ? r.stdout : "";
}

const TRIANGLE = /<(?:\w+:)?triangle\s/g;

function countMatches(text: string, re: RegExp): number {
  let n = 0;
  re.lastIndex = 0;
  while (re.exec(text)) n++;
  return n;
}

/** Triangles in an STL, OBJ or 3MF file; null for STEP (the slicer meshes it) or a file it cannot read. */
export function countTriangles(path: string): number | null {
  const ext = extname(path).toLowerCase();
  if (ext === ".stl") {
    const buf = readFileSync(path);
    const binary = binaryStlCount(buf);
    if (binary !== null) return binary;
    return countMatches(buf.toString("latin1"), /facet\s+normal/g);
  }
  if (ext === ".obj") {
    let n = 0;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.startsWith("f ")) n += Math.max(0, line.trim().split(/\s+/).length - 3);
    }
    return n;
  }
  if (ext === ".3mf") {
    let n = 0;
    for (const entry of zipList(path)) {
      if (entry.endsWith(".model")) n += countMatches(zipText(path, entry), TRIANGLE);
    }
    return n;
  }
  return null;
}

/* ── reading and writing ───────────────────────────────────────────────── */

function binaryStlCount(buf: Buffer): number | null {
  if (buf.length < 84) return null;
  const n = buf.readUInt32LE(80);
  return buf.length === 84 + n * 50 ? n : null;
}

/** Shares identical corners between triangles; STL repeats every corner per triangle. */
function weld(corners: Float32Array): Mesh {
  const index = new Map<string, number>();
  const positions: number[] = [];
  const indices = new Uint32Array(corners.length / 3);
  for (let i = 0; i < indices.length; i++) {
    const x = corners[i * 3] as number;
    const y = corners[i * 3 + 1] as number;
    const z = corners[i * 3 + 2] as number;
    const key = `${x},${y},${z}`;
    let at = index.get(key);
    if (at === undefined) {
      at = positions.length / 3;
      index.set(key, at);
      positions.push(x, y, z);
    }
    indices[i] = at;
  }
  return { positions: new Float32Array(positions), indices };
}

export function readStl(buf: Buffer): Mesh {
  const n = binaryStlCount(buf);
  if (n !== null) {
    const corners = new Float32Array(n * 9);
    for (let t = 0; t < n; t++) {
      const at = 84 + t * 50 + 12;
      for (let k = 0; k < 9; k++) corners[t * 9 + k] = buf.readFloatLE(at + k * 4);
    }
    return weld(corners);
  }
  const values: number[] = [];
  for (const m of buf.toString("latin1").matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) {
    values.push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  return weld(new Float32Array(values));
}

export function writeStl(mesh: Mesh): Buffer {
  const n = mesh.indices.length / 3;
  const buf = Buffer.alloc(84 + n * 50);
  buf.write("edmund-harness simplified", 0, "latin1");
  buf.writeUInt32LE(n, 80);
  const p = mesh.positions;
  for (let t = 0; t < n; t++) {
    const at = 84 + t * 50;
    const [a, b, c] = [0, 1, 2].map((k) => (mesh.indices[t * 3 + k] as number) * 3);
    const v = (i: number, k: number) => p[(i as number) + k] as number;
    // Facet normal from the winding; slicers recompute it, but keep it right.
    const ux = v(b!, 0) - v(a!, 0);
    const uy = v(b!, 1) - v(a!, 1);
    const uz = v(b!, 2) - v(a!, 2);
    const wx = v(c!, 0) - v(a!, 0);
    const wy = v(c!, 1) - v(a!, 1);
    const wz = v(c!, 2) - v(a!, 2);
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    buf.writeFloatLE(nx, at);
    buf.writeFloatLE(ny, at + 4);
    buf.writeFloatLE(nz, at + 8);
    [a!, b!, c!].forEach((i, k) => {
      for (let d = 0; d < 3; d++) buf.writeFloatLE(v(i, d), at + 12 + k * 12 + d * 4);
    });
  }
  return buf;
}

/** An OBJ's geometry, or null when it carries materials or vertex colors that an STL would lose. */
export function readObj(text: string): Mesh | null {
  if (/^usemtl\s/m.test(text) || /^v\s+\S+\s+\S+\s+\S+\s+\S+/m.test(text)) return null;
  const positions: number[] = [];
  const indices: number[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === "v") positions.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    else if (parts[0] === "f") {
      const count = positions.length / 3;
      const ids = parts.slice(1).map((s) => {
        const i = Number.parseInt(s.split("/")[0] as string, 10);
        return i < 0 ? count + i : i - 1;
      });
      for (let k = 1; k + 1 < ids.length; k++) indices.push(ids[0]!, ids[k]!, ids[k + 1]!);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/* ── simplifying ───────────────────────────────────────────────────────── */

/** The mesh with only the corners its triangles use, renumbered. */
function compact(positions: Float32Array, indices: ArrayLike<number>): Mesh {
  const remap = new Int32Array(positions.length / 3).fill(-1);
  const kept: number[] = [];
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const old = indices[i] as number;
    if (remap[old] === -1) {
      remap[old] = kept.length / 3;
      kept.push(
        positions[old * 3] as number,
        positions[old * 3 + 1] as number,
        positions[old * 3 + 2] as number,
      );
    }
    out[i] = remap[old] as number;
  }
  return { positions: new Float32Array(kept), indices: out };
}

/** Meshes smaller than this are kept as they are. */
const MIN_TRIANGLES = 1000;

const triangleKey = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y).join(",");

/**
 * The mesh reduced by `share` (0.2 keeps a fifth of the triangles) where that
 * moves no surface more than MAX_DEVIATION_MM; it stops short rather than go
 * further. With `labels` (one per triangle, such as a paint color), every
 * corner of a labelled triangle is pinned: those triangles come through
 * untouched with their labels, so painted detail and its edges stay exactly
 * as they were and only the plain surface between is thinned. One pass over
 * the whole mesh keeps it closed; simplifying each color region on its own
 * opened 15,000 edges around the axolotl's small painted islands.
 */
export async function simplify(
  mesh: Mesh,
  share: number,
  labels?: string[],
): Promise<{ mesh: Mesh; labels: string[]; deviationMm: number }> {
  await MeshoptSimplifier.ready;
  const n = mesh.indices.length / 3;
  // One number per position. The axolotl had 6,226 corners repeated under a
  // second number; the simplifier treats those as seams and left 15,000 open
  // edges along them.
  const remap = MeshoptSimplifier.generatePositionRemap(mesh.positions, 3);
  const idx = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < idx.length; i++) idx[i] = remap[mesh.indices[i] as number] as number;
  let lock: Uint8Array | null = null;
  const painted = new Map<string, string>();
  if (labels?.some(Boolean)) {
    lock = new Uint8Array(mesh.positions.length / 3);
    for (let t = 0; t < n; t++) {
      const label = labels[t];
      if (!label) continue;
      const [a, b, c] = [idx[t * 3] as number, idx[t * 3 + 1] as number, idx[t * 3 + 2] as number];
      lock[a] = 1;
      lock[b] = 1;
      lock[c] = 1;
      painted.set(triangleKey(a, b, c), label);
    }
  }
  const [kept, error] = MeshoptSimplifier.simplifyWithAttributes(
    idx,
    mesh.positions,
    3,
    new Float32Array(0),
    0,
    [],
    lock,
    Math.max(3, Math.floor(n * share) * 3),
    MAX_DEVIATION_MM,
    ["ErrorAbsolute", "LockBorder"],
  );
  const outLabels: string[] = [];
  for (let i = 0; i < kept.length; i += 3) {
    outLabels.push(
      painted.get(triangleKey(kept[i] as number, kept[i + 1] as number, kept[i + 2] as number)) ??
        "",
    );
  }
  return { mesh: compact(mesh.positions, kept), labels: outLabels, deviationMm: error };
}

/* ── 3MF ───────────────────────────────────────────────────────────────── */

const num = (x: number) => String(Math.round(x * 1e5) / 1e5);

type MeshBlock = {
  start: number;
  end: number;
  mesh: Mesh;
  /** Per triangle: its paint_color, "" for none. */
  paint: string[];
  /** Triangle attributes other than corners and paint (color groups, properties): leave it alone. */
  other: boolean;
  triangles: number;
};

/** Every <mesh> in a 3MF model part, with where it sits in the text. */
export function meshBlocks(xml: string): MeshBlock[] {
  const blocks: MeshBlock[] = [];
  const open = /<((?:\w+:)?)mesh>/g;
  for (let m = open.exec(xml); m; m = open.exec(xml)) {
    const prefix = m[1] ?? "";
    const close = `</${prefix}mesh>`;
    const end = xml.indexOf(close, m.index);
    if (end < 0) break;
    const body = xml.slice(m.index, end);
    const positions: number[] = [];
    for (const v of body.matchAll(/<(?:\w+:)?vertex\s+([^>]*?)\/?>/g)) {
      const a = Object.fromEntries(
        [...(v[1] ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]),
      );
      positions.push(Number(a.x), Number(a.y), Number(a.z));
    }
    const indices: number[] = [];
    const paint: string[] = [];
    let other = false;
    for (const t of body.matchAll(/<(?:\w+:)?triangle\s+([^>]*?)\/?>/g)) {
      const a = Object.fromEntries(
        [...(t[1] ?? "").matchAll(/([\w:]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]),
      );
      if (Object.keys(a).some((k) => !["v1", "v2", "v3", "paint_color"].includes(k))) other = true;
      indices.push(Number(a.v1), Number(a.v2), Number(a.v3));
      paint.push(a.paint_color ?? "");
    }
    blocks.push({
      start: m.index,
      end: end + close.length,
      mesh: { positions: new Float32Array(positions), indices: new Uint32Array(indices) },
      paint,
      other,
      triangles: indices.length / 3,
    });
    open.lastIndex = end;
  }
  return blocks;
}

export function meshXml(mesh: Mesh, paint?: string[]): string {
  const out: string[] = ["<mesh>\n<vertices>\n"];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    out.push(`<vertex x="${num(p[i]!)}" y="${num(p[i + 1]!)}" z="${num(p[i + 2]!)}"/>\n`);
  }
  out.push("</vertices>\n<triangles>\n");
  const t = mesh.indices;
  for (let i = 0; i < t.length; i += 3) {
    const color = paint?.[i / 3];
    out.push(
      `<triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}"${color ? ` paint_color="${color}"` : ""}/>\n`,
    );
  }
  out.push("</triangles>\n</mesh>");
  return out.join("");
}

/* ── the step slicing takes ────────────────────────────────────────────── */

export type MeshReport = {
  /** Triangles in what was given, or null when unknown (STEP). */
  before: number | null;
  after: number | null;
  deviationMm: number;
  /** In plain words, for the slice result. */
  notes: string[];
};

/**
 * The model or parts to slice, simplified into `workDir` when they carry
 * more than MAX_TRIANGLES between them. What was given is never modified.
 */
export async function printableMeshes(
  input: { model?: string; parts?: Array<{ path: string; filament: number }> },
  workDir: string,
): Promise<{
  model?: string;
  parts?: Array<{ path: string; filament: number }>;
  report: MeshReport;
}> {
  const files = input.model ? [input.model] : (input.parts ?? []).map((p) => p.path);
  const counts = files.map((f) => countTriangles(f));
  const known = counts.filter((c): c is number => c !== null);
  const before = known.length === counts.length ? known.reduce((a, b) => a + b, 0) : null;
  const report: MeshReport = { before, after: before, deviationMm: 0, notes: [] };
  if (before === null || before <= MAX_TRIANGLES) return { ...input, report };

  const share = MAX_TRIANGLES / before;
  let after = 0;
  const untouched: string[] = [];
  const out = await Promise.all(
    files.map(async (file, i) => {
      const count = counts[i] as number;
      const ext = extname(file).toLowerCase();
      const dest = join(workDir, `simplified-${i}-${basename(file, ext)}`);
      if (ext === ".3mf") {
        const r = await simplify3mf(file, `${dest}.3mf`, share);
        after += r.after;
        if (r.untouched) untouched.push(basename(file));
        report.deviationMm = Math.max(report.deviationMm, r.deviationMm);
        return `${dest}.3mf`;
      }
      const mesh =
        ext === ".obj" ? readObj(readFileSync(file, "utf8")) : readStl(readFileSync(file));
      if (!mesh) {
        after += count;
        report.notes.push(`${basename(file)} has materials or colors, so it was not simplified.`);
        return file;
      }
      const s = await simplify(mesh, share);
      writeFileSync(`${dest}.stl`, writeStl(s.mesh));
      after += s.mesh.indices.length / 3;
      report.deviationMm = Math.max(report.deviationMm, s.deviationMm);
      return `${dest}.stl`;
    }),
  );
  report.after = after;
  report.notes.unshift(
    `The model had ${before.toLocaleString("en-US")} triangles, far more detail than a 0.4 mm nozzle prints; it was simplified to ${after.toLocaleString("en-US")} (no surface moved more than ${report.deviationMm.toFixed(3)} mm) so the print file stays small enough to send.`,
  );
  if (untouched.length) {
    report.notes.push(
      `Some objects in ${[...new Set(untouched)].join(", ")} carry per-triangle color groups or properties and were left as they were.`,
    );
  }
  if (input.model) return { model: out[0], report };
  return {
    parts: (input.parts ?? []).map((p, i) => ({ ...p, path: out[i] as string })),
    report,
  };
}

/**
 * A copy of a 3MF with each mesh simplified by `share`, paint kept region by
 * region; everything outside the meshes byte for byte.
 */
async function simplify3mf(
  src: string,
  dest: string,
  share: number,
): Promise<{ after: number; deviationMm: number; untouched: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "edmund-3mf-"));
  try {
    const x = spawnSync("/usr/bin/unzip", ["-q", "-o", src, "-d", dir], { encoding: "utf8" });
    if (x.status !== 0) throw new Error(`could not open ${basename(src)}: ${x.stderr}`);
    let after = 0;
    let deviationMm = 0;
    let untouched = false;
    const models = listFiles(dir).filter((f) => f.endsWith(".model"));
    for (const path of models) {
      const xml = readFileSync(path, "utf8");
      const blocks = meshBlocks(xml);
      if (!blocks.length) continue;
      let text = "";
      let at = 0;
      for (const b of blocks) {
        text += xml.slice(at, b.start);
        if (b.other || b.triangles < MIN_TRIANGLES) {
          if (b.other) untouched = true;
          text += xml.slice(b.start, b.end);
          after += b.triangles;
        } else {
          const s = await simplify(b.mesh, share, b.paint);
          text += meshXml(s.mesh, s.labels);
          after += s.mesh.indices.length / 3;
          deviationMm = Math.max(deviationMm, s.deviationMm);
        }
        at = b.end;
      }
      text += xml.slice(at);
      writeFileSync(path, text);
    }
    rmSync(dest, { force: true });
    const z = spawnSync("/usr/bin/zip", ["-q", "-X", "-r", dest, "."], {
      cwd: dir,
      encoding: "utf8",
    });
    if (z.status !== 0) throw new Error(`could not write ${basename(dest)}: ${z.stderr}`);
    return { after, deviationMm, untouched };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}
