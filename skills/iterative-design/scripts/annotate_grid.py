#!/usr/bin/env python3
"""Overlay a labeled grid on an image so the user can point at a cell.

Use when a tweak is genuinely hard to describe — instead of a 5-round
guess loop, send the annotated image back and ask "which cell feels off?"

Usage:
  annotate_grid.py <in> <out> [--cols N] [--rows N] [--color HEX]
"""
import argparse
import sys
from PIL import Image, ImageDraw, ImageFont


def pick_font(size: int):
    for path in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("infile")
    ap.add_argument("outfile")
    ap.add_argument("--cols", type=int, default=4)
    ap.add_argument("--rows", type=int, default=4)
    ap.add_argument("--color", default="#FF2D55")
    ap.add_argument("--opacity", type=int, default=180, help="0-255")
    args = ap.parse_args()

    img = Image.open(args.infile).convert("RGBA")
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    w, h = img.size
    col_w = w / args.cols
    row_h = h / args.rows

    color = args.color
    alpha = max(0, min(255, args.opacity))
    # Parse hex -> rgba
    hex_ = color.lstrip("#")
    r, g, b = int(hex_[0:2], 16), int(hex_[2:4], 16), int(hex_[4:6], 16)
    line = (r, g, b, alpha)
    fill = (r, g, b, min(alpha, 220))

    line_px = max(2, w // 600)
    for c in range(1, args.cols):
        x = int(c * col_w)
        draw.line([(x, 0), (x, h)], fill=line, width=line_px)
    for r_ in range(1, args.rows):
        y = int(r_ * row_h)
        draw.line([(0, y), (w, y)], fill=line, width=line_px)

    # Cell labels (A1, A2, ...). Rows = letters, cols = numbers.
    font_size = max(24, int(min(col_w, row_h) * 0.18))
    font = pick_font(font_size)
    pad = max(6, font_size // 3)
    for ri in range(args.rows):
        for ci in range(args.cols):
            label = f"{chr(ord('A') + ri)}{ci + 1}"
            x0 = int(ci * col_w) + pad
            y0 = int(ri * row_h) + pad
            bbox = draw.textbbox((x0, y0), label, font=font)
            # Pill background for legibility
            bx0, by0, bx1, by1 = bbox
            draw.rounded_rectangle(
                (bx0 - pad // 2, by0 - pad // 4, bx1 + pad // 2, by1 + pad // 4),
                radius=pad,
                fill=fill,
            )
            draw.text((x0, y0), label, fill=(255, 255, 255, 255), font=font)

    out = Image.alpha_composite(img, overlay).convert("RGB")
    out.save(args.outfile, quality=92)
    print(args.outfile)
    return 0


if __name__ == "__main__":
    sys.exit(main())
