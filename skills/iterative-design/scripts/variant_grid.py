#!/usr/bin/env python3
"""Compose N candidate images into one labeled grid so the user can pick.

When you have three plausible interpretations of a fuzzy tweak, send
them all at once. One round beats three.

Usage:
  variant_grid.py <out.png> <in1> <in2> [in3 ...] [--labels "Left,Middle,Right"]
                   [--cols N] [--caption "Round 3 — which one?"]
"""
import argparse
import sys
from PIL import Image, ImageDraw, ImageFont


def pick_font(size: int):
    for path in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("outfile")
    ap.add_argument("infiles", nargs="+")
    ap.add_argument("--labels", default="")
    ap.add_argument("--cols", type=int, default=0, help="0 = auto")
    ap.add_argument("--caption", default="")
    ap.add_argument("--bg", default="#FFFFFF")
    args = ap.parse_args()

    images = [Image.open(p).convert("RGB") for p in args.infiles]
    n = len(images)
    cols = args.cols or (n if n <= 3 else 2)
    rows = (n + cols - 1) // cols

    # Normalize cell size to tallest-at-fixed-width
    cell_w = 1200
    resized = []
    for im in images:
        scale = cell_w / im.width
        resized.append(im.resize((cell_w, int(im.height * scale)), Image.LANCZOS))
    cell_h = max(im.height for im in resized)

    gutter = 24
    pad = 36
    cap_h = 80 if args.caption else 0
    label_h = 64
    W = cols * cell_w + (cols + 1) * gutter + 2 * pad
    H = rows * (cell_h + label_h) + (rows + 1) * gutter + cap_h + 2 * pad

    canvas = Image.new("RGB", (W, H), args.bg)
    draw = ImageDraw.Draw(canvas)

    font_label = pick_font(42)
    font_caption = pick_font(48)

    if args.caption:
        draw.text((pad, pad), args.caption, fill=(20, 20, 20), font=font_caption)

    labels = [s.strip() for s in args.labels.split(",")] if args.labels else []
    for i, im in enumerate(resized):
        r, c = divmod(i, cols)
        x = pad + gutter + c * (cell_w + gutter)
        y = pad + cap_h + gutter + r * (cell_h + label_h + gutter)
        # Center the image vertically within its row's cell area
        yo = y + (cell_h - im.height) // 2
        canvas.paste(im, (x, yo))
        label = labels[i] if i < len(labels) else f"Option {chr(ord('A') + i)}"
        draw.text((x, y + cell_h + 8), label, fill=(20, 20, 20), font=font_label)

    canvas.save(args.outfile, quality=92)
    print(args.outfile)
    return 0


if __name__ == "__main__":
    sys.exit(main())
