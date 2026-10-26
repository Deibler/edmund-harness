---
"edmund-harness": minor
---

The printer, without giving up Bambu Handy.

- **The live page is rebuilt.**
  - The camera is real video: the printer's own H.264 passed through as HLS at 30 fps, served by a camera host process separate from the daemon.
  - A stream that goes quiet reconnects by itself, and players keep a few seconds of buffer.
  - The page is dark and plain, with native full screen.
  - A Camera/Model switch shows the sliced model on its plate in its filament colors, with what is still to print shown faintly. Drag to turn, pinch to zoom.
- **Prints can start through Bambu Connect**, so the printer stays in cloud mode with Bambu Handy working. Bambu Connect is driven through macOS Accessibility, and its send dialog is checked against the plan before Send.
- **The approver can confirm the plate by text.** When the plate check is unsure, Edmund sends a photo and asks; a plain "clear" counts.
- **Slicing thins meshes far finer than a nozzle can print.** Painted detail is kept, and no surface moves more than 0.05 mm.
- **The kitchen host no longer cuts off a mounted page after 10 seconds.**
