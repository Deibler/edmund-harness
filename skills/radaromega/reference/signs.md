# Convective signs — reading the sky before the radar catches up

Companion reference to `skills/radaromega` and `skills/radaromega-pro`. Read this
when the question is **"what is about to happen"** rather than "what is happening".
Written 2026-09-03 from a live capability audit of the app plus the nowcasting
literature. Every number carries its source so a future me can check it instead
of trusting a remembered adjective.

The organising idea: a severe storm publishes its intentions in a fixed order,
and each stage is visible in a different instrument. Radar is the LAST of them.
By the time a 50 dBZ core exists, most of the decision has already been made
somewhere you could have looked twenty to ninety minutes earlier. This file is
that ladder, with what RadarOmega can and cannot actually show for each rung.

---

## 0. The lead-time ladder

| When | What you look at | Typical lead on the first severe report |
|---|---|---|
| 6-24 h | Model fields, soundings, SPC outlook | hours, but no placement skill |
| 1-6 h | Water-vapour shortwaves, surface boundaries, cloud streets | 1-4 h on *where*, not *whether* |
| 30-90 min | Cumulus field agitation, cap signals, orphan anvils | ~30-60 min on initiation |
| 15-45 min | Cloud-top cooling rate, glaciation, first towers | ~15-30 min on the first echo |
| 10-35 min | Overshooting top, enhanced-V, above-anvil cirrus plume | ~30 min (enhanced-V), ~31 min (AACP) |
| 10-25 min | Lightning jump (total flash rate) | ~21 min |
| 0-20 min | Radar structure: BWER, hook, ZDR column, couplet, TDS | minutes |

Read down the table on a quiet afternoon and up it during an event. The mistake
is to start at radar and work backwards, because radar has no memory of why the
storm exists and therefore no opinion about whether it will keep existing.

---

## 1. Stage one — the synoptic push (water vapour)

### Shortwave troughs
A shortwave is a small ripple in the upper flow that provides the lift a capped
airmass needs. On water-vapour imagery it is **the leading edge of a band of
cirrus / moisture moving with the upper flow**, usually a sharpening cyclonic
curl with drier (warmer, darker) air immediately behind it. That leading edge is
the thing to track: put a marker on it, step the loop, and extrapolate. Where it
arrives is where a capped field breaks first.

- Bands: **09 (6.9 µm mid-level WV)** is the workhorse; **08 (6.2 µm upper)** for
  jet-level features, **10 (7.3 µm lower)** for the shallow stuff nearer the cap.
- What you are actually seeing is the emission level of water vapour, so a "dry
  slot" is not necessarily cloud-free air — it is air whose moisture is deeper
  down, i.e. subsidence. Say "drier aloft", never "clearing".
- A shortwave with **no low-level moisture underneath it does nothing**. Pair it
  with the surface dewpoint field before you promise anything.

### Jet streaks and difluence
Bright/dark WV gradients that tighten and elongate mark the jet. The left-exit
and right-entrance regions are where large-scale ascent lives. Useful mostly for
explaining *why* a broad area is favoured; not a placement tool at county scale.

---

## 2. Stage two — the boundaries (visible)

Boundaries are where storms actually go up. They are visible, not radar,
features until something is raining.

### Outflow boundaries
A fine line of cumulus, or an arc of clearing, left behind by a decaying storm's
cold pool. On high-resolution visible (**Band 02, 0.64 µm, 0.5 km**) they are
obvious; on radar they are a thin fine line only when the boundary layer has
enough bugs and dust to scatter.

The distinction that matters, and the one most people get wrong:

- **Slow or stationary boundary, oriented roughly PARALLEL to storm motion** →
  a storm can ride along it, ingesting the locally enhanced low-level vorticity.
  This is the classic tornado-favouring case.
- **Fast, surging boundary, oriented across the storm's path** → it undercuts
  the updraft, lifts the inflow off the surface, and the storm goes elevated.
  Elevated storms still hail and still gust, but they stop being tornadic.

So the question is never "is there a boundary" — it is "how fast is it moving
and which way is it lying". Two loops fifteen minutes apart answer it.

### Differential heating / cloud-cover boundaries
The edge of an anvil shadow or a stratus deck becomes a mini-front by mid
afternoon. Watch for the cumulus field being noticeably taller and more agitated
on one side of yesterday's cloud edge.

### Cloud streets (horizontal convective rolls)
Parallel lines of shallow cumulus aligned with the boundary-layer wind. Two
readings, and they are opposite:

- Streets *present and staying shallow* = the boundary layer is well mixed but
  **still capped**. This is a suppression signal, and the single most common
  reason a Slight Risk quietly busts.
- Streets *deepening, widening, and losing their alignment* = the cap is going.
  When streets break into a disorganised field of taller cells, initiation is
  usually 30-60 minutes out.

Also worth knowing: a storm that fires on the intersection of a cloud street and
a boundary gets a head start, because the roll has already concentrated moisture
along its updraft branch.

---

## 3. Stage three — the cumulus field, and whether the cap breaks

The progression, in order, all on visible:

1. **Flat cumulus field.** Small, uniform, no vertical development. Nothing yet.
2. **Agitated cumulus.** Cells become visibly lumpy and start casting shadows;
   the field texture goes from stippled to popcorn. The cap is thinning.
3. **Towering cumulus.** Individual towers with shadows longer than their width.
4. **Orphan anvil.** A tower punches up, glaciates at the top, and the anvil
   drifts away downwind while the tower beneath it collapses. **This is a
   capped-and-losing signal, not a win.** An orphan anvil means the parcel got
   high enough to freeze but not high enough to sustain. Two or three orphan
   anvils in a row usually means the next tower is the one that goes.
5. **Convective initiation.** Formally defined in the nowcasting literature as
   the **first 35 dBZ radar echo from a cumuliform cloud** (Mecikalski and Bedka
   2006; Mecikalski et al. 2008, *Mon. Wea. Rev.* 136, 4899).

### The measurable version: cloud-top cooling
The best single CI predictor is not appearance, it is **how fast the top is
cooling**. The operational UWCI product flags a cooling rate of about
**−4 K per 15 minutes** over a cluster of pixels as the trigger. In practice,
cloud-top cooling leads the first 10 dBZ echo aloft by roughly 15 minutes and
the 35 dBZ CI threshold by roughly 30 minutes.

RadarOmega has **no pixel readout for satellite** (see §7), so you cannot compute
the cooling rate. What you *can* do is step a Band 13 loop and judge whether the coldest
pixel in a growing cell is visibly stepping down through colour bins between
frames. Fast bin-crossing = strong updraft. Say "cooling quickly", not a number
you did not measure.

### Glaciation
A cumulus top that has frozen scatters very differently in the near-IR:

- **Band 05 (1.6 µm, "snow/ice")** — ice-topped cloud goes dark, water-topped
  cloud stays bright. A tower that darkens in Band 5 between frames has glaciated.
- **NATCOLOR ("Day Land Cloud" RGB, the app's name for it)** — high ice cloud,
  snow and sea ice render **cyan**; low water cloud renders dull grey/white.
  Daytime only. This is the app's stand-in for the Day Cloud Phase Distinction
  RGB, which it does not carry.
- Small ice particles on a thunderstorm top indicate an **intense** updraft —
  the parcel went up fast enough that crystals had no time to grow.

Glaciation before the cell is even on radar is a real signal that this is the
tower that survives.

---

## 4. Stage four — the mature storm, from above

These are the signatures worth interrupting someone for. All of them are read on
**Band 13 (10.3 µm clean IR)**, which works at night, with Band 02 visible adding
texture during the day.

### Overshooting top (OT)
A dome of cloud punching through the anvil into the lower stratosphere. Detection
criteria used operationally (Bedka et al. 2010; Adler et al. 1983):

- a pixel or small cluster **≥ 6.5 K colder than the mean brightness temperature
  of the surrounding anvil**,
- cluster diameter **≤ 15 km**,
- IR window Tb around **≤ 215 K** and colder than the tropopause temperature.

Overshoots cool at 7-9 K per km as they rise into the stratosphere, which is why
a 6.5 K anomaly corresponds to roughly 0.7-0.9 km of overshoot. A **persistent**
OT that survives several frames matters far more than a single-frame one; a
storm that keeps an OT for 20+ minutes is producing severe weather somewhere.

### Enhanced-V (and the cold-U / warm-spot pair)
Upper-level flow diverted around a strong overshoot leaves a V or boomerang of
cold cloud opening downwind, with a distinctly **warmer** spot enclosed just
downstream of the apex. Median lead time on the first severe report is about
**30 minutes** (McCann 1983, NOAA Tech. Memo. NWS NSSFC-4). The warm spot is the
diagnostic half — a V without it is often just anvil shape.

### Above-anvil cirrus plume (AACP)
A plume of cirrus streaming downwind *above* the anvil, from a hydraulic jump
over the overshoot. The strongest single satellite severe indicator in the
literature (Bedka et al. 2018, *Wea. Forecasting* 33, 1159):

- AACP storms produced **14×** the severe reports per storm of non-AACP storms,
- AACPs appeared on average **31 minutes before** the severe weather,
- **73%** of significant severe reports (2"+ hail, EF2+, 65+ kt) came from AACP
  storms,
- lead time is comparable to the radar-based warning that eventually gets issued.

Visible imagery shows the plume as a texture/shadow anomaly; IR shows it as a
warm streak lying over the cold anvil. Look downwind of the OT.

### Cold-ring / cold-U
A ring of very cold anvil surrounding a warmer centre. Same physics family as
the enhanced-V, seen when the flow around the overshoot is more symmetric. Treat
as equivalent in severity implication.

### Rapid anvil expansion
Measure the anvil edge across a loop. An anvil spreading fast in all directions
means strong upper divergence, i.e. a strong updraft, even before an OT is
resolvable. Slow or one-sided expansion = weakening or strongly sheared.

### Back-building / upwind flank
New towers repeatedly forming on the same upwind flank means the cell motion and
the propagation vector are opposed. That is the flash-flood signature, and it is
visible on satellite before the radar echo trains.

---

## 5. Stage five — radar structure

By now the storm exists. These confirm and refine; they rarely surprise you if
you did §§1-4.

### Organisation
- **0-6 km bulk shear** governs mode: under 25 kt pulse junk, 25-40 kt clusters
  and bowing lines, 40+ kt supercells. (See `scripts/sounding.py`.)
- **Bounded weak echo region (BWER)** — a reflectivity minimum aloft over a low
  level maximum, the radar's picture of an updraft too strong for hydrometeors
  to fall into. Needs multiple tilts; **RadarOmega cannot show this**, see §7.
- **Hook echo / appendage** on the right-rear flank of a supercell.
- **Rear-inflow notch and bookend vortices** on a bowing segment — the wind
  signature. A notch that deepens is a downburst about to reach the ground.
- **Line echo wave pattern (LEWP)** — the segment bulging where the wind is.

### Hail
- **Three-body scatter spike** — a weak spike of returns extending radially
  *behind* a core, caused by radar energy bouncing core → ground → core. Close to
  unambiguous evidence of large wet hail.
- **ZDR column** — a plume of positive ZDR extending above the environmental
  freezing level, marking supercooled raindrops lofted in the updraft. Column
  growth precedes growth of the −20 °C reflectivity core by about **3.5-9
  minutes** (Kuster et al. 2019, *Wea. Forecasting* 34, 1173); some cases give
  much longer hail lead (Picca et al. report up to ~40 min).
- **MESH / POSH** (MRMS) — hail size estimated from reflectivity **above the
  environmental 0 °C level**, which is why it is a better hail proxy than raw
  dBZ. Available in the app as MESHNOW / MESH1HR / MESH2HR / MESH4HR / MESH24HR
  and POSH.
- Freezing level matters more than CAPE for whether hail survives to the ground;
  a freezing level above ~14,000 ft melts most of it.

### Rotation
- **Mid-level mesocyclone** — a persistent inbound/outbound couplet with
  rotational velocity of at least about **15 m/s (~30 kt)**, in the vicinity of a
  deep updraft.
- **Tornado warning heuristic** — rotational velocity **≥ 40 kt at the lowest
  elevation slice** is the value NWS Midland's case study used as a trigger; it
  produced lead times from 4 to 20+ minutes across their cases. Treat as a
  threshold to *look harder*, not an automatic yes.
- **Aliasing check** — a gate-to-gate delta near twice the Nyquist velocity is
  velocity folding, not rotation. `scan_radar_field` returns `nyquist_ms` so you
  can rule it out; when it comes back null you cannot, and you must say so.
- **Range matters as much as magnitude.** 60 kt of gate-to-gate shear at 25 mi
  is a low-level couplet; the same 60 kt at 100 mi is a mid-level feature 12,000
  ft up and means something entirely different.

### Tornado on the ground
- **Tornado debris signature (TDS)** — the only radar confirmation that debris is
  airborne. Defined as **ρhv < 0.8, ZDR < 0.5 dB, ZH > 45 dBZ, collocated with a
  tornado vortex signature** (Ryzhkov et al. 2005b). All four, together. A low-CC
  blob that is not on top of a couplet is biological scatter or a melting layer,
  not a tornado.

### Wind
- **DCAPE** is the best single severe-wind discriminator: under 600 is nothing,
  1000+ means downbursts.
- **Descending reflectivity core** — a high-reflectivity blob visibly dropping
  through the tilts. Same limitation as BWER: needs multiple elevations.
- **Convergent velocity signature at low levels** ahead of a bow.

---

## 6. Signs that say NO — the ones that save your credibility

Positive signs get all the attention; the suppression signals are what stop you
sending an alarming text on a day that quietly does nothing.

- **Cloud streets that stay shallow all afternoon.** Mixed boundary layer, intact
  cap. Very common bust mode.
- **Repeated orphan anvils with no growth in cell size.** The parcel keeps
  reaching the freezing level and stopping.
- **Surging outflow ahead of the line.** Once the cold pool outruns the updrafts
  the storms are elevated: hail and gusts stay possible, tornado risk collapses.
- **CIN that is not eroding in the newest short-range run.** Check the CIN field
  in the newest HRRR before believing an older run's CAPE.
- **High LCL with big CAPE.** Dry sub-cloud layer means outflow-dominant storms
  and gusts, not tornadoes, regardless of the instability number.
- **The convection is upstream and the band is oriented along the flow.** A band
  parallel to the mean flow *trains along its own axis* — it does not march
  perpendicular at you. Read the orientation before assuming approach.
- **Nothing within radar range and a stable, clean visible field at sunset.**
  Overnight initiation is possible but it needs an elevated source; look for a
  nocturnal low-level jet nose in the model, not for surface CAPE.

Write the negative down in the answer. "The cap is holding and the streets are
staying flat, so I do not think anything fires here" is a real forecast, and it
is the one that earns you the right to be believed on the day you do interrupt.

---

## 7. What RadarOmega can and cannot actually measure

Honesty table. Verified against the live app 2026-09-03.

| Sign | Can the app show it? | How |
|---|---|---|
| Shortwave / WV features | **Yes** | SATELLITE + `BAND09-DATA` (or 08/10), loop it |
| Boundaries, cloud streets, cu field | **Yes, daytime** | SATELLITE + `BAND02-DATA` (0.64 µm, highest res) |
| Glaciation | **Yes, daytime** | `BAND05-DATA` (1.6 µm) or `NATCOLOR-DATA` |
| OT / enhanced-V / AACP / cold-ring | **Yes** | `BAND13-DATA`, 1-min meso sector if pointed at you |
| Cloud-top **cooling rate** in K/15 min | **No** | no satellite pixel sampling exists — judge visually, do not quote a number |
| Total lightning / lightning jump | **Yes** | GOES GLM is in the app — `lightningMapperFlashFrames` gives flash counts per 5-min frame over any box (radaromega-pro §4f). This was assumed impossible until 2026-09-03 |
| BWER, storm-top divergence, DRC, ZDR column *depth* | **No** | the app exposes only the **0.5° base tilt**; there is no elevation control |
| Hail aloft, echo tops, VIL | **Yes, as derived products** | radar `VIL` / `ETP`, MRMS `MESH*`/`POSH`/`VIL-DATA` |
| ZDR / CC / KDP at base tilt | **Yes** | `DRF` (ZDR), `HCC` (CC), `KDP`, `HCA` (hydrometeor class) |
| Exact dBZ / velocity at a point | **Yes** | `sample_radar_values`, `scan_radar_field` (radar mode only) |
| Rotation as a number | **Yes** | `scan_radar_field(mode:'couplet')` on `HVL` |
| Soundings | **Yes, external** | `scripts/sounding.py` (Wyoming BUFR) |
| Storm motion from the warning itself | **Yes** | `get_warning_details` → `raw` contains `TIME...MOT...LOC` |

Two consequences worth internalising:

1. **Satellite in this app is qualitative.** You are pattern-matching shapes and
   loops, not thresholding brightness temperatures. Phrase accordingly.
2. **Lancaster sits in a radar gap** — every WSR-88D is 150-170 km away and the
   lowest beam over the house is 2.5-4 km up. That is exactly the situation where
   the satellite ladder above earns its keep, because satellite resolution does
   not degrade with distance from a tower.

---

## 8. Composing it into an answer

The pattern that works, in order:

1. **Environment** — is the air capable? (sounding / model CAPE-shear-CIN)
2. **Trigger** — is there something to lift it, and where is it now? (WV
   shortwave, surface boundary)
3. **State of the cumulus field** — is the cap breaking? (visible)
4. **First cells** — cooling, glaciating, growing? (Band 13 + 05 loop)
5. **Mode** — what will they become? (shear number)
6. **Confirmation** — OT/AACP on satellite, structure on radar.
7. **Ground truth** — LSRs, METARs, cameras (`scripts/ground_truth.py`).

Then say the one thing the person actually asked, with the time window, and stop.

The failure mode this file exists to prevent is answering a "what's going to
happen" question purely from a radar frame, which can only ever describe the
present, and then being surprised in ninety minutes.

---

## Sources

- Adler, R. F., et al. (1983) — overshooting-top thermal structure, 7-9 K/km.
- Bedka, K., et al. (2010) — IRW-texture OT detection: ≥6.5 K colder than anvil,
  ≤15 km clusters, ~215 K Tb.
- Bedka, K., et al. (2018), *Wea. Forecasting* 33, 1159 — above-anvil cirrus
  plumes: 31 min mean lead, 73% of significant severe, 14× reports per storm.
- McCann, D. W. (1983), NOAA Tech. Memo. NWS NSSFC-4 — enhanced-V, ~30 min
  median lead.
- Mecikalski, J. R., and K. Bedka (2006); Mecikalski et al. (2008), *MWR* 136,
  4899 — CI interest fields; CI defined as first 35 dBZ echo.
- Kuster, C. M., et al. (2019), *Wea. Forecasting* 34, 1173 — ZDR column depth
  leads −20 °C core growth by 3.5-9 min.
- Ryzhkov, A. V., et al. (2005b) — TDS: ρhv < 0.8, ZDR < 0.5 dB, ZH > 45 dBZ with
  a TVS.
- Schultz, C. J., et al. (2009, 2011) — lightning jump: 2σ, ~21 min mean lead,
  POD ~79-81%, FAR ~36-41%. Computable here off the GLM frames (radaromega-pro §4f).
- NWS Midland, "Rotational Velocity Trends in Some Tornadic Supercells" — Vr ≥ 40
  kt at the lowest slice as a warning trigger.
- NOAA/NESDIS ABI quick guides — band assignments and RGB interpretations.
