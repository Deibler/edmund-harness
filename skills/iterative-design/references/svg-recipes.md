# SVG recipes

Copy-paste starting points for the layouts that come up most often.
Every recipe uses a 2000x2000 viewBox so print and screen render
consistently. Swap colors and text; keep structure.

## 1. Circular badge with top-arc and bottom-arc text

The OCMD "Salty Dog" shape — central illustration, curved text above,
curved text below, rope/line border.

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 2000" width="2000" height="2000">
  <defs>
    <!-- Path for top text — arcs clockwise across the top -->
    <path id="arc-top" d="M 400 1000 A 600 600 0 0 1 1600 1000" fill="none"/>
    <!-- Path for bottom text — arcs counterclockwise across the bottom -->
    <path id="arc-bottom" d="M 400 1000 A 600 600 0 0 0 1600 1000" fill="none"/>
  </defs>

  <!-- Outer rope/border circle -->
  <circle cx="1000" cy="1000" r="800" fill="none" stroke="#1B2A49" stroke-width="24"/>
  <circle cx="1000" cy="1000" r="760" fill="none" stroke="#1B2A49" stroke-width="8" stroke-dasharray="40 30"/>

  <!-- Central illustration layer (AI-generated, swappable) -->
  <image href="illustration.png" x="500" y="500" width="1000" height="1000" preserveAspectRatio="xMidYMid meet"/>

  <!-- Top arc text -->
  <text font-family="Arial Black, sans-serif" font-size="160" fill="#1B2A49" letter-spacing="12">
    <textPath href="#arc-top" startOffset="50%" text-anchor="middle">OCEAN CITY</textPath>
  </text>

  <!-- Bottom arc text — flipped so it reads left to right -->
  <text font-family="Arial Black, sans-serif" font-size="160" fill="#1B2A49" letter-spacing="12">
    <textPath href="#arc-bottom" startOffset="50%" text-anchor="middle">MARYLAND</textPath>
  </text>
</svg>
```

Tweak points:
- Top/bottom text: change the `<textPath>` content.
- Illustration: regenerate `illustration.png` only.
- Border thickness: `stroke-width` on the outer circles.
- Text arc tightness: change the radius (`600`) on `#arc-top`/`#arc-bottom`.

## 2. Rope border (stippled circle)

Replace the plain circle with a proper rope feel:

```xml
<circle cx="1000" cy="1000" r="800" fill="none"
        stroke="#1B2A49" stroke-width="28"
        stroke-dasharray="2 18" stroke-linecap="round"/>
<circle cx="1000" cy="1000" r="800" fill="none"
        stroke="#1B2A49" stroke-width="28"
        stroke-dasharray="2 18" stroke-linecap="round"
        transform="rotate(10 1000 1000)"/>
```

Two offset dashed circles give a twisted rope illusion. Rotate the
second between 6°–14° for different rope densities.

## 3. Pennant / banner with text

Hockey graphics, tournament badges:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 1200" width="2000" height="1200">
  <path d="M 200 200 L 1800 200 L 1700 700 L 1800 1000 L 200 1000 L 300 700 Z"
        fill="#B01E28" stroke="#1B2A49" stroke-width="12"/>
  <text x="1000" y="540" font-family="Georgia, serif" font-size="220" font-weight="900"
        fill="#FFF4CC" text-anchor="middle">BEARS</text>
  <text x="1000" y="780" font-family="Arial, sans-serif" font-size="100" font-weight="700"
        fill="#FFF4CC" text-anchor="middle" letter-spacing="12">CUP PLAYOFFS</text>
</svg>
```

## 4. 2-color palette presets

Screen-print safe, Casey-tested:

- **Vintage navy + cream**: `#1B2A49` on `#F4EDE2`
- **Surf**: `#0B6E87` on `#F6F1E1`
- **Warwick**: `#B01E28` + `#0E1A2B` on white
- **Pirate**: `#0E1A2B` + `#C9A24F` on cream

Keep fills on the same two hex codes across the whole SVG — makes
palette swaps a single find/replace.

## 5. Guard against floating-point drift

When tweaking positions across many rounds, round coordinates to
integers in the SVG. `x="742.3391"` after 10 edits becomes impossible
to re-align; `x="742"` stays readable and diffable.

## 6. Vectorizing an existing raster

Three tools, three different shapes. Pick by intent:

```bash
# Color logo / badge / multi-color mark — faithful vectorization
bash scripts/remove_bg.sh input.png clean.png           # if needed first
bash scripts/trace_color.sh clean.png source.svg \
  --mode polygon --color-precision 8

# Black-and-white line art, silhouette, hand drawing
bash scripts/trace_sketch.sh sketch.jpg source.svg \
  --color "#1B2A49"

# Stylized geometric approximation (triangles/ellipses)
bash scripts/photo_to_svg.sh photo.jpg art.svg \
  --shapes 200 --mode triangle
```

Common vtracer tuning (in `trace_color.sh`):
- `--mode spline` for smooth curves, `--mode polygon` for crisp straight edges (default — better for logos)
- `--color-precision 1..8` — lower → fewer colors; 8 = full fidelity
- `--filter-speckle N` — drops clusters smaller than N×N px; bump to 8+ for noisy scans
- `--gradient-step N` — color quantization; lower = more layers, larger file

### When the trace comes out weird

- **Tons of tiny fragments:** `--filter-speckle 10` and `--color-precision 4` to force a cleaner trace.
- **Smooth shapes look boxy:** `--mode spline`.
- **Colors bleed together:** bump `--color-precision` up; if that doesn't work, `magick in.png -posterize 6 pre.png` before tracing to make the color boundaries explicit.
- **Giant white rectangle wrapping everything:** you skipped `remove_bg.sh`. The tracer treated the white field as one big polygon.

## 7. Editing the traced SVG with Inkscape

After `trace_color.sh`, the output has one path per color region. Common follow-ups:

```bash
# Boolean-union overlapping paths of the same color (cleans up seams)
inkscape source.svg --actions='select-all;path-union;export-filename:source.svg;export-do'

# Convert embedded text to paths (safe for screen-print, no font dependency)
inkscape source.svg --actions='select-all;object-to-path;export-filename:source.svg;export-do'

# Export to PDF for the printer
inkscape source.svg --actions='export-filename:source.pdf;export-do'
```

Inkscape actions operate in sequence. Chain them with `;` in a single `--actions` string, finish with `export-do` to write.

## 8. Stylizing an embedded raster

When the badge center is a photo and the user wants a mood shift rather than a regen:

```bash
bash scripts/stylize.sh illustration.png illustration_pencil.png pencilbw
bash scripts/stylize.sh illustration.png illustration_sepia.png sepia
bash scripts/stylize.sh illustration.png illustration_quant.png quantize 6
```

`quantize 6` is especially useful as a **pre-vectorize step** — reduce a photo to 6 flat colors, then `trace_color.sh` gives you a clean 6-color SVG that screen-prints.

## 9. Embedding AI illustrations cleanly

When dropping a raster illustration into an SVG badge:

```xml
<clipPath id="inner-circle">
  <circle cx="1000" cy="1000" r="520"/>
</clipPath>
<image href="illustration.png" x="480" y="480" width="1040" height="1040"
       clip-path="url(#inner-circle)"
       preserveAspectRatio="xMidYMid slice"/>
```

The `clipPath` keeps any messy edges on the AI output from bleeding
into the rope border. Generate the raster with a transparent or
solid-color background — avoid complex scenery that fights the badge.
