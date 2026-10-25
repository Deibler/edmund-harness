# Settings

`print_slice` takes `quality` (layer height preset), `plate`, `copies`,
`scale`, rotations, `plate_index`, and `settings`: any Bambu Studio process or
filament key with a value. Unknown keys are reported back as NOT APPLIED;
find the right key with `print_settings` ("support", "seam", "brim").
Values are strings like the app's ("25%", "tree(auto)") or numbers/booleans.

## Presets (0.4 nozzle)

| quality | layer | Use |
|---|---|---|
| draft | 0.24 mm | Big, plain, fast parts |
| standard | 0.20 mm | Default for almost everything |
| balanced | 0.16 mm | Figures, visible curves, text |
| fine | 0.12 mm | Small detailed models, miniatures |
| extra_fine | 0.08 mm | Tiny detail only; slow |

## Keys that matter most

| Goal | Keys and values |
|---|---|
| Supports on | `enable_support: true`, `support_type: "tree(auto)"` (organic, easy removal) or `"normal(auto)"` (flat overhangs, bridges) |
| Supports only from the plate | `support_on_build_plate_only: true` |
| When supports kick in | `support_threshold_angle: 30` (degrees from horizontal; lower = fewer supports) |
| Easier support removal | `support_top_z_distance: 0.2`, `support_interface_top_layers: 3` |
| Strength | `wall_loops: 4`, `sparse_infill_density: "30%"`, `sparse_infill_pattern: "gyroid"`, `top_shell_layers: 5`, `bottom_shell_layers: 4` |
| Light and fast | `wall_loops: 2`, `sparse_infill_density: "10%"`, `sparse_infill_pattern: "lightning"` (decor only) |
| Seam placement | `seam_position: "aligned"` (one line), `"back"` (hide it at the back), `"nearest"`, `"random"` (scattered, no line, slightly rough) |
| Scarf seam (smoother seam) | `seam_slope_type: "all"` |
| Adhesion / warping | `brim_type: "outer_only"`, `brim_width: 5`; `brim_type: "no_brim"` to remove |
| Smooth top | `ironing_type: "top"` |
| Fuzzy texture | `fuzzy_skin: "external"` |
| Thin walls, small text | `wall_generator: "arachne"` (default on P2S profiles is often classic) |
| Elephant foot | `elefant_foot_compensation: 0.15` |
| Vase | `spiral_mode: true` (single wall, no top, one part) |
| Object-by-object | `print_sequence: "by object"` (only for short parts that clear the toolhead) |
| Prime tower | `enable_prime_tower: false` only for single color |
| Fewer color changes | Fewer distinct colored Z layers (see design.md), `flush_into_infill: true`, `flush_into_objects: true` |
| Filament temps | `nozzle_temperature: 225`, `hot_plate_temp`/`textured_plate_temp` for bed (filament keys) |

## Recipes

- **Functional bracket / clip (PETG or PLA)**: standard, `wall_loops: 4`,
  `sparse_infill_density: "35%"`, gyroid, orient so layers run along the
  load (layers split apart, they do not snap across).
- **Figure / miniature**: balanced or fine, tree supports, `seam_position:
  "back"` or random for round bodies, arachne walls.
- **Articulated / print-in-place**: keep the designer's settings and
  orientation; do not scale below 100% (clearances shrink and fuse).
- **Big flat part**: brim outer only, slow first layer is already in profile,
  make sure the plate is clean.
- **Text on a top face**: 0.12-0.16 layers, ironing optional, text at least
  0.6 mm stroke width.
- **Multi-color**: put color on flat faces; check `Filament changes` and
  `Flush` time in the result; if flush is more than a third of the time,
  redesign or reduce colors.

## Rules of thumb

- Change one or two things at a time and re-slice; read what moved.
- Scaling a model does not scale clearances, threads or snap fits correctly;
  print-in-place joints usually fail below 100%.
- Doubling infill rarely doubles strength; walls do more.
