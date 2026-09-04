---
name: iterative-design
description: Use this skill whenever the user is iterating on a visual — flat graphics, logos, badges, t-shirt prints, hockey/sports graphics, or subtle photo edits across multiple rounds. Triggers on phrases like "try it with", "move it", "make it bigger", "change the color", "not quite right", or when the user sends back a marked-up or regenerated image. Keeps an editable SVG source of truth between rounds, renders PNGs for iMessage delivery, generates parallel candidate variants for fuzzy feedback, overlays labeled grids when the user "can see it but can't describe it", and chains with the `generation` skill for AI illustration layers. Also use when starting any new design destined for screen print (t-shirts, posters, banners).
---

# iterative-design

Use this when someone is **iterating** on a visual. One-shot generation goes to `image-gen` or `generation`. This skill owns the multi-round loop: source-of-truth between rounds, decoding fuzzy feedback, changing one thing without regenerating everything, and landing on a final that screen-prints cleanly.

## Modes — pick one at round 1, stick with it

**SVG mode** for anything with text, geometric shapes, circular typography, borders, or destined for screen print / vinyl cut. SVG is the only sane way to do 15 rounds of "5px left, wrong color, go back to round 2." Pixel regenerations drift; SVG edits don't.

**Raster mode** for photograph edits and scene composition. Delegate the pixels to the `generation` skill; this skill owns the loop (versioning, feedback decoding, variant fans).

Mixed (illustrated badge with an AI mascot): SVG mode with the raster as an embedded `<image href="...">` layer. Regenerate only the illustration when swapping the mascot; the badge structure stays stable.

## CLI toolkit

All installed and on PATH. Reach for the right tool on the first try — the common failure mode is defaulting to `potrace` or `magick -fuzz` for everything and shipping washed-out output.

| Need | Tool / script |
|---|---|
| Vectorize a **color** raster (logo, badge, multi-color mark) | `scripts/trace_color.sh` (vtracer) |
| Vectorize **B&W** line art, silhouette, hand sketch | `scripts/trace_sketch.sh` (potrace) |
| Remove background from a photo, **keep interior colors** | `scripts/remove_bg.sh` (rembg / U²-Net) |
| Photoshop-style filter on a raster (sepia, pencil, quantize) | `scripts/stylize.sh` (gmic) |
| Stylized geometric-shapes SVG from a photo (triangles, ellipses) | `scripts/photo_to_svg.sh` (primitive) |
| Render SVG → PNG (fast, most cases) | `scripts/render_svg.sh` (rsvg-convert) |
| Render SVG → PNG (accurate — gradients, filters, complex files) | `resvg in.svg out.png` |
| Edit SVG programmatically (boolean ops, text→path, flatten) | `inkscape --actions='...'` |
| Clean SVG **between rounds** (safe, preserves IDs) | `scripts/svg_optimize.py` |
| SVG **final export** optimization (aggressive multipass) | `scripts/svgo_final.sh` (svgo) |
| Apply distress / grunge | `scripts/distress.py` |
| Labeled grid overlay for "I can see it but can't describe it" | `scripts/annotate_grid.py` |
| Side-by-side variant picker | `scripts/variant_grid.py` |
| Detect user-drawn markup on a returned image | `scripts/detect_markup.py` |
| Optimize final PNG for delivery | `oxipng -o max --strip safe file.png` |
| Inspect/strip metadata | `exiftool` |

### Tool-selection rules

- **Color trace:** use `trace_color.sh` (vtracer). Never `potrace` — it is B&W only and will collapse all color to a single fill. This is the Warriors/Bears-Cup-logo failure mode.
- **Background removal:** use `remove_bg.sh` (rembg). Never `magick -fuzz` or `-transparent white` for anything non-trivial — fuzz-based removal eats interior regions that happen to match the background (red logo on white → red shadows inside the logo also vanish).
- **Before tracing a photo:** run `remove_bg.sh` first. Tracing a raster with its white field intact gives you a 2000x2000 white polygon behind the subject.
- **Render before delivery:** SVG → PNG always. iMessage can't preview SVGs, and `.svg` attachments arrive as `.txt`.

## The four phases

### 1. Brief (round 0, ~30 seconds)

Before touching the canvas, ground the design. Read `references/brief-template.md` for the question set. For a repeat user like Casey, most of the brief is already in his person file — palette preferences (vintage navy + cream), format (flat on white, no mockup), and style (distressed collegiate). Still confirm anything ambiguous with **one** multi-choice question rather than a freeform ask:

> "Going full distress like the Salty Dog, or cleaner like the pirate one?"

Write the brief to `design-<slug>/brief.md` so round 5 doesn't drift.

### 2. Explore (first delivery, parallel candidates)

For a fresh design, generate **three candidates in parallel** with distinct interpretations, not three variations on the same interpretation. Compose with `scripts/variant_grid.py` into one image and deliver. One round of "which direction?" beats three rounds of guessing at intent.

For an iteration on an existing design, skip this phase and go straight to Refine.

### 3. Refine (rounds 2..N)

The loop:
```
receive tweak → interpret → edit source → render → deliver
```

**Interpret** — the tweak arrives as text, a marked-up image, a silent new photo (a visual target), or nothing at all (they just sent a new reference). For text tweaks see `references/feedback-playbook.md`. For marked-up images, run `scripts/detect_markup.py` to locate the region.

**Edit, don't regenerate.** In SVG mode: change the one attribute — `transform`, `fill`, `stroke-width`, a `textPath` content string. In raster mode: pass the *previous round* (not the original) as `reference_images` so the AI is editing what they saw, not starting over.

**When the user sends a raster and asks for an SVG.** Two steps, always in this order:
```bash
bash scripts/remove_bg.sh input.png design-<slug>/trace-src.png    # if bg needs to go
bash scripts/trace_color.sh design-<slug>/trace-src.png design-<slug>/source.svg
```
Then `render_svg.sh` and deliver. If the user asks to "clean up" or "make it editable" after that, run `svg_optimize.py` — `svgo_final.sh` is for the final export only.

**When the user asks for a style variation on a photo** (oil paint, sepia, pencil), use `stylize.sh` rather than regenerating — it preserves the subject exactly and just treats the pixels.

**When genuinely stuck** — two-round rule. If you've asked "do you mean X or Y" once and missed, switch modes:
- `scripts/annotate_grid.py` overlays labeled cells (A1–D4) on the last round. Send back and ask "which cell is off?" Users can nearly always point, even when they can't describe.
- `scripts/variant_grid.py` composes 3 focused candidates. Use when you have a guess but want to cover adjacent options.

**Render.** SVG → PNG is not optional before sending; iMessage can't preview SVGs.

```bash
bash scripts/render_svg.sh source.svg rounds/NN.png --width 2400
```

**View before you send.** Always `Read` the rendered PNG yourself before delivering. This is the step that catches "potrace flattened the Warriors red to black," "rembg took a chunk out of the beard," or "the SVG has a 2000px white rectangle behind the logo." One visual check per round is cheaper than one round of user confusion.

### 4. Export (final round)

Before declaring done, run three checks:

```bash
bash scripts/svg_validate.sh source.svg                    # well-formed XML / SVG structure
bash scripts/svgo_final.sh source.svg source.min.svg       # aggressive multipass optimization
bash scripts/size_check.sh source.svg rounds/size-strip.png # legibility at 2400/800/400/128
```

Use `svgo_final.sh` only for the *final* export — it merges paths and can drop the anchors you used between rounds. For in-loop cleanup stick to `svg_optimize.py`.

Optimize the PNG delivery too:
```bash
oxipng -o max --strip safe rounds/final.png
```

For screen print, also run:
```bash
python3 scripts/printability_check.py rounds/NN.png
```

Surface any warnings to the user *before* they send to the printer. Then apply distress if that's the style:
```bash
python3 scripts/distress.py rounds/NN.png rounds/NN-distressed.png --intensity 0.4
```

Keep both the clean and the distressed version — some printers want the clean SVG, not the grunge PNG.

## Chaining with `generation`

For the raster illustration inside an SVG badge, or for pure photo edits, delegate to the `generation` skill. Write the prompt with three pieces — see `references/prompt-templates.md` for the full structure:

1. **Dimensional**: "for a 12-inch t-shirt print at 300 DPI" or "fills a 1040x1040px circle"
2. **Aesthetic**: "flat 2-color vector style, navy on cream, no gradients, distressed collegiate"
3. **Technical**: "transparent background, no text, no border — the SVG will add those"

A prompt that skips the technical piece is how you end up with an AI-rendered rope border fighting your real rope border.

## Research when you need reference

When the user says "vintage collegiate" or "like a Salty Dog" and the reference isn't already in the sandbox, do one short research pass before generating:

1. `WebSearch` for the style/era ("vintage collegiate varsity badge", "1970s surf shop logo").
2. `WebFetch` 2–3 images into `design-<slug>/refs/`.
3. Pass them to `generation` as `reference_images`.

Don't research for five rounds — do it once, up front, and move on.

## Sandbox layout

```
sandbox/<thread>/design-<slug>/
  brief.md              # palette, format, style, any user constraints
  source.svg            # SVG mode: edit this between rounds
  illustration.png      # AI raster layer referenced by source.svg
  refs/                 # inspiration images, from web research or user uploads
  rounds/
    01.png              # every delivered output — no exceptions
    02.png
    02-distressed.png
    03.png
  notes.md              # "round 2: rope thicker, liked crab, rejected pirate"
```

`notes.md` pays for itself on round 5 when the user says "go back to the one with the rope" and you need to remember which round that was.

## IP safety

Sports-team and institutional graphics (Warwick hockey, Bears Cup, Ocean City tourism logos) often ride on registered trademarks. Rules:

- Reproducing an official team mark, logo, or wordmark is a no — even as a "reference" that the user will "just use personally." Flag and decline.
- "In the style of" a well-known brand (Patagonia, Stüssy, college varsity marks) is fine as long as the output is a fresh composition, not a trace.
- If the user sends a copyrighted image as a reference expecting you to reproduce it verbatim, say so out loud: "I can do a design inspired by this — reproducing it 1:1 is a trademark issue. Same vibe, different execution?"

## Anti-patterns

- Regenerating from scratch when a 20px move was asked. SVG edits are free; AI round-trips cost seconds and drift.
- Sending an SVG file over iMessage. Always render to PNG (JPG for photo edits).
- Applying distress on round 2. Distress hides composition problems from both of you — lock the clean design first.
- Guessing at a fuzzy tweak when grid-annotate would save three rounds. Use the two-round rule.
- Losing the previous round. Every send goes to `rounds/NN.png`. No exceptions.
- Writing per-round state into the person file. Rounds are ephemeral; they live in `notes.md`, not memory.
- Blowing through `brief.md` and going straight to generation. The brief is the contract — 30 seconds now saves 30 minutes of drift.
- Using `potrace` on a color logo — it is B&W only. Reach for `trace_color.sh` (vtracer).
- Using `magick -fuzz` or `-transparent white` to "remove the background" on anything with interior color. It eats colors that match the bg. Reach for `remove_bg.sh` (rembg).
- Running `svgo` or `svgo_final.sh` between rounds. It's for final export only — it merges/renames paths and can break your iteration anchors.
