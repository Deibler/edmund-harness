---
name: radaromega
description: THE weather source — all weather questions route here, from "is it gonna rain" to severe outbreaks. RadarOmega MCP for radar, satellite, model, MRMS and NDFD analysis, the convective-signs ladder that gives real lead time, alert watches, and meteorologist-grade annotated images and loop videos.
---

# radaromega

RadarOmega is **the** weather workflow — not just severe weather. Current
conditions, "will it rain tomorrow", forecasts, radar, models, alerts, tropical,
winter, fire, marine, hydro, power outages: all of it starts here. Supplement
with `api.weather.gov` (via curl, with a User-Agent header) for text forecasts
and alert polling — never any other weather source.

Three companion documents, in the order you reach for them:

- **`reference/signs.md`** — the convective-signs ladder. Read it for any
  "what is going to happen" question. Radar can only describe the present;
  that file is how you get 30-90 minutes of honest lead time.
- **`skills/radaromega-pro`** — tool reliability, execute_js recipes, app
  internals, data routing. Read WITH this skill before any real weather work.
- **`scripts/`** — `sounding.py`, `cells.py`, `ground_truth.py`, `panel.py`,
  `report.py`, `cammap.py`, `radar_query.js`. Documented in radaromega-pro §5c/§6b.

## Reliability — what you can assume

- **Every tool self-heals.** No connect/discover step: each tool auto-attaches
  and even auto-launches the app if it's closed (a cold first call takes ~10-45s
  — send a quick "pulling up radar" first if the user is waiting). Tools never
  hang; they error clearly.
- **Wedged engine auto-recovers.** If the app has been up a long time and the
  model engine corrupts, `set_model` / `set_view_mode` detect it, restart the
  app, and retry by themselves (~15-20s, result carries a `recovered:` note). If
  `set_forecast_hour`/`set_model_product` say the app was restarted, just call
  `set_model` again — NEVER drop into execute_js debugging for engine weirdness.
- "Stuck on a login or update screen" error → tell the user the app needs a
  manual look; don't retry-loop.
- **Don't `sleep` in Bash.** Navigation tools wait for data themselves:
  `change_radar_site` (default 5s settle), `change_radar_product` (3.5s), and
  `capture_view(settle_ms: …)` covers the rest.
- **`get_detailed_state` lies about the mode.** It reports `viewMode: "RADAR"`
  while satellite imagery is genuinely on screen. Trust `get_map_state`, the
  product selector's option list, or your own eyes on a capture.

## Images & video — clean by default

- `capture_view` returns the **clean map** — data, warnings, your drawings, ZERO
  app UI. That's what the user gets. Full-res goes to the sandbox for
  `send_attachment`; by default only the saved path comes back (no inline image).
  Pass `view: true` on captures you need to eyeball yourself — you get a
  downscaled inline copy (don't re-capture to "get a better look" — the saved
  file is sharp). Captures you're only delivering to the user don't need `view`.
- `capture_view(include_ui: true)` ONLY when you need to see the app's interface
  to operate it. Never send include_ui shots to the user.
- `capture_loop(frames?, interval_ms?, format?)` — the animation as a clean mp4
  (plays inline in iMessage) or gif. The single best way to show motion: an
  approaching line, rotation, a model run, **a satellite loop of a building
  cumulus field**. Works in RADAR, MRMS, MODEL and SATELLITE modes.
- `close_panels` — Escape + close-buttons when a settings panel covers the map.

## Don't spam the user

One reply = **the one or two visuals that tell the story**, with your read as the
caption. Run your full analysis pass silently (reflectivity, velocity, dual-pol,
satellite, whatever it takes — `capture_view(view: true)` on frames you are
reading yourself), then send the best frame plus maybe one loop. Eight separate
product screenshots is a slideshow, not an answer. Exception: the user explicitly
asks to see each product.

## Label like a meteorologist — always

Before sending an analysis image, annotate it (`clear_drawings` first, then draw,
then capture):

- Mark **what** and **where**: hail cores, rotation couplets, the user's
  location, outflow boundaries, overshooting tops, threat polygons, motion vectors.
- Use real terminology and translate the so-what: "bow echo", "hook echo",
  "training cells", "TVS", "gust front", "overshooting top", "above-anvil cirrus
  plume" — then "that hook near Lititz is rotation, be on the basement side by 9:40".
- Captions state: what's happening, where it's going, when it arrives, what to do.
- `clear_drawings` and restore the home radar view when done with a remote event.

---

## Tool surface (verified arg names, product codes verified live 2026-09-03)

**Navigate** — `fly_to(lng, lat, zoom?)` (note `lng`), `fit_view(points, …)`
(use this instead of a guessed zoom before any capture), `measure_distance`.

**Modes** — `set_view_mode(RADAR|SATELLITE|MRMS|MODEL)`. The app's master
dropdown also carries `NDFD` and the model names directly, but the tool enum
does not; for NDFD see the recipe below.

### RADAR products — `change_radar_product(product)`

`HRF` reflectivity (also HRF2/3/4 for higher tilts of the *composite* product
set), `HVL` velocity (HVL2/3/4), `HSV` storm-relative velocity, `HSW` spectrum
width, `HCC` correlation coefficient, `DRF` differential reflectivity (ZDR),
`KDP` specific differential phase, `HCA` hydrometeor classification, `DAA` dual-pol
accumulation, `OST` one-hour storm total, `STP` storm total precip, `VIL`,
`ETP` echo tops, `WINTER_EXP`.

There is **no** `CC`, `ZDR`, `SHR`, `BRF`, `BVL` or `DVIL` — those are the codes
you would guess and the app rejects them. It validates against the live selector
and lists the real codes back at you; take the list it gives over this file.

**The elevation is fixed at the 0.5° base tilt.** There is no tilt control, so
BWER, storm-top divergence, descending reflectivity cores and ZDR *column depth*
are not available here. Vertical information comes from the derived products
(`VIL`, `ETP`) and from MRMS.

`change_radar_site(siteCode)` — waits for data itself. Pick the tower with the
**lowest beam** over the point in question, not the nearest by map distance.

### SATELLITE — works, and the old skill said it didn't

`set_view_mode("SATELLITE")`, then drive the product with **`change_radar_product`**
(yes, that tool — it writes the shared product selector, which in satellite mode
holds satellite codes):

- `GEOCOLOR-DATA` — day/night composite, the default look
- `NATCOLOR-DATA` — Day Land Cloud RGB. Ice cloud/snow renders **cyan**, water
  cloud dull grey/white. Daytime only. The app's stand-in for Day Cloud Phase.
- `FIRETEMP-DATA` — fire temperature RGB
- `BAND01-DATA` … `BAND16-DATA` — all sixteen ABI bands

Band → job, the short version (full version in `reference/signs.md`):

| Band | µm | Use it for |
|---|---|---|
| 02 | 0.64 | highest-res visible: boundaries, cloud streets, cumulus field |
| 05 | 1.6 | glaciation — an ice-topped tower goes dark |
| 07 | 3.9 | fog, fire, night low cloud |
| 08/09/10 | 6.2 / 6.9 / 7.3 | water vapour: shortwaves, dry slots, jet streaks |
| 13 | 10.3 | clean IR, day and night: overshooting tops, enhanced-V, AACP, anvil growth |
| 14/15 | 11.2 / 12.3 | split-window pair |
| 16 | 13.3 | CO2, cloud-top height |

**Sector selection has no MCP tool** — set it through the iframe:

```js
(function(){var d=window.frames[0].document;var s=d.getElementById('satellite-selector');
 s.value='33'; s.dispatchEvent(new Event('change',{bubbles:true})); return s.value})()
```

Sector values: `27` GOES-19 CONUS, `28` GOES-18 PACUS, `19`/`20`/`31` full disks,
`33`/`34` GOES-19 Meso 1/2, `35`/`36` GOES-18 Meso 1/2, `40`/`38`/`37` Himawari-9
Japan/Australia/Target, `41` Main Development Region, `32` global mosaic, `23-25`
custom. **Refresh cadence is the whole game: full disk 10 min, CONUS 5 min, meso
sector 1 min.** If a meso sector happens to be pointed at your area, that is a
one-minute loop of an initiating storm and it is the best product in the app.
Meso sectors follow the day's significant weather, so check before assuming.

**GOES GLM total lightning lives in this mode too**, and it works despite what
`get_lightning_data` says. Enable it with
`satellite.setLightningMapperSelection('G19-FLASH')` +
`setLightningMapperEnabled(true)` + `syncLightningMapperForCurrentState()`, then
read `satellite.lightningMapperFlashFrames` — seven frames, 5 minutes apart, each
`{scanAtEpoch, points:[[lon, lat, flashCount, energy], …]}`. Count flashes in a
box across the frames and you have a flash-rate trend, which is the lightning
jump (~21 min mean lead on severe). Recipe and caveats in radaromega-pro §4f.

Frame count: `#satellite-frames-selector` (7 … 250) via the same pattern.
`capture_loop` works here. Two limits to state honestly: the satellite loop's
burned timestamps come out bogus (`2000-01-01`), and `sample_radar_values` /
`scan_radar_field` are **radar-only** — there is no numeric pixel readout for
satellite, so satellite reading is qualitative pattern work, never a quoted
brightness temperature.

### MRMS — national mosaic and derived severe products

`set_view_mode("MRMS")`, products via the same selector: `REF-DATA`,
`WINTER-MRMS-DATA`, `MESHNOW-DATA` / `MESH1HR` / `MESH2HR` / `MESH4HR` /
`MESH24HR-DATA` (hail size swaths), `POSH-DATA`, `ROT2HR-DATA` / `ROT24HR-DATA`
(rotation tracks), `LPROB30MIN-DATA` / `LPROB1HR-DATA`, `VIL-DATA`, and
`QPE1HR` / `6HR` / `24HR` / `48HR` / `72HR-DATA`. Region via `#mrms-selector`
(`1` CONUS, `2` Alaska, `3` Hawaii).

24-hour hail swaths plus 24-hour rotation tracks at zoom ~5.5 is THE
"what happened today" visual.

### MODELS

`set_model(HRRR|NAM3KM|NAM12KM|RAP|GFS|ECMWF|HWRF|HMON)`. Products via
`set_model_product`, verified against the live HRRR selector:

`COMPREF` (simulated radar), `MAXUPDH` (updraft helicity — blank over an area
means no organized severe), `SFCCAPE`, `MUCAPE`, `SCIN`, `MCIN`, `SCP`, `STP`,
`EHI1KM`, `EHI3KM`, `SRH1`, `SRH3`, `BLK1`, `BLK6` (bulk shear), `CAPE03`,
`2MTEMP`, `2MDEWPOINT`, `10MW`, `10MWG` (gusts), `MSLP`, `700T`, `850T`, `500W`,
`700W`, `850W`, `PTYPE`, `TPRECIP`, `TSNOW`, `TFRZR`, `TFRZRA`.

There is no `TOR`, `WIND`, `HAIL` or `TSNOWKUCH` product despite what older notes
said. And **the list shrinks as the model gets coarser**: NAM12KM has no MAXUPDH,
MUCAPE, CAPE03, EHI1KM, SRH1 or BLK1; GFS (which defaults to the GLOBAL region)
is down to 17 products. Updraft helicity and the 0-1 km ingredients exist **only
on the convection-allowing models** — asking GFS for MAXUPDH is not a typo, the
field is not there. Read the selector rather than trusting this table.

**Forecast time**: `set_forecast_hour(step)` returns the **valid time** of the
frame — always read it, never do step→hour arithmetic. If it clamps with a
`sliderRange`, the run only has that many frames.

**The freshest run is usually the worst one to load.** A run that just started
publishing has one or two steps. Step back one cycle through the run selector:

```js
(function(){var d=window.frames[0].document;var s=d.getElementById('models-date-hour-selector');
 s.value='2026-09-02|18'; s.dispatchEvent(new Event('change',{bubbles:true})); return s.value})()
```

Options are `YYYY-MM-DD|HH`, newest first. Then re-run `set_model` / preload.

### NDFD — the official NWS gridded forecast

Not in the `set_view_mode` enum. Set the master dropdown directly:

```js
(function(){var d=window.frames[0].document;var s=d.getElementById('mode-selector');
 s.value='NDFD'; s.dispatchEvent(new Event('change',{bubbles:true})); return s.value})()
```

Products: `temp`, `apt` (feels like), `td`, `rhm`, `wspd`, `wgust`, `sky`,
`pop12`, `qpf` (6-hourly), `snow` (6-hourly). This is the human forecaster's
grid, not a raw model — the right visual for "what's the actual forecast" as
opposed to "what does one model think".

### Data tools

`generate_weather_report` (everything in one call — prefer it over five separate
`get_*` calls), `get_map_state`, `get_model_state`, `get_radar_info` (check
timestamps — don't analyse stale frames), `get_warnings(filter?)`,
`get_warning_details(warning_id)`, `get_outlooks(lat, lon, day, include_text)`,
`get_mesoscale_discussions`, `get_storm_reports`, `get_metar_data`,
`get_nhc_data`, `get_lightning_data`, `sample_radar_values(points)`,
`scan_radar_field(lat, lon, …)`.

`get_warnings` returns a **national census by type** plus, per warning, the NWS
impact-based tags: `tornado` (POSSIBLE / RADAR INDICATED / OBSERVED), `hail`,
`wind`, `damage_threat` (CONSIDERABLE / DESTRUCTIVE / CATASTROPHIC) and
`emergency`. `get_warning_details` adds the polygon **and the full raw bulletin**,
which carries `TIME...MOT...LOC` — the storm's own position, heading and speed
straight from the issuing office. That is a better motion vector than anything
you will derive by eye. Note the `filter` argument matches the type code (`SV`,
`TO`, `FF`), not the word "Tornado".

### Overlays, features, drawing, animation

`toggle_overlay(overlay, enabled)` — warnings | stormReports | metars |
surfaceFronts | lightningDetection | stormNet | stormTracks. Some (warnings)
render by default and return a soft "no toggle" error — verify visually.

`show_feature(feature)` — severe_weather_outlooks, mesoscale_discussions,
tropical_weather_outlooks, hydrological_outlooks, fire_weather,
winter_weather_outlooks, climatological_outlooks, marine_tools, power_outages,
`satellite_settings`, `mrms_settings`, `model_settings`. (The satellite enum
value is `satellite_settings`, not `satellite`.)

`clear_drawings`, `draw_marker(lng, lat, …)`, `draw_line`, `draw_polygon` —
coordinates are `[lng, lat]` pairs. `control_animation(action)`.

Escape hatches, last resort: `execute_js` (the param is `expression`, and **app
content lives in an iframe — go through `window.frames[0].document`**),
`introspect_app`. `get_page_text` returns empty; don't bother.

---

## The shape of a good run

**"Is it raining / what's on radar"** — `fly_to` + `change_radar_site`, `HRF`,
`sample_radar_values` at the places that matter, one `capture_loop`. Thirty
seconds of work, one image, one sentence.

**"What's going to happen / could we get storms"** — this is a
`reference/signs.md` question, not a radar question. Environment first
(`scripts/sounding.py`, model CAPE/CIN/shear), then trigger (WV shortwave,
surface boundary), then the state of the cumulus field on visible, then radar
last. Say the negative out loud when the negative is the answer.

**Severe threat day X** — SPC category first (`get_outlooks`, it is the official
call), NWS timing, then hi-res model COMPREF for placement and MAXUPDH for
organized rotation.

**Active warning near them** — life-safety line FIRST. Then fly to it, HRF plus
`HVL`, `get_warning_details` for the tags and the motion vector, annotate, one image.

**"How bad was it / what happened today"** — MRMS 24hr MESH plus 24hr rotation
tracks, plus `get_storm_reports`.

**A storm going up right now** — the highest-value thing this app does and the
one most often skipped: SATELLITE, `BAND13-DATA`, meso sector if available,
`capture_loop`. An overshooting top or an above-anvil cirrus plume is worth
roughly 30 minutes of lead over the radar signature.

Always: `clear_drawings` before a fresh capture, `fit_view` rather than a guessed
zoom, and restore the home view (RADAR, KCCX/HRF, `fly_to(-77, 40.8, 7)`) when
done with a remote event.

## Alert watches — `set_trigger`, not missions

"Tell me if/when X happens" is a **data trigger**: YOU author the condition — a
probe (any URL, or a JS expression inside the live app) plus a predicate with
persistent `state` — and the daemon evaluates it for free on your schedule.
You're invoked ONLY when it fires, data in hand. Shapes, not a menu:

- *Tornado warning touches Lancaster County*: `api.weather.gov/alerts/active?area=PA`,
  predicate filters event + areaDesc, dedupes ids in `state`.
- *A tropical storm forms anywhere*: `nhc.noaa.gov/CurrentStorms.json`, predicate
  tracks per-storm classification in `state`.
- *Next model run shows updraft helicity over us*: app_js probe reading the model
  engine, predicate thresholds it.
- *SPC upgrades us to Enhanced*: day1/day2 `_cat.nolyr.geojson`, point-in-polygon
  against `state.last`.

Rules: predicates MUST dedupe via `state`; set `expires` when the threat window
closes; the `brief` is your promise to future-you. Creation runs one real check,
so a broken probe fails immediately rather than silently at 3am. On fire:
RadarOmega on the area, annotate, ONE message — alert type, location, timing,
action first.

**A trigger does not know what you already told them today.** If you delivered a
morning brief that already covered this threat, the bar for firing a second
message is much higher: the test is what they would *do* differently. Rain
arriving early on a work-from-home day is not actionable, and spending a bubble
on it spends the credibility you need for the warning message.

`start_mission` remains for watches where each check itself needs judgment.

## Output rules

- Cross-check before concluding: radar + satellite + warnings + reports + obs.
  Never imply a dataset was checked unless you queried or displayed it.
- The annotated visual is the answer; text stays short and concrete.
- Distinguish what you **measured** from what you **inferred**. Satellite here is
  qualitative; a beam 3 km up is not the ground; a 12Z sounding is stale by evening.
- Don't claim certainty beyond the data; say when confidence is limited, and say
  when the honest answer is "nothing is going to happen".
- Life-safety first: alert type, location, timing, action — before any meteorology.
