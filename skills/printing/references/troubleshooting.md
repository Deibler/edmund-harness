# When something goes wrong

Always look first: `printer_camera` and `printer_status` (errors come
decoded in Bambu's own words with the code). Then say what you see, what it
probably means, and what you would do. Cancelling and resuming need the
approver's yes; pausing is never yours to do.

## Reading Bambu errors

- **HMS codes** look like `0300_0100_0001_0007` (shown on the screen and in
  the app). The first group is the module: 03 motion/print, 05 mainboard,
  07 AMS, 08 toolhead, 0C camera/AI, 12 AMS lite, 18 AMS HT. Severity comes
  with the decoded text (fatal, serious, common, info).
- **Device errors** look like `0300_400C` (the print stopped or failed).
  `0300_400C` is a cancel, `0500_400E` a cancelled job.
- `printer_error_lookup` decodes any code someone reads to you. For repair
  steps, read the wiki page for the code (web_fetch on
  wiki.bambulab.com, search the code).

## Common failures

| What you see | Likely cause | What to do |
|---|---|---|
| Nothing sticks / first layer peels | Dirty plate, wrong plate for the slice, wet PETG | Wash plate with dish soap, check plate matches slice, dry filament |
| First layer smashed or rough | Wrong plate type in slice, Z offset | Re-slice for the plate actually on the bed |
| Spaghetti (loose strands) | Part detached or an overhang without support | The printer's AI may pause it; tell the approver; re-slice with supports or brim |
| Stringing | Wet filament (PETG, TPU), temp too high | Dry it; lower nozzle temp 5-10 C |
| Layer shift | Collision with curled edges, belt | Look at the photo; tell the approver |
| Under-extrusion / gaps | Clog, wet filament, tangle | Check AMS errors; the printer detects clogs (nozzle clog pause) |
| AMS feed / tangle errors (07xx) | Spool tangled, cardboard dust, buffer | Someone has to look at the AMS; describe the slot |
| Warping corners (ABS/ASA/PETG) | Cooling, small contact, no brim | Brim, door closed, smaller parts |
| Paused: filament ran out | Spool empty | Ask for a new spool of the same filament in that slot, then a resume needs the approver's yes |
| Paused: front cover / door | Opened mid-print | Tell the approver |

## After a failure

- Save what you learned to the person's memory (what failed, what fixed it).
- Offer the next attempt with the change, the new time, and what to expect.
- Partial prints: the timelapse shows where it went wrong; fetch it.
