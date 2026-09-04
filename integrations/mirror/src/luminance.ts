import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

/**
 * How bright an image will be on the glass, decided before it gets there.
 *
 * `image_card.treatment` chooses between two filters that differ by nearly
 * three stops, and getting it wrong on a dark mirror means a lit rectangle in
 * a bedroom. Until now it was DECLARED — the radar cron says "chart", the
 * attachment path guesses "photo" — and a declaration is a thing that can be
 * forgotten, by a model or by whoever writes the next cron.
 *
 * This measures it instead. `sips` resamples the image down to a small grid,
 * which is an area average by definition, and that grid is decoded here.
 *
 * Deliberately NOT done in the browser. Reading pixels back from a canvas
 * needs the asset to be CORS-readable, which means opening an
 * Access-Control-Allow-Origin on the asset route and revisiting its CSP — a
 * security change to earn a filter choice. This path already has the bytes.
 *
 * macOS-only, and that is fine: it runs in the daemon, which only runs here.
 * Everything returns null on any failure, and null means "no opinion" — the
 * caller keeps whatever it would have chosen anyway.
 */

/**
 * What separates paper from a photograph, and why it is not the average.
 *
 * The obvious test — mean luminance — does not work. A correctly exposed
 * photograph sits around 18% reflectance, which is about 118 in sRGB, and a
 * bright one goes higher; any threshold low enough to catch a pale map also
 * catches a snapshot taken outdoors. The averages overlap.
 *
 * What does not overlap is the AREA of near-white. A map, a chart, a
 * screenshot or a scan is mostly blank page: half the frame or more is within
 * a few percent of white. A photograph clips to white only in small
 * highlights, because a scene lit that flatly is a scene with nothing in it.
 *
 * So: sample a grid, count how much of it is paper-white, and decide on that.
 * The mean is kept only as a second signal for the extreme case — a frame so
 * bright that its whites have blown past the sample grid's ability to resolve
 * them as separate regions.
 */
const WHITE_SAMPLE = 210;
const PAPER_FRACTION = 0.3;
const PAPER_MEAN = 200;
/** 8x8 is 64 samples: enough for a stable fraction, small enough that the PNG
 *  is a few hundred bytes and decodes without a real image library. */
const GRID = 8;

export type ImageTreatment = "photo" | "chart";

export type LuminanceProfile = {
  /** Mean luminance across the sample grid, 0-255. */
  mean: number;
  /** Share of the grid within a few percent of white, 0-1. */
  white: number;
};

/** Sample an image down to a grid and describe how bright it is. */
export function luminanceProfile(filePath: string): LuminanceProfile | null {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "mirror-luma-"));
    const sample = join(dir, "sample.png");
    // sips does the area averaging, which saves decoding a full JPEG here.
    // Aspect is deliberately not preserved: this is a sample grid, not a
    // thumbnail, and a square one keeps the fraction comparable across shapes.
    // `-s format png` is not optional. Without it sips keeps the SOURCE
    // format and merely honours the .png filename, so every JPEG came back as
    // a JPEG called sample.png — which the decoder below correctly refused,
    // making every photograph "unmeasurable" and every measurement a no-op.
    execFileSync(
      "sips",
      [
        "-s",
        "format",
        "png",
        "--resampleHeightWidth",
        String(GRID),
        String(GRID),
        "--out",
        sample,
        filePath,
      ],
      { stdio: "ignore", timeout: 10_000 },
    );
    const pixels = decodeSmallPng(readFileSync(sample));
    if (!pixels || pixels.length === 0) return null;
    let total = 0;
    let white = 0;
    for (const luma of pixels) {
      total += luma;
      if (luma >= WHITE_SAMPLE) white += 1;
    }
    return { mean: total / pixels.length, white: white / pixels.length };
  } catch {
    return null;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Pick a treatment by measurement, or null when it cannot be measured.
 *
 * Null rather than a default on purpose: "I could not tell" and "I decided it
 * is a photo" are different claims, and a caller that has its own reason to
 * believe one or the other should not have that overwritten by a guess
 * wearing the same type.
 */
export function measuredTreatment(filePath: string): ImageTreatment | null {
  const profile = luminanceProfile(filePath);
  if (profile === null) return null;
  return profile.white >= PAPER_FRACTION || profile.mean >= PAPER_MEAN ? "chart" : "photo";
}

/**
 * Decode a small PNG to a list of per-pixel luminances.
 *
 * A real image library would be overkill for a 64-pixel sample and a
 * dependency for a filter choice, but PNG filtering does have to be undone —
 * at 1x1 every filter collapses to "no change" because there are no
 * neighbours, and that is emphatically not true at 8x8. The five filter types
 * are from the spec and there is nothing clever here; getting one wrong shows
 * up immediately as a measurement that disagrees with the eye.
 */
function decodeSmallPng(bytes: Buffer): number[] | null {
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 8;
  let colorType: number | null = null;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IHDR") {
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      depth = bytes[offset + 16] ?? 8;
      colorType = bytes[offset + 17] ?? null;
      interlace = bytes[offset + 20] ?? 0;
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const channels =
    colorType === 0 ? 1 : colorType === 4 ? 2 : colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  // Refuse anything this decoder cannot read EXACTLY. A palette image, 16-bit
  // samples or an interlaced layout would each be misread as something
  // plausible, and a plausible wrong answer here is a lit rectangle in a dark
  // room. Returning null just means the caller keeps its own opinion.
  if (!channels || depth !== 8 || interlace !== 0 || !width || !height || !idat.length) {
    return null;
  }

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;

  const out: number[] = [];
  const line = Buffer.alloc(stride);
  const prior = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start] ?? 0;
    raw.copy(line, 0, start + 1, start + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (line[x - channels] ?? 0) : 0; // left
      const b = prior[x] ?? 0; // up
      const c = x >= channels ? (prior[x - channels] ?? 0) : 0; // up-left
      const v = line[x] ?? 0;
      line[x] =
        filter === 1
          ? (v + a) & 0xff
          : filter === 2
            ? (v + b) & 0xff
            : filter === 3
              ? (v + ((a + b) >> 1)) & 0xff
              : filter === 4
                ? (v + paeth(a, b, c)) & 0xff
                : v;
    }
    for (let x = 0; x + channels <= stride; x += channels) {
      const [r, g, bl] =
        channels <= 2
          ? [line[x] ?? 0, line[x] ?? 0, line[x] ?? 0]
          : [line[x] ?? 0, line[x + 1] ?? 0, line[x + 2] ?? 0];
      out.push(0.2126 * r + 0.7152 * g + 0.0722 * bl);
    }
    line.copy(prior);
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
