import { deflateSync } from "node:zlib";

/**
 * A small software renderer: an RGB canvas with a depth buffer, thick lines,
 * dots, and a PNG encoder. The slicer's own renderer needs OpenGL and hangs
 * while the Mac's screen is locked; this one draws toolpath previews anywhere.
 */

export type RGB = [number, number, number];

export class Canvas {
  readonly rgb: Uint8Array;
  readonly depth: Float32Array;

  constructor(
    readonly width: number,
    readonly height: number,
    background: RGB,
  ) {
    this.rgb = new Uint8Array(width * height * 3);
    this.depth = new Float32Array(width * height).fill(Number.NEGATIVE_INFINITY);
    for (let i = 0; i < width * height; i++) {
      this.rgb[i * 3] = background[0];
      this.rgb[i * 3 + 1] = background[1];
      this.rgb[i * 3 + 2] = background[2];
    }
  }

  /** Plot one pixel if it is nearer than what is there (larger depth = nearer). */
  plot(x: number, y: number, d: number, c: RGB, force = false): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = y * this.width + x;
    if (!force && d < this.depth[i]!) return;
    this.depth[i] = d;
    this.rgb[i * 3] = c[0];
    this.rgb[i * 3 + 1] = c[1];
    this.rgb[i * 3 + 2] = c[2];
  }

  /** A line of `w` pixels' width with depth interpolated along it. */
  line(
    x0: number,
    y0: number,
    d0: number,
    x1: number,
    y1: number,
    d1: number,
    c: RGB,
    w = 1,
    force = false,
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
    const r = Math.max(0, Math.floor((w - 1) / 2));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const px = Math.round(x0 + dx * t);
      const py = Math.round(y0 + dy * t);
      const pd = d0 + (d1 - d0) * t;
      if (r === 0) this.plot(px, py, pd, c, force);
      else
        for (let oy = -r; oy <= r; oy++)
          for (let ox = -r; ox <= r; ox++) this.plot(px + ox, py + oy, pd, c, force);
    }
  }

  /** A filled disc drawn over everything, for markers like seams. */
  dot(x: number, y: number, radius: number, c: RGB): void {
    const r2 = radius * radius;
    for (let oy = -radius; oy <= radius; oy++) {
      for (let ox = -radius; ox <= radius; ox++) {
        if (ox * ox + oy * oy <= r2)
          this.plot(Math.round(x + ox), Math.round(y + oy), Number.POSITIVE_INFINITY, c, true);
      }
    }
  }

  png(): Buffer {
    return encodePng(this.width, this.height, this.rgb);
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** 8-bit RGB PNG, filter 0 on every row. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(
      raw,
      y * (width * 3 + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

export function hexRgb(hex: string): RGB {
  const h = hex.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}/.test(h)) return [200, 200, 200];
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

export function shade(c: RGB, k: number): RGB {
  return [
    Math.min(255, Math.round(c[0] * k)),
    Math.min(255, Math.round(c[1] * k)),
    Math.min(255, Math.round(c[2] * k)),
  ];
}
