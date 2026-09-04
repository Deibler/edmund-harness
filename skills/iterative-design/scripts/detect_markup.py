#!/usr/bin/env python3
"""Detect user-drawn markup (red circles, arrows, scribbles) on an image.

When the user sends back a marked-up version of the previous round,
run this to locate where they drew. Output is a short human-readable
region report plus an optional mask PNG isolating the drawn pixels.

Technique: filter for saturated red/magenta/yellow that was unlikely to
exist in the original design. Cluster surviving pixels into bounding
boxes by row/column occupancy.

Usage:
  detect_markup.py <in.jpg> [--mask out_mask.png] [--hue red|yellow|any]
"""
import argparse
import sys
from PIL import Image


def hue_filter(r: int, g: int, b: int, hue: str) -> bool:
    # Saturated, mid-to-bright, and clearly of the target hue.
    mx = max(r, g, b)
    mn = min(r, g, b)
    sat = (mx - mn) / (mx + 1)
    if sat < 0.35 or mx < 100:
        return False
    if hue == "red":
        return r > 140 and r > g * 1.4 and r > b * 1.4
    if hue == "yellow":
        return r > 160 and g > 140 and b < min(r, g) * 0.6
    if hue == "magenta":
        return r > 140 and b > 140 and g < min(r, b) * 0.7
    # any: strongly-saturated non-greyscale
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("infile")
    ap.add_argument("--mask", default="")
    ap.add_argument("--hue", default="red", choices=["red", "yellow", "magenta", "any"])
    args = ap.parse_args()

    img = Image.open(args.infile).convert("RGB")
    w, h = img.size
    px = img.load()

    row_counts = [0] * h
    col_counts = [0] * w
    hits = []
    if args.mask:
        mask = Image.new("L", (w, h), 0)
        mpx = mask.load()
    for y in range(0, h, 2):  # stride 2 for speed
        for x in range(0, w, 2):
            r, g, b = px[x, y]
            if hue_filter(r, g, b, args.hue):
                row_counts[y] += 1
                col_counts[x] += 1
                hits.append((x, y))
                if args.mask:
                    mpx[x, y] = 255

    total = len(hits)
    if total < 50:
        print(f"No significant {args.hue} markup detected (only {total} hit pixels).")
        return 0

    # Bounding box of markup cloud
    xs = [h_[0] for h_ in hits]
    ys = [h_[1] for h_ in hits]
    bx0, bx1 = min(xs), max(xs)
    by0, by1 = min(ys), max(ys)

    # Describe in thirds (left/center/right, top/middle/bottom)
    cx = (bx0 + bx1) / 2 / w
    cy = (by0 + by1) / 2 / h
    h_band = "left" if cx < 0.33 else "center" if cx < 0.67 else "right"
    v_band = "top" if cy < 0.33 else "middle" if cy < 0.67 else "bottom"

    print(f"Markup detected ({args.hue}): {total} pixels.")
    print(f"  bounding box: ({bx0},{by0}) -> ({bx1},{by1})")
    print(f"  roughly: {v_band}-{h_band} of the image")
    print(f"  image size: {w}x{h}")

    if args.mask:
        mask.save(args.mask)
        print(f"  mask saved: {args.mask}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
