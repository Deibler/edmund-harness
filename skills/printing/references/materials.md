# Materials

The slicer picks temperatures from Bambu's profile for each filament (by the
spool's RFID id, else the generic profile for the material). Override only
with a reason.

| Material | Nozzle | Bed (textured PEI) | Good for | Watch out for |
|---|---|---|---|---|
| **PLA** (Basic, Matte) | 210-230 C | 55-65 C | Almost everything decorative; stiff, crisp detail, easy | Softens at ~55 C: no car dashboards, no dishwasher, no hot drinks |
| **PLA Silk / Galaxy / Marble** | 210-230 C | 55-65 C | Looks | Weaker layer bonding; silk shows every flaw |
| **PLA-CF** | 220-240 C | 55-65 C | Stiff matte parts | Abrasive (fine on this hardened nozzle), brittle |
| **PETG** (Basic, HF) | 240-260 C | 70 C | Functional parts, outdoors (some UV), food-adjacent, water | Strings; sticks too well to smooth PEI (use glue stick as a release layer there); first layer is the usual failure on the P2S: clean plate, slower first layer |
| **TPU** (85A-95A) | 220-240 C | 35-45 C | Flexible: bumpers, gaskets, phone cases, feet | Feed from the external spool for anything softer than 95A; slow (outer walls 20-40 mm/s); no retraction-heavy designs |
| **ABS / ASA** | 260-280 C | 90-100 C | Heat and UV (ASA outdoors), tough | Warps without a hot chamber; on this passively heated P2S keep parts small, add brim, close the door, preheat; fumes: ventilate |
| **PC, PA (nylon), PA-CF** | 270-300 C | 100-110 C | Engineering | Must be bone dry (the AMS 2 Pro tops out at 65 C, not enough); warps; not a beginner job |
| **PVA / BVOH** | per profile | per profile | Dissolvable support for PLA | Absorbs water in minutes; keep sealed |

## Plates

- **Textured PEI** (default here): PLA, PETG, TPU, ABS/ASA stick; parts pop
  off when cool; bottom shows the texture. Clean with dish soap and hot
  water, not just alcohol; never touch the surface.
- **Smooth PEI**: glossy bottom; PETG can bond too hard (use glue stick).
- **Cool Plate SuperTack**: PLA at low bed temps, very grippy; not for PETG.
- If the slice's plate and the plate on the bed differ, the first layer
  height and bed temperature are wrong. Ask what is on the bed when unsure;
  the printer's plate marker check also warns.

## Moisture

Wet filament pops, strings, and prints weak and fuzzy. PETG, TPU, nylon, PC
and PVA are the thirsty ones. AMS humidity shows in `printer_status`; above
~40% for PETG/TPU, suggest drying. The AMS 2 Pro can dry PLA/PETG/TPU at up
to 65 C (spec); a spool must not be threaded through the feeder while it
dries at high temperature. Drying is started from the printer or Bambu
Handy, not by Edmund.

## Color

- Bambu spools report their exact color by RFID; third-party spools carry
  whatever color was set by hand on the AMS, which may be rough.
- Silk and matte of the "same" color look different; say so before
  substituting.
- White and yellow need more walls / top layers to hide infill.
