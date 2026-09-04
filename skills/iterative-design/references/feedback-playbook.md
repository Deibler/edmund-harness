# Feedback playbook

Fuzzy tweak requests decoded. Each row: what the user says, what they
almost certainly mean, and the smallest change that satisfies it.

## Position / size

| User says | Means | Action |
|---|---|---|
| "move it down a bit" | ~5–10% of canvas height | SVG: bump `transform="translate(0,YY)"` by 5–8% of viewBox height |
| "make it bigger" | ~20% scale up (first try) | SVG: `transform="scale(1.2)"` around shape center; re-center after |
| "center it" | It's visually off even if geometrically centered | Check for optical centering — text with descenders sits "low" even when pixel-centered. Shift up 2–4% |
| "tighter" | Reduce internal padding | Shrink viewBox margins, not the art |
| "too much space at the top" | Re-crop or lift art up | Adjust `translate` on the whole group, don't resize |

## Color

| User says | Means | Action |
|---|---|---|
| "try a different color" | Keep one element, swap another | Ask WHICH element, don't re-palette the whole thing |
| "navy's too dark" | Either lighten by 10% or shift to teal | Send two variants (lighter navy + teal) |
| "black and white" | Grayscale OR two-color (black ink on white) | Default to 2-color — B&W screen prints are almost always 2-color |
| "more colorful" | Usually means more *saturation*, not more hues | Bump saturation 15–20% before adding new hues |
| "washed out" | Lower contrast or add distress filter | `distress.py` at 0.4 usually nails this |

## Typography

| User says | Means | Action |
|---|---|---|
| "the text looks weird" | Tracking, weight, or alignment | Check tracking first (often too tight in rendered SVG); then weight |
| "smaller text" | Usually wants smaller AND tighter margin | Shrink 10%, then check if it rebreathes the layout |
| "different font" | Rarely specific — they want a different *vibe* | Offer 3 variants (condensed, slab, script) via variant_grid |
| "arc the text" | Circular path around a central shape | See `svg-recipes.md` — textPath on a circle |
| "it's hard to read" | Weight too thin OR contrast too low | Bump weight one step before tweaking color |

## Imagery / illustration

| User says | Means | Action |
|---|---|---|
| "swap the dog for a crab" | Regen illustration layer only | AI gen new illustration with same style tokens ("flat, 2-color, same palette"), replace `<image href="...">` in SVG |
| "looks wrong / off" | Usually faces, hands, or text the AI wrote | Run `detect_markup.py` if they marked it up, otherwise zoom the face region and offer 3 regens |
| "more like [reference]" | They want style transfer from a ref | Pass reference as `reference_images`, prompt for style extraction |
| "can you make the fish bigger" | Literally enlarge the fish, not the canvas | Raster: pass previous round + prompt "enlarge the fish 30%, preserve everything else" |
| "make this an svg" / "vectorize this" | Convert a raster to an editable SVG | Color image → `trace_color.sh` (vtracer). B&W line art → `trace_sketch.sh` (potrace). Never use potrace on color. |
| "remove the background" | Transparent PNG, interior colors intact | `remove_bg.sh` (rembg). Do NOT use `magick -fuzz white` — it eats interior regions that match the bg |
| "the color on the logo disappeared" | You used potrace on a color image, or fuzz ate the interior | Redo: run `remove_bg.sh` → `trace_color.sh`. Show before/after so they can verify |
| "make it a pencil sketch / oil painting / sepia" | Filter the raster, don't regen | `stylize.sh photo.png out.png pencilbw` / `sepia` / `smooth`. Preserves the subject exactly |
| "poster-ize it" / "make it a triangle portrait" | Geometric/shape approximation | `photo_to_svg.sh --shapes 200 --mode triangle` (primitive) |
| "can I get the PDF / vector file" | They need the editable source for print | Ship both `source.svg` AND a PDF: `inkscape source.svg --actions='export-filename:out.pdf;export-do'` |

## Mood / feel

| User says | Means | Action |
|---|---|---|
| "more vintage" | Distress + palette shift toward cream/navy | `distress.py --intensity 0.5`; swap pure white → cream `#F4EDE2` |
| "cleaner" | Remove distress, simplify | Revert to non-distressed rendering |
| "more fun" | Usually wants bolder colors, playful elements | Bump saturation; consider adding one accent element |
| "more serious" | Drop distress, drop accent colors, 2-color | Flatten palette, remove grunge |

## The "I can see it but can't say it" signals

When any of these fire, skip the guess-and-check and reach for tooling:

- "something's off but I can't explain it" → `annotate_grid.py`, ask which cell
- "not quite right" + a marked-up image back → `detect_markup.py` to find the region
- "one of these is closer" — they're choosing between options → already on the right track, give them 3 more focused variants
- Third round of tweaks and no clear direction → **stop**. Ask one precise closed question ("keep or lose the rope border?") rather than another round

## When to push back

Casey values speed and print-readiness over maximalism. If a tweak will make the design hard to screen print (more colors, thin strokes, gradients), flag it **before** you execute:

> "That'll push it to 7 colors — want me to try it, or find a way to hit it in 5?"

Silently adding complexity and then surfacing the printability warning after is worse than the quick sanity check up front.
