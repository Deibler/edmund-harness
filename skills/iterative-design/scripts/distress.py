#!/usr/bin/env python3
"""Apply a distressed / vintage texture to a flat graphic.

Designed for the vintage collegiate / surf-shop look Casey prefers on
OCMD tees. Works on graphics with transparency (PNG) and on flat
graphics over solid backgrounds.

Technique: high-frequency noise masked onto the alpha channel +
light posterize. Subtle by default — pixel ink gets eaten, shapes stay.

Usage:
  distress.py <in.png> <out.png> [--intensity 0.35] [--scale 1.0] [--seed N]
"""
import argparse
import sys
import random
from PIL import Image, ImageFilter, ImageDraw


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("infile")
    ap.add_argument("outfile")
    ap.add_argument("--intensity", type=float, default=0.35, help="0 (none) – 1 (destroyed)")
    ap.add_argument("--scale", type=float, default=1.0, help="grain scale multiplier")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    img = Image.open(args.infile).convert("RGBA")
    w, h = img.size
    intensity = max(0.0, min(1.0, args.intensity))

    # Build a grain mask at a reduced resolution, then upscale for organic edges.
    grain_w = max(64, int(w * 0.25 * args.scale))
    grain_h = max(64, int(h * 0.25 * args.scale))
    grain = Image.new("L", (grain_w, grain_h), 255)
    gd = ImageDraw.Draw(grain)
    holes = int(grain_w * grain_h * 0.02 * (0.3 + intensity))
    for _ in range(holes):
        x = random.randint(0, grain_w - 1)
        y = random.randint(0, grain_h - 1)
        r = random.randint(1, 3)
        gd.ellipse((x - r, y - r, x + r, y + r), fill=random.randint(0, 120))
    # Streaks — long thin erosions give the screen-print wear look
    streaks = int(30 * (0.3 + intensity))
    for _ in range(streaks):
        x0 = random.randint(0, grain_w)
        y0 = random.randint(0, grain_h)
        x1 = x0 + random.randint(-grain_w // 4, grain_w // 4)
        y1 = y0 + random.randint(-grain_h // 10, grain_h // 10)
        gd.line((x0, y0, x1, y1), fill=random.randint(40, 180), width=1)

    grain = grain.filter(ImageFilter.GaussianBlur(radius=0.8))
    grain = grain.resize((w, h), Image.BILINEAR)

    # Blend grain into alpha: multiply existing alpha by (grain mapped to [1 - intensity, 1]).
    r, g, b, a = img.split()
    a_px = a.load()
    grain_px = grain.load()
    lo = 1.0 - intensity
    for yy in range(h):
        for xx in range(w):
            if a_px[xx, yy] == 0:
                continue
            gv = grain_px[xx, yy] / 255.0
            factor = lo + (1.0 - lo) * gv
            a_px[xx, yy] = int(a_px[xx, yy] * factor)

    out = Image.merge("RGBA", (r, g, b, a))

    # Light posterize to pull colors toward screen-print flatness.
    if intensity > 0.15:
        rgb = Image.merge("RGB", (r, g, b))
        levels = 8 if intensity < 0.5 else 6
        step = 256 // levels
        lut = [min(255, (v // step) * step + step // 2) for v in range(256)]
        rgb = rgb.point(lut * 3)
        rr, gg, bb = rgb.split()
        out = Image.merge("RGBA", (rr, gg, bb, a))

    out.save(args.outfile)
    print(args.outfile)
    return 0


if __name__ == "__main__":
    sys.exit(main())
