# Reading a slice like a professional

`print_slice` returns the facts, the slicer's own render of the plate, and a
toolpath picture. `print_preview` gives more: `iso`, `iso_back`, `top`,
`front`, `back`, `left`, `right`, `seams`, `supports`, `overhangs`, `layer`
(one layer from above with seams), `first_layer`, colored by `feature` (like
the app's legend) or `filament`.

## 1. Warnings first, every time

The slicer's warnings are the same ones the app shows in its notification
corner. Each one means something specific:

| Warning (gist) | Means | Usual fix |
|---|---|---|
| "has floating cantilever" / "floating regions" / "large overhangs" ... "enable support generation" | Parts print in mid-air | Re-orient (`rotate_x` / `rotate_y`), or `enable_support: true` (tree for organic shapes) |
| "empty layer between X and Y" | A gap in Z: something is not connected to anything below | Re-orient, add supports, or fix the model (two parts not touching) |
| "G-code conflicts" / "path conflicts" | Objects or the prime tower collide | Space objects, move or drop the prime tower |
| "outside the printable area" | Too big or off the plate | Scale down, rotate, or split |
| "filament unprintable on this plate" / temperature mismatch | Material does not suit the plate, or mixed temps | Change plate, or do not mix PLA with PETG/ABS in one print |
| Slicing failed with no other words | Look at the warnings above it; the result summary is generic | |

A warning you choose to ignore must be one you can explain to the person.

## 2. The numbers

- **Time** and **grams per filament**. Sanity check against the part's size.
- **Time by feature**: `Flush` and `Prime tower` are waste from color
  changes; `Travel` large means scattered islands; `Custom` is the start
  sequence (calibration, ~5-7 min on the P2S).
- **Filament changes**: each costs time and purge. 18 changes on a small
  figure can double the print time (measured: a two-color dragon, 35 min of
  model, 29 min of purge).
- **Supports: yes/none**, overhang wall length, bridge length.

## 3. The pictures

- **iso / iso_back**: does it look like the thing? Missing pieces (thin
  features that vanished: too thin for the nozzle) or extra blobs.
- **overhangs**: blue is printed over air or steep slopes. A little at the
  edges is fine; large blue undersides will droop or curl without support.
- **supports**: green is support. Is it touching surfaces people will see?
  Tree supports scar less; supports on top of the model (not from the
  plate) leave marks on the model.
- **seams**: red dots are where each outer wall loop starts. An aligned line
  on the visible front of a face or a figure's face is bad; move it
  (`seam_position: "back"`) or hide it in a corner. Scattered is invisible
  as a line but slightly rough everywhere.
- **first_layer**: the footprint. Small contact area on a tall part = tip
  over risk (add brim). Text or detail on the first layer prints squished.
- **layer N**: check a thin wall section, the layer where an overhang
  starts, or where colors change.
- **filament** coloring: confirm each part is the color the person chose.

## 4. Decide

Fix, re-slice, and look again until you would sign off on it. Then show the
person the render (and photos for MakerWorld models), the time, the colors,
and anything that will look imperfect.
