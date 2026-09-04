#!/usr/bin/env python3
"""Sanity-check a flat graphic for screen-print friendliness.

Screen printing typically wants:
  - <= 6 distinct ink colors
  - No gradients (or pre-halftoned)
  - No strokes thinner than ~1.5pt at print size
  - Clean edges on transparent background

Outputs a short human report. Return code 0 = looks fine, 1 = warnings.

Usage:
  printability_check.py <in.png> [--max-colors 6] [--print-width-in 12]
"""
import argparse
import sys
from collections import Counter
from PIL import Image


def count_colors(img: Image.Image, k: int = 32) -> int:
    """Return an estimate of distinct dominant colors after quantization."""
    quant = img.convert("RGB").quantize(colors=k, method=Image.Quantize.FASTOCTREE)
    # Drop colors that occupy <0.5% of the image
    hist = Counter(quant.getdata())
    total = sum(hist.values())
    significant = [c for c, n in hist.items() if n / total > 0.005]
    return len(significant)


def detect_gradients(img: Image.Image) -> float:
    """Heuristic: ratio of medium-gradient pixels after downscale. 0 = flat, 1 = gradient-heavy."""
    small = img.convert("L").resize((200, 200), Image.BILINEAR)
    quant = small.quantize(colors=64).convert("L")
    px = quant.load()
    diffs = 0
    total = 0
    for y in range(0, 200, 2):
        for x in range(0, 199, 2):
            d = abs(px[x, y] - px[x + 1, y])
            if 4 <= d <= 24:  # smooth gradient band
                diffs += 1
            total += 1
    return diffs / total if total else 0.0


def check_thin_strokes(img: Image.Image, print_width_in: float) -> bool:
    """Warn if the image has features smaller than ~1.5pt at the given print width.
    1pt = 1/72in. Ink on screen print wants ~1.5pt minimum."""
    px_per_in = img.width / print_width_in
    min_feature_px = 1.5 * px_per_in / 72
    # If image is fewer than ~8 * min_feature_px wide, anything in it is too fine.
    return img.width < min_feature_px * 200


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("infile")
    ap.add_argument("--max-colors", type=int, default=6)
    ap.add_argument("--print-width-in", type=float, default=12.0)
    args = ap.parse_args()

    img = Image.open(args.infile)
    warnings = []

    colors = count_colors(img, k=32)
    if colors > args.max_colors:
        warnings.append(
            f"~{colors} distinct colors (screen print wants <= {args.max_colors}). "
            "Consider flattening to a limited palette."
        )

    gradients = detect_gradients(img)
    if gradients > 0.12:
        warnings.append(
            f"Gradient signal {gradients:.0%} — screen prints don't render gradients without halftone."
        )

    if img.mode != "RGBA":
        warnings.append("No alpha channel — printer usually wants the graphic on transparent background.")

    if check_thin_strokes(img, args.print_width_in):
        warnings.append(
            f"Resolution {img.width}x{img.height} may be too low for {args.print_width_in}in print. "
            "Re-render at >= 2400px wide."
        )

    print(f"Printability report for {args.infile}")
    print(f"  size: {img.width}x{img.height}  mode: {img.mode}")
    print(f"  dominant colors (quantized): ~{colors}")
    print(f"  gradient signal: {gradients:.0%}")
    if not warnings:
        print("OK — nothing obvious to flag.")
        return 0
    print()
    print("Warnings:")
    for w in warnings:
        print(f"  - {w}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
