/**
 * Colour comparison for filament. A design asks for "#FF0000" and the AMS
 * holds Bambu Red (#C12E1F); whether that is the same colour is a perceptual
 * question, so distances are CIEDE2000 in Lab, not RGB.
 */

export type Lab = { L: number; a: number; b: number };

export function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}/.test(h)) return null;
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

export function hexToLab(hex: string): Lab | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const lin = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const X = (lin[0] * 0.4124 + lin[1] * 0.3576 + lin[2] * 0.1805) / 0.95047;
  const Y = lin[0] * 0.2126 + lin[1] * 0.7152 + lin[2] * 0.0722;
  const Z = (lin[0] * 0.0193 + lin[1] * 0.1192 + lin[2] * 0.9505) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t) / 116 + 16 / 116);
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** CIEDE2000 colour difference. Under ~2 is invisible, under ~10 reads as the same colour. */
export function deltaE2000(x: Lab, y: Lab): number {
  const C1 = Math.hypot(x.a, x.b);
  const C2 = Math.hypot(y.a, y.b);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1 = (1 + G) * x.a;
  const a2 = (1 + G) * y.a;
  const C1p = Math.hypot(a1, x.b);
  const C2p = Math.hypot(a2, y.b);
  const h1 = C1p === 0 ? 0 : (deg(Math.atan2(x.b, a1)) + 360) % 360;
  const h2 = C2p === 0 ? 0 : (deg(Math.atan2(y.b, a2)) + 360) % 360;
  const dL = y.L - x.L;
  const dC = C2p - C1p;
  let dh = 0;
  if (C1p * C2p !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dh / 2));
  const Lm = (x.L + y.L) / 2;
  const Cmp = (C1p + C2p) / 2;
  let hm = h1 + h2;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1 - h2) > 180) hm = h1 + h2 < 360 ? hm + 360 : hm - 360;
    hm /= 2;
  }
  const T =
    1 -
    0.17 * Math.cos(rad(hm - 30)) +
    0.24 * Math.cos(rad(2 * hm)) +
    0.32 * Math.cos(rad(3 * hm + 6)) -
    0.2 * Math.cos(rad(4 * hm - 63));
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const Sc = 1 + 0.045 * Cmp;
  const Sh = 1 + 0.015 * Cmp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

export function colorDistance(hexA: string, hexB: string): number {
  const a = hexToLab(hexA);
  const b = hexToLab(hexB);
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return deltaE2000(a, b);
}

/** Within this, a loaded spool is the colour the design asked for. */
export const SAME_COLOR = 12;

/** Plain color names, for asks like "swap slot 3 to red". */
const NAMED: Array<[string, string]> = [
  ["white", "#FFFFFF"],
  ["ivory", "#F2EBD9"],
  ["beige", "#D7C4A3"],
  ["light gray", "#C8C8C8"],
  ["silver", "#A6A9AA"],
  ["gray", "#8A8D8F"],
  ["dark gray", "#4B4B4D"],
  ["black", "#161616"],
  ["red", "#C12E1F"],
  ["maroon", "#7A1F2B"],
  ["pink", "#F4A0B9"],
  ["magenta", "#D02F8A"],
  ["orange", "#FF6A13"],
  ["peach", "#F7B48A"],
  ["brown", "#7D5A3C"],
  ["tan", "#C49A6C"],
  ["gold", "#C9A227"],
  ["yellow", "#F4D80F"],
  ["lime", "#A6D64B"],
  ["green", "#00AE42"],
  ["dark green", "#1E5631"],
  ["mint", "#9BE3C5"],
  ["teal", "#008C8C"],
  ["cyan", "#14C8E6"],
  ["light blue", "#8EC9E9"],
  ["blue", "#0A5AD3"],
  ["navy", "#1B2A55"],
  ["purple", "#6A3FA0"],
  ["lavender", "#B9A3E3"],
];

export function colorName(hex: string): string {
  const lab = hexToLab(hex);
  if (!lab) return "unknown color";
  let best = NAMED[0]![0];
  let bestD = Number.POSITIVE_INFINITY;
  for (const [name, h] of NAMED) {
    const d = deltaE2000(lab, hexToLab(h)!);
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}
