# Designing for print

## Kernel

build123d (OCCT, headless) is installed for real CAD: fillets, chamfers,
text on paths, booleans. Export each colored part as its own STL in one
coordinate frame and slice them with `print_slice` `parts`
([{path, filament}]): they are merged into one object with positions kept.
That is the multi-color path. A single STL has no color.

## FDM rules

- **Overhangs**: up to ~45 degrees from vertical print fine; beyond that
  needs support or a chamfer. Turn horizontal ceilings into 45 degree
  chamfers or teardrops when possible.
- **Bridges**: up to ~20-30 mm span bridge cleanly in PLA.
- **Walls**: minimum ~0.8 mm (two lines at 0.4 mm); thinner features vanish.
- **Holes**: vertical holes print ~0.1-0.2 mm small; make them oversize.
  Horizontal holes sag at the top: teardrop shape.
- **Clearances**: 0.2 mm per side for sliding fits, 0.3-0.4 mm for print-in-
  place joints, 0.1 mm for press fits (test first).
- **Text**: raised or engraved 0.6-1 mm deep, stroke at least 0.6 mm; on top
  faces it is crisp, on vertical faces it is layer-stepped.
- **Orientation**: the flattest large face on the plate; layer lines across
  the load are weak; put the nicest face up or sideways, never on supports.
- **Strength**: walls and orientation matter more than infill.
- **Size**: 256 x 256 x 256 mm max; big parts split with pins or dovetails.

## Multi-color economics

On an AMS every color change is a purge. The cost of a color is the number
of distinct Z layers it appears in, not its volume:

- Put color on flat horizontal faces (inlays 0.4-1.0 mm deep, labels on top
  faces) so it lives in a few layers. That is a handful of changes.
- Color on vertical faces changes every layer: hundreds of changes, an hour
  of purge on a small part. Redesign before printing that.
- Check `Filament changes` and `Flush` after slicing; if purge is over a
  third of the time, rethink.
- Keep to 4 colors (one AMS); a fifth needs a swap mid-design (not possible
  without pausing, which Edmund does not do).

## Before showing a design

- Render it and count its repeated parts (`blind_check` exists for this).
- Slice it and read the preview (preview.md).
- Know the time and cost in grams before you promise anything.
