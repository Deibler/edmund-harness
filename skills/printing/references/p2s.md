# The printer

Verified on the household printer 2026-10-25 unless marked otherwise.

## Hardware

- **Bambu Lab P2S**, firmware 01.03.00.00 (read live with `printer_status`).
- **Build volume** 256 x 256 x 256 mm (Bambu spec). Plate centre is X128 Y128.
- **Nozzle** 0.4 mm hardened steel (reports type HS01). Bambu lists 0.2, 0.4,
  0.6 and 0.8 mm nozzles; slicing reads the fitted size from the printer.
  Hardened steel means abrasive filaments (CF, GF, glow-in-the-dark) are safe
  for the nozzle.
- **Max temperatures** (Bambu spec): nozzle 300 C, bed 110 C. The chamber is
  enclosed but **not actively heated**; it warms passively from the bed
  (it reports a chamber temperature).
- **AMS 2 Pro** (4 slots) with RFID reading for Bambu spools and a built-in
  dryer (up to 65 C per Bambu's spec; not enough to fully dry nylon, PC or
  ABS-class filament). Plus a **filament buffer**. Humidity and AMS
  temperature show in `printer_status`.
- **External spool holder** at the back: use it for TPU and anything the AMS
  should not feed (very soft, very brittle, cardboard spools that shed).
- **Camera** 1080p in the chamber, used for live view, the first-layer and
  spaghetti AI checks (enabled on this printer: first layer inspector,
  spaghetti detector, build plate marker detection, print halt on detect).
- **Plates**: textured PEI is the default on this printer. Bambu also lists
  smooth PEI and Cool Plate SuperTack as supported. The printer reads plate
  markers to warn when the plate on the bed does not match the slice.

## What Edmund can and cannot do, and why

| Capability | Needs |
|---|---|
| Status, AMS, errors, light, timelapses, model files on the printer | Works now (LAN access code) |
| Camera pictures and the live page's video | **LAN Only Liveview** on in the printer's network settings |
| Start, cancel, resume a print | **Developer Mode**, which the P2S offers only after **LAN Only Mode** is on |
| MakerWorld downloads | The approver's Bambu sign-in (`makerworld_login`), lasts about a year |

Developer Mode exists because Bambu's 2025 firmware requires signed commands
from anything that is not Bambu's own app; Developer Mode is Bambu's
supported way to let local software control the printer. LAN Only Mode turns
off Bambu Handy (the phone app) and cloud printing. That trade is the
owner's call; never pressure for it. When it is off, say plainly that you
can prepare everything and the approver can start it from the printer or
Bambu Studio.

## Where things live

- Print files Edmund makes: this chat's sandbox under `prints/`.
- Jobs, approvals, wake-ups, frames: the harness data dir `printer/`.
- Timelapses: on the printer's internal storage (`/userdata/media/timelapse`),
  fetched with `printer_timelapse`. The printer keeps around a hundred.
- Model files sent to the printer: its model cache (`/userdata/model/history`).

## Time and noise

- Speed modes: silent, standard (default), sport, ludicrous. Edmund does not
  change speed mid-print.
- Bambu's time estimate is usually within 5-10% for single color. Color
  changes add time the estimate does include (flush), but very short layers
  (small parts) run slower than estimated because of minimum layer time.
