---
name: printing
description: Run the household's Bambu Lab P2S 3D printer like an expert. Designing for print, finding models on MakerWorld, slicing with the right settings, reading the preview and every slicer warning, filament and AMS planning, the approval rule, watching prints, reading Bambu errors, timelapses, and publishing to MakerWorld. Read before any print-related reply.
---

# Printing on the P2S

You have a real printer and real people waiting on it. The work is the same
as a careful person at a print farm: get the part right in the slicer, get
the right filament in, get permission, check the plate, start it, watch it,
and tell people what is happening in plain words.

## The tools

| Want to | Tool |
|---|---|
| Know everything about the printer now (state, %, time left, temps, every AMS slot, errors) | `printer_status` |
| See it | `printer_camera` (turns the chamber light on for the shot; returns a `frame_id`) |
| Be woken at a %, a layer, the end, a pause, an error, or a filament change | `printer_watch` |
| Timelapse videos | `printer_timelapse` (list / get, `share` for a permanent link) |
| Decode an error code someone reads to you | `printer_error_lookup` |
| Slice with any settings, and see time, grams, warnings, render and toolpaths | `print_slice` |
| More views: seams, layers, supports, overhangs, sides | `print_preview` |
| Find the exact setting key to change | `print_settings` |
| Make it a job, record the design OK, plan filament, swap in a re-slice | `print_job` |
| Ask the approver | `print_request_approval` |
| Start it | `print_start` |
| Cancel / resume (each needs its own yes), light | `print_control` |
| Find, show, download models | `makerworld_search`, `makerworld_model`, `makerworld_download` |
| Publish to MakerWorld (approver only) | `makerworld_package`, then the browser |

## The rule that never bends

A print starts only after the approver says yes to that print. Not the
requester, not someone else in the group, not an earlier yes to a different
version. The code enforces it: `print_start` re-reads Messages for the
approver's reply to the ask, checks the yes is newer than the ask and not
stale, checks the conversation calling is the one that asked, checks the
colors loaded are the ones in the approved plan, needs a camera frame you
took after the yes, and runs its own independent look at the plate. If
anything fails it tells you every reason; fix them, do not argue with them.

- Cancel and resume each need their own yes (`print_request_approval`
  with action cancel or resume). There is no pause, from any path.
- If the job changes after a yes (new slice, different colors), the yes is
  gone. Ask again.
- A hedged reply ("yes but swap the blue first", "is it PLA?") is not a
  decision. Answer it, and wait for a plain yes, a no, or a like on the ask.

## The whole flow, in order

1. **Understand what they want.** Size (ask what it sits next to, or what it
   must hold), colors, strength or looks, by when. A keychain, a replacement
   clip and a vase are three different jobs.
2. **Get a model.** Design it (build123d is installed; see
   `references/design.md`) or find it: `makerworld_search`, look at the
   covers, `makerworld_model` for photos and profiles, send them the photos
   to choose from. Check the license before you remix anything for others.
3. **Slice it** with `print_slice`. Start from Bambu's profile for the job
   (quality preset + plate) and change only what the part needs
   (`references/settings.md`).
4. **Read the result like a pro** (`references/preview.md`): every warning,
   the render, the toolpath preview, seams, overhangs, supports, first layer,
   filament changes and purge, time by feature. Fix and re-slice until there
   is nothing you would be embarrassed by. Never show a person a slice with an
   unread warning.
5. **Show the requester** the render (and photos), the time and the colors.
   Get their OK on the design and record their words: `print_job create`,
   then `print_job update design_ok`.
6. **Plan the filament**: `print_job plan`. If a slot needs swapping, ask
   whoever is at the printer in plain words: "Can you put red PLA in slot 4
   (it has the black in it now)?" In a group with the approver, ask there; if
   the request came in someone else's DM, ask in the approver's DM. Set a
   filament wake-up (`printer_watch` kind filament) so you know when it is done.
7. **Ask for approval**: `print_request_approval` with your own words; the
   facts and "reply yes to print it" are added. Tell the requester you have
   asked. You are woken when the answer comes.
8. **After the yes**: `printer_camera`, look at the plate with your own eyes
   (anything on it, even a purge blob, is a no), then `print_start` with that
   `frame_id`. It returns the live page link: send it to the person who asked.
9. **While it prints** you are woken at 25/50/75% (long prints), at the end
   with a photo, on errors and on pauses. Answer like a friend watching the
   printer: short, useful, no noise. A progress note nobody needs is noise.
10. **At the end**: send the photo, mention the timelapse on the page, and
    ask the approver to take it off the plate.

## Talking about prints

- Times in hours and minutes, weights in grams, colors by name ("the red
  PLA in slot 2"), never hex codes or slot ids to a person.
- Say what will look rough before they see it (supports leave marks; a seam
  shows as a faint line; text under 5 mm tall blurs at 0.2 mm layers).
- If something failed, say what happened, what you think caused it, and
  what you would change. Never invent a cause; look (`printer_camera`,
  `printer_status`) first.

## References

- `references/p2s.md` — this printer, its limits, what is installed, LAN modes
- `references/materials.md` — PLA, PETG, TPU, ABS/ASA and the rest: temps, plates, drying
- `references/settings.md` — the settings that matter and recipes by goal
- `references/preview.md` — reading the slice: warnings, seams, overhangs, supports, purge
- `references/design.md` — designing for FDM, multi-color economics, tolerances
- `references/troubleshooting.md` — failures, Bambu errors, what to check
- `references/makerworld.md` — searching, licenses, downloading, altering, publishing
