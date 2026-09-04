---
name: radaromega-pro
description: GLOBAL RadarOmega playbook — read WITH the base radaromega skill before any weather work in any chat. Verified tool-reliability table, the full satellite/NDFD/MRMS/model product inventories, execute_js recipes for everything the tools can't reach (sector, model run, mode, fronts), data-source routing, and a meteorologist's guide to which visual answers which question.
---

# radaromega-pro

Read `skills/radaromega/reference/signs.md` alongside this whenever the question is *what is about to happen* rather than what is happening — this file is how to drive the app, that one is what to look for and how much lead time each sign is worth.

The field-tested companion to the base `radaromega` skill. That one has philosophy and output rules; this one is ground truth: which tools actually work, the exact JS recipes that replace the broken ones, where each kind of data really lives, and what a professional meteorologist would show for each question type. Verified live 2026-06-10 across radar, model, fronts, warnings, tropical, MRMS, and data tools; satellite re-audited and product/mode inventories re-derived 2026-09-03. Trust this over the base skill where they disagree.

## 1. Tool reliability table (reconciled by the operator 2026-06-10 ~05:20)

The tools this skill originally flagged broken were REBUILT from these very recipes and verified live — **use the tools first**; they run the §3-§5 protocols internally. The recipes below remain the fallback if a tool ever contradicts the screen.

| Tool | Status |
|---|---|
| `set_model` | FIXED — loads newest run + ALL frames, returns run id + stepRange (§3 protocol inside) |
| `set_forecast_hour` | FIXED — engine stepChanged, snaps to available step, returns validTime |
| `set_model_product` | FIXED — selector-first ordering, reload, holds step |
| `change_radar_site` | FIXED — activateTowerByCode + waits for data |
| `capture_loop(advance:'hours')` | model run as video, steps real step values |
| `capture_loop(advance:'playback')` | FIXED 2026-08-10 — loads history and steps real sweeps; errors instead of shipping a frozen clip (§6) |
| `sample_radar_values(points)` | NEW 2026-08-10 — exact dBZ/m·s at lat/lons, with beam height (§5a-bis) |
| `scan_radar_field(...)` | NEW 2026-08-10 — ranked cores, or gate-to-gate velocity couplets (§5a-bis) |
| `get_outlooks(lat, lon, day, include_text)` | NEW 2026-08-10 — SPC outlooks from the app's own layer, point-tested (§5a-ter) |
| `get_mesoscale_discussions(lat, lon)` | NEW 2026-08-10 — MCDs with prob_of_watch (§5a-ter) |
| `fit_view(points, padding_px, max_zoom)` | NEW 2026-08-10 — solves the zoom so the storm fills the frame. Use instead of a guessed `fly_to` zoom before ANY capture (§6a) |
| `change_radar_product` | FIXED 2026-08-10 — validates against the LIVE selector and lists real codes; codes are HCC/DRF/HSV/HSW, and there is no DVIL (§6b) |
| `scan_radar_field(mode:'couplet')` | now REFUSES on a non-velocity sweep instead of calling reflectivity edges "rotation" (§5a-bis) |
| `get_warnings(filter?)` / `get_warning_details(warning_id)` | FIXED — read the §5b in-app cache directly (census, tornado/hail/wind tags, damage threat, emergency flag, raw bulletin) |
| `get_nhc_data` | FIXED — reads nhc.activeTropicalData (§4b); rendering cone/track still via §4b recipe |
| `get_storm_reports(day?)` | FIXED — fetches SPC reports CSV itself |
| `get_metar_data(ids?)` | FIXED — fetches aviationweather.gov (ids or current-view bbox) |
| `get_lightning_data` | router — but it is WRONG that no feed exists: GOES **GLM total lightning is in the app** and readable as numbers (§4f) |
| `measure_distance` | FIXED — haversine, no turf needed |
| `toggle_overlay('surfaceFronts')` | still no toggle — fronts recipe (§4) |
| `get_radar_info` | still nulls sometimes — `get_map_state` / `get_model_state` |
| SATELLITE view | **WORKS** (re-audited 2026-09-03) — all 16 ABI bands, GeoColor/Day-Land-Cloud/Fire RGBs, meso sectors, loops. The old "no imagery" row was wrong; see §4c |
| `show_feature('severe_weather_outlooks')` | polygons unreliable for DISPLAY — but the data is there; read it with `get_outlooks` (§5a-ter) |

**Also trustworthy:** `execute_js`, `capture_view`, `capture_loop`, `fly_to`, `set_view_mode` (RADAR/MODEL/MRMS/**SATELLITE**), `change_radar_product` (drives radar AND satellite products), `get_model_state`, `get_map_state`, `control_animation`, drawing tools (coords are [lng,lat]), `close_panels`.

**Two that mislead rather than fail:** `get_page_text` returns empty — don't reach for it. `get_detailed_state` reports `viewMode: "RADAR"` while satellite is genuinely displayed.

**execute_js must go through the iframe.** App content lives in `window.frames[0].document`; a top-level `document.getElementById` returns null and reads exactly like "the app doesn't have that". `window[0] || window` is the same thing for the globals.

**Standing watches:** "tell me when X happens" → `set_trigger` (you author a URL or in-app JS probe + a predicate; the daemon checks for free and wakes you ONLY on fire, with the data). Missions wake you every check — use them only when each check needs judgment.

If radaromega tools start failing schema validation mid-session, the MCP server reconnected — reload via `ToolSearch "select:mcp__radaromega__execute_js,..."` and retry once.

**execute_js gotchas:** the param is `expression`, not `code`. And awaiting a slow app callback inside an async IIFE can die with CDP "Promise was collected". For long loads use the window-flag pattern: kick off `mod.loadX(() => { window.__flag = true })` in one call, then poll `window.__flag` / frame counts in a second call.

## 1b. Wedged engine — the TOOLS now self-heal (hardened by the operator 2026-06-10)

After long app uptime the model engine corrupts (callbacks never fire, view switches silently no-op, `precomputedStepData` goes null). You no longer fix this yourself: `set_model` and `set_view_mode` DETECT the wedge, restart the app, and retry automatically — a recovered call returns a `recovered:` note and takes ~15-20s instead of ~3s. `set_view_mode` also returns `verified: true` only when a readback proves the app really switched (preferences and the dropdown both lie when wedged; the PRODUCT_SELECTOR option list is ground truth — *-DATA = model/mrms, HRF/HVL/... = radar).

If `set_forecast_hour` or `set_model_product` report "engine was wedged — RESTARTED automatically", the loaded run is gone: call `set_model` again, then retry. Do NOT drop into execute_js debugging for any of these symptoms — one more `set_model` call is always the answer.

Related: `w.MODE_SELECTOR` is the master mode dropdown (options: 0/RADAR/MRMS/HRRR/NAM3KM/NAM12KM/RAP/GFS/ECMWF/HWRF/HMON/SATELLITE/NDFD — models ARE modes). Manual fallback for a stuck mode switch: `w.MODE_SELECTOR.val('HRRR').trigger('change')`. `capture_loop(advance:'hours')` reads the run loaded by `set_model` (it now also sees runs loaded by hand via activeSteps, but tool-loaded runs are the reliable path).

## 2. App internals map (what execute_js drives)

- Master object: `window.__claude_map` — a Mapbox map extended with mode controllers: `.radar`, `.satellite`, `.mrms`, `.model`, plus `.mode` (current view).
- **Decoded radar values** live at `.radar.radarRenderer.sweep` (§5a) and the tower's lat/lon at `.radar.radarRenderer.tower`.
- **Subsystems with no MCP tool** (classes on `w`, instances usually hanging off the map): `NexradAttributeTracks` (§5b-2), `LightningDetectionMapbox` / `RapidStrikeMapbox` / `LightningFlashDensityRendererMapbox` (strike feeds — `determineApiUrl` / `getApiUrlForRadar` give the endpoints), `SevereWeatherOutlooksMapbox` + `fetchGeoJSONOutlook`, `MesoscaleDiscussionsMapbox` (the `mesoscale-discussions` map source already carries the SPC MD `full_text`), `StormReportsMapbox`, `StormNetMapbox` (spotters), `HydrologicalOutlooksMapbox`, `WinterWeatherOutlooksMapbox`, `PeakStormSurgeMapbox`. When something seems missing, enumerate `Object.keys(w)` against a regex before concluding the app does not have it.
- App globals live in the iframe: `const w = window[0] || window` → `w.MODELS_REGION_SELECTOR` ('2'=CONUS, '12'=GLOBAL), `w.MODELS_DATE_HOUR_SELECTOR` (options "YYYY-MM-DD|HH", FIRST = latest run), `w.PRODUCT_SELECTOR` (shared across RADAR, MODEL and MRMS modes — its option list tells you which mode the app is REALLY in: HRF/HVL/... = radar, *-DATA = model/mrms), `w.STEP_SELECTOR`, `w.MODELS_DATE_SELECTOR` + `w.MODELS_HOUR_SELECTOR` (the pair the engine actually reads in computeModelStepData), `w.MODELS_VALID_TIMESTAMP`, `w.MODE_SELECTOR` (§1b), `w.surfaceFronts`, `w.nhc`, `w.hurricaneHunter`, `w.spaghettiModels`, `w.nexradHistory`, `w.RADAR_TOWER_CODE`.
- Radar controller useful methods: `activateTowerByCode(code, product, bool)` (NOTE: activATE, not active — it's on `.radar`, not the map), `activateClosestTower()`, `getActiveTower()`, `getActiveProduct()`, `productChanged`, `stepChanged`.
- `model.activeSteps` is an Object keyed by step number, NOT an array — `Object.keys(md.activeSteps)`; `.slice()` throws.
- Model engine call chain (for debugging): `runModel(cb)` fetches run metadata into `previousModelData` and REPOPULATES the product/date/hour selectors (wiping your selections — re-set them after); `hourSelected()` → `computeModelStepData(cb)` reads MODELS_DATE_SELECTOR/MODELS_HOUR_SELECTOR/PRODUCT_SELECTOR, and **silently returns without calling cb** if `getModelStepData(product)` is null; `loadScans` fetches the S3 frame JSONs (sdsweather-public.s3.amazonaws.com/images/models/...) and clears+refills `activeSteps`.

## 3. Model view recipes (the big one)

Enter with `set_view_mode('MODEL')` (works). Then everything below in `execute_js`.

**Switch model + load latest run + render frame N:**
```js
(async () => {
  const w = window[0] || window;
  const md = window.__claude_map.model;
  md.activeModel = 'HRRR';              // HRRR | NAM3KM | NAM12KM | RAP | GFS | ECMWF
  w.MODELS_REGION_SELECTOR.val('2');
  await new Promise(res => md.runModel(res));
  const dh = w.MODELS_DATE_HOUR_SELECTOR;
  dh.val(dh.find('option').first().val());      // latest run
  md.sweepsLoaded = false;
  md.hourChanged();
  await new Promise(res => md.preloadData(res)); // REQUIRED or map renders blank
  md.stepChanged(14);
  return JSON.stringify({model: md.activeModel, run: dh.val(), steps: Object.keys(md.activeSteps).length});
})()
```
Verify with `get_model_state` and READ THE RETURNED validTime — never do step→hour arithmetic. Then `capture_view(settle_ms: 2000)`. If callbacks never fire or activeSteps won't update: §1b, restart.

**Switch product** (selector FIRST or preloadData reverts to COMPREF):
```js
(async () => {
  const w = window[0] || window;
  const md = window.__claude_map.model;
  w.PRODUCT_SELECTOR.val('MAXUPDH-DATA');
  md.productChanged('MAXUPDH-DATA');
  md.sweepsLoaded = false;
  await new Promise(res => md.preloadData(res));
  md.stepChanged(14);
})()
```
Products end in `-DATA`. Re-enumerated from the live HRRR selector 2026-09-03:
COMPREF (sim radar), MAXUPDH (updraft helicity = rotation; blank over an area = no organized severe),
SFCCAPE, MUCAPE, CAPE03, SCIN, MCIN, SCP, STP, EHI1KM, EHI3KM, SRH1, SRH3, BLK1, BLK6 (bulk shear),
2MTEMP, 2MDEWPOINT, 10MW, 10MWG (gusts), MSLP, 700T, 850T, 500W, 700W, 850W,
PTYPE, TPRECIP, TSNOW, TFRZR, TFRZRA.
**There is no TOR, WIND, HAIL or TSNOWKUCH** — those were in this file for months and the app rejects them.

**The product list shrinks as the model gets coarser, and that decides which model you must be on.**
Enumerated live 2026-09-03: HRRR carries the full severe suite; NAM12KM drops MAXUPDH, MUCAPE, CAPE03,
EHI1KM, SRH1 and BLK1 (24 products); GFS in GLOBAL region is down to 17 and also loses STP, SRH3, SCIN,
MCIN and BLK6. So **updraft helicity and the 0-1 km ingredients only exist on the convection-allowing
models** — asking GFS for MAXUPDH is not a code error, the field is not there. Note GFS defaults to the
GLOBAL region (`w.MODELS_REGION_SELECTOR`, '2'=CONUS / '12'=GLOBAL); switch to CONUS before concluding
a product is missing. Read the selector when a code is refused rather than trusting any table, including
this one.

**Model run as VIDEO** (the money deliverable for "what do the models show"): after preload, `capture_loop(advance:'hours', frames:N, start_step:1, step_stride:S, format:'mp4', interval_ms:700)` — returns the mp4 path + final valid time. NAM3KM: 60 hourly steps → frames:30, stride:2 covers 2.5 days. HRRR synoptic runs (00/06/12/18Z) go 48h, off-cycle only 18h. GFS 3-hourly to 150+.

## 3b. MRMS view (national multi-radar mosaic + derived severe products)

`set_view_mode('MRMS')` works. Products via `w.PRODUCT_SELECTOR`: REF-DATA, WINTER-MRMS-DATA, MESH24HR/4HR/2HR/1HR/MESHNOW-DATA (hail swaths), ROT24HR/ROT2HR-DATA (rotation tracks), LPROB1HR/LPROB30MIN-DATA (lightning probability), POSH-DATA (prob of severe hail), VIL-DATA, QPE72/48/24/6/1HR-DATA (rainfall accumulation).

```js
// call 1 — kick off (do NOT await; see Promise-collected gotcha)
const w = window[0] || window; const mrms = window.__claude_map.mrms;
w.PRODUCT_SELECTOR.val('MESH24HR-DATA'); mrms.productChanged('MESH24HR-DATA');
mrms.loadCurrentMrmsAndProduct(() => { window.__mrmsReady = true; });
// call 2 — poll mrms.getNumOfFrames() (typically 14), then mrms.stepChanged(frames-1) for latest
```
24hr hail swaths + 24hr rotation tracks at zoom ~5.5 are THE outbreak-review visuals — every hail path and mesocyclone track from the past day, alongside live warning polygons.

## 4. Surface analysis: fronts + highs/lows

`toggle_overlay` can't drive it. Do this:
```js
(async () => {
  const w = window[0] || window;
  const sf = w.surfaceFronts;
  sf.toggleOn(true);
  try { await sf.fetchLatestSurfaceFrontAnalysis(); } catch(e) {}
  sf.renderLatestSurfaceFrontAnalysis();
  return !!sf.lastFrontsData;
})()
```
Renders the full WPC-style analysis: blue H / red L centers, cold fronts blue, warm red, occluded purple, stationary alternating, troughs dashed orange. Best at CONUS zoom (`fly_to(-96, 38.5, zoom 3.6)`).
Cleanup: `sf.removeLatestSurfaceFrontAnalysis(); sf.toggleOn(false)`.

**Decluttering a synoptic shot** (tower badges bury the fronts): hide layers matching /tower|marker/i via `map.setLayoutProperty(l.id,'visibility','none')` over `map.getStyle().layers`, capture, then restore to 'visible'. Spotter-network icons are separate DOM markers (`w.document.querySelectorAll('.mapboxgl-marker')`).

## 4b. Tropical suite (cone, track, wind field, advisories)

`w.nhc.activeTropicalData` is a GeoJSON FeatureCollection with EVERYTHING per active storm: storm_name, storm_id, basin, current position/winds/pressure, movement, coordinate_history, full forecast array (time/position/winds/status/wind radii), breakpoint watches/warnings, intensity history, and three full text products (`full_text` forecast/advisory, `tcp_text` public advisory, `tcd_text` forecaster discussion). Read it directly for the facts.

To RENDER on the map: `stormToggles[stormId]` must be an OBJECT of flags, not a boolean:
```js
(async () => {
  const w = window[0] || window; const nhc = w.nhc;
  const flags = { cone:true, track:true, wind:true, forecastwind:true, advisorypoints:true, besttrack:false, windSwath:false };
  for (const id of Object.keys(nhc.userSaveState.stormToggles)) nhc.userSaveState.stormToggles[id] = Object.assign({}, flags);
  await nhc._processAndRenderData();   // populates sds-nhc-* layer sources
})()
```
Then `fly_to` the storm and `capture_view`. Draws the forecast cone, track line, storm icons at forecast points, and wind-field polygons. Cleanup: `nhc._clearAllLayers()`.
Also: `await w.hurricaneHunter.fetchMissions()` → live recon aircraft missions ({success, missions:[]} when none flying). `w.spaghettiModels.turnOn()` renders ensemble tracks into sds-spaghetti-* layers when guidance exists (weak/dissipating storms often have none).

## 4c. Satellite — the mode this file used to call dead (re-audited 2026-09-03)

The old reliability row said satellite imagery never renders. It was wrong, and
believing it cost every "what's about to happen" question its lead time. Satellite
works, it is the only instrument that sees a storm before radar does, and it does
not degrade with distance from a tower — which matters enormously in the Lancaster
radar gap (§6d).

**Enter and pick a product:**

```
set_view_mode("SATELLITE")
change_radar_product("BAND13-DATA")
```

Yes, `change_radar_product` — the product selector is shared across modes, so in
SATELLITE mode it holds satellite codes. `get_detailed_state` will still report
`viewMode: "RADAR"` while satellite is genuinely on screen; it lies, ignore it
and read the selector option list or a capture.

**Products (19, enumerated live):** `GEOCOLOR-DATA` (day/night composite),
`NATCOLOR-DATA` (Day Land Cloud RGB — ice cloud and snow render **cyan**, water
cloud dull grey/white; daytime only; this is the app's stand-in for Day Cloud
Phase Distinction, which it does not carry), `FIRETEMP-DATA`, and
`BAND01-DATA` … `BAND16-DATA` for all sixteen ABI bands.

| Band | µm | Reach for it when |
|---|---|---|
| 01 | 0.47 | aerosol, haze, smoke |
| 02 | 0.64 | **highest-resolution visible (0.5 km)** — boundaries, cloud streets, the cumulus field |
| 03 | 0.86 | vegetation / land-water |
| 04 | 1.37 | thin cirrus, anvil and plume edges |
| 05 | 1.6 | **glaciation** — an ice-topped tower darkens |
| 06 | 2.2 | cloud particle size (small particles aloft = intense updraft) |
| 07 | 3.9 | fog, fire, night low cloud |
| 08 / 09 / 10 | 6.2 / 6.9 / 7.3 | **water vapour** — shortwaves, dry slots, jet streaks. 09 is the workhorse |
| 11 | 8.4 | cloud-top phase |
| 12 | 9.6 | ozone |
| 13 | 10.3 | **clean IR, day and night** — overshooting tops, enhanced-V, AACP, anvil growth |
| 14 / 15 | 11.2 / 12.3 | split-window pair |
| 16 | 13.3 | CO2, cloud-top height |

**Sector — no MCP tool, drive `#satellite-selector` through the iframe.** App
content is inside an iframe, so every DOM query must go through
`window.frames[0].document` or it silently returns nothing:

```js
(function(){var d=window.frames[0].document;var s=d.getElementById('satellite-selector');
 s.value='33'; s.dispatchEvent(new Event('change',{bubbles:true})); return s.value})()
```

`27` GOES-19 CONUS · `28` GOES-18 PACUS · `19`/`20`/`31` full disks (G19/G18/H9) ·
`33`/`34` GOES-19 Meso 1/2 · `35`/`36` GOES-18 Meso 1/2 · `37` Himawari target ·
`40` Himawari Japan · `38` Himawari Australia · `41` Main Development Region ·
`32` global G18+G19+H9 mosaic · `23`/`24`/`25` custom.

**Cadence is the whole game: full disk 10 min, CONUS 5 min, meso sector 1 min.**
A meso sector pointed at your area is a one-minute loop of a storm going up and
is the single best product in the app. Meso sectors follow the day's significant
weather, so check where they are before planning around them.

Frame count via `#satellite-frames-selector` (7 … 250), same iframe pattern.
`capture_loop` works in this mode.

**Two honest limits.** The burned timestamps on a satellite loop come out bogus
(`2000-01-01`) — do not present them as scan times. And `sample_radar_values` /
`scan_radar_field` are radar-only; in SATELLITE mode they error with "No decoded
radar sweep in memory". **There is no numeric pixel readout for satellite**, so
you cannot compute a cloud-top cooling rate or a brightness temperature here.
Satellite reading in this app is qualitative pattern work — say "cooling fast
between frames", never "−6 K in 15 minutes", which you did not measure.

What to actually look for, with the lead times each sign buys, is in
`skills/radaromega/reference/signs.md`. Short version: water vapour for the
shortwave, Band 02 for boundaries and the cumulus field, Band 05 for glaciation,
Band 13 for overshooting tops and above-anvil cirrus plumes.

## 4d. NDFD — the official forecaster grid

Not in the `set_view_mode` enum. Set the master dropdown directly:

```js
(function(){var d=window.frames[0].document;var s=d.getElementById('mode-selector');
 s.value='NDFD'; s.dispatchEvent(new Event('change',{bubbles:true})); return s.value})()
```

Products: `temp`, `apt` (feels like), `td`, `rhm`, `wspd`, `wgust`, `sky`,
`pop12`, `qpf` (6-hourly), `snow` (6-hourly). This is the human forecaster's
gridded product, not raw model output — the right visual for "what IS the
forecast" as opposed to "what does one model run think". Full `#mode-selector`
option list: `RADAR, MRMS, HRRR, NAM3KM, NAM12KM, RAP, GFS, ECMWF, HWRF, HMON,
SATELLITE, NDFD`.

## 4e. Storm-track calculator — undocumented, and it answers the ETA question

`show_feature` opens a `#storm-track-settings-modal` carrying four selects that
no tool exposes: `#map-mode` (Cellular Storm Path / Linear Storm Path / Custom
Draw Path), `#calc-mode` (Storm Speed / Endpoint Time), `#eta-format` (Total
Minutes / My Local Time / City's Local Time) and `#display-mode` (Standard /
5 Min Shade / 10 Min Shade). The shaded modes draw time-to-arrival bands across
the map, which is a far better "when does it get here" visual than a drawn arrow.
Set them with the same iframe pattern. Cross-check the answer against the
warning's own `TIME...MOT...LOC` (§5b) and against `cells.py` (§5b-2).

## 4f. GLM total lightning — the feed both skills said did not exist

Found 2026-09-03. `get_lightning_data` used to route you to the MRMS lightning-
probability visual on the grounds that no real strike feed was reachable. That
was wrong. The satellite controller carries the **GOES Geostationary Lightning
Mapper** — total lightning, in-cloud included, which is the field a lightning
jump is computed from.

```js
// enable and select (SATELLITE mode)
(function(){var s=window.__claude_map.satellite;
 s.setLightningMapperSelection('G19-FLASH');   // G19-FLASH | G19-GROUP | G18-FLASH | G18-GROUP
 s.setLightningMapperEnabled(true);
 s.syncLightningMapperForCurrentState();
 return JSON.stringify(s.getLightningMapperState())})()
```

`*-FLASH` is flash density (`GLM-FLASH-2MIN`), `*-GROUP` is energy density
(`GLM-GROUP-2MIN`). Both are 2-minute accumulations published on the satellite
frame cadence.

**Read it as numbers, not as a picture.** The rendered map source often stays
empty until the satellite frame steps, but the decoded frames are sitting right
there and are far more useful:

```js
(function(){var F=window.__claude_map.satellite.lightningMapperFlashFrames;
 var lat0=42.3, lon0=-79.2, box=1.5;
 return JSON.stringify(F.map(function(f){var n=0,fl=0;
   (f.points||[]).forEach(function(p){
     if(Math.abs(p[1]-lat0)<box && Math.abs(p[0]-lon0)<box){n++; fl+=p[2]||0}});
   return {e:f.scanAtEpoch, inbox:n, flashes:fl}})))})()
```

Each frame is `{scanAtEpoch, points:[[lon, lat, flashCount, normalizedEnergy], …]}`.
Typically 7 frames are held, spaced **300 s** apart. That is a real flash-rate
time series over any box you choose, which means the **lightning jump** (a 2-sigma
surge in total flash rate, ~21 min mean lead on severe, POD ~79-81%) is
computable here — the one convective sign this app was assumed to be blind to.

Verified live 2026-09-03 over a warned cell in western NY: 40, 34, 43, 46, 54,
46, 53 flashes per frame in a 1.5° box, i.e. a slowly intensifying storm. Two
caveats. `scanAtEpoch` is **not** a unix timestamp; the base appears to be
2022-01-01T00:00:00Z (add 1 640 995 200 and the newest frame lands ~6 min behind
wall clock, right for the product latency) — verify before quoting an absolute
time, though the 300 s spacing is reliable regardless. And `getLightningMapperS3Url()`
returns a malformed URL when called bare (`…/satellitesundefined`); it needs the
frame context, so read `lightningMapperFlashFrames` rather than fetching yourself.

Also present and separate: `w.lightningDetection` / RapidStrike (cloud-to-ground
network, `sds-rapidstrike-*` layers) — still unproven, every `strike_interval`
flag is false. GLM is the one that works.

## 5. Data routing — where each fact actually lives

The app's data TOOLS are display-layer only; the data itself is reachable. Priority order: in-app caches (§4b tropical, §5b warnings) → source APIs (curl, always with a User-Agent header):
- **Active alerts/warnings**: in-app cache first (§5b). API fallback: `https://api.weather.gov/alerts/active?point=<lat>,<lng>` or `?area=XX` (curl; web_fetch chokes on geo+json).
- **Forecasts**: `https://api.weather.gov/points/<lat>,<lng>` → gridpoint → `/forecast` and `/forecast/hourly`.
- **SPC risk categories**: `https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson` (variants `_torn`/`_wind`/`_hail`; `day2otlk_cat`, `day3otlk_cat`). Features carry `LABEL` (MRGL/SLGT/ENH/MDT/HIGH); point-in-polygon in python (ray-casting, ~10 lines).
- **Storm reports**: `https://www.spc.noaa.gov/climo/reports/today.csv` (also yesterday.csv).
- **METARs**: `https://aviationweather.gov/api/data/metar?ids=KLNS&format=json`.
- **Tropical**: `w.nhc.activeTropicalData` (§4b), or nhc.noaa.gov CurrentStorms.json.
- **The atmosphere itself (soundings)**: `skills/radaromega/scripts/sounding.py` — §5c.
The APP is for visuals; caches+APIs are for facts. Use both, cite neither as the other.

## 5a. Numbers off the radar, not colours (the sweep reader)

The renderer holds the CURRENT sweep fully decoded in memory:
`__claude_map.radar.radarRenderer.sweep.values` is a Float32Array of real
physical values — dBZ for HRF/BRF, m/s for HVL/BVL — laid out **radial-major**,
`values[radialIndex * gate_depth + gateIndex]`, with `total_radial_gates` (720)
azimuths and `meters_between_gates` / `meters_to_first_gate` giving the range.
So "how strong is it exactly" is arithmetic, not eyeballing a colour ramp.

Paste `skills/radaromega/scripts/radar_query.js` as a single `execute_js`
expression once per app session. After that every query is a one-liner and comes
back as a few dozen bytes instead of a screenshot:

```
__rq.info()                              // tower, product, unit, scan time, elevation
__rq.at(LAT, LON)                        // exact value overhead + beam height there
__rq.max(LAT, LON, 20)                   // strongest value within 20 mi, and where
__rq.couplet(40.15, -76.6, 25)           // velocity only: peak gate-to-gate shear, in kt
```

Three things that will bite you:

- **Two missing-data sentinels.** `-128` is "no echo"; a sweep still streaming in
  is padded with `-1e8`. Range-check against `sweep.value.min/max` instead of
  matching sentinels — a padded gate read as real invents a 194,000 kt couplet.
  (`radar_query.js` already does this. Any hand-rolled loop must too.)
- **Read the beam height before you believe a null.** `__rq.at()` returns `beam_kft`.
  At 100 mi the 0.5° beam is ~12,000 ft up, so "no echo over the house" can mean
  "nothing at 12,000 ft over the house". Switch to a closer tower (TDWR `T` sites
  sit at the big airports and sample much lower) before calling it clear.
- **The sweep swaps under you** when the product or site changes or a new volume
  lands. `__rq` reads it live, so re-run rather than caching a number.

Couplet reading: <30 kt nothing, 30-50 weak shear, 50-70 notable, 70+ strong.
Always pair it with the range — a 60 kt delta at 100 mi is a midlevel feature,
the same delta at 25 mi is low-level and means something very different.

## 5b-2. The storm cell attribute table (SCIT) — undocumented feed

Every volume scan the radar's own algorithm publishes a per-cell table: max dBZ,
VIL, echo top, hail probability and max expected size, TVS, storm motion, and
four forecast positions at 15-minute increments. RadarOmega mirrors it and never
exposes it through a tool:

```
https://data4.radaromega.com/api/nexrad-attributes/<TOWER>/dir.json   → {"files":[...]}
https://data4.radaromega.com/api/nexrad-attributes/<TOWER>/<file>     → {"storms":{...}}
```

Wrapped, with nearest-tower selection and closest-approach maths:

```bash
python3 skills/radaromega/scripts/cells.py --within 60
python3 skills/radaromega/scripts/cells.py --tower KCCX --json
```

This is what turns "line moving east at 40" into "passes within 3 mi in 26
minutes". Caveats worth saying out loud: the forecast positions are a linear
extrapolation that knows nothing about growth, decay or a boundary ahead; the
`speed` field occasionally publishes nonsense (a 99 kt cell in a 30 kt flow is a
tracking artifact, trust the forecast positions over the speed); not every tower
is in the feed, so `cells.py` falls through to the next-nearest on a 404; and
every numeric field can be `null`, including inside `forecast_positions`.

## 5c. Soundings — the only measurement of the air the storms grow in

Radar shows what already happened. The balloon shows what is possible. NWS
launches at 00Z and 12Z (plus special 18Z on severe days) and the profile is
public within ~90 minutes.

```bash
python3 skills/radaromega/scripts/sounding.py                  # nearest to home, latest
python3 skills/radaromega/scripts/sounding.py --site PIT       # upstream, for what's coming
python3 skills/radaromega/scripts/sounding.py --lat 40.0 --lon -76.3 --when 12z --json
```

It fetches Wyoming's BUFR decode, parses the derived indices, computes 0-1 and
0-6 km bulk shear, the 700-500 mb lapse rate and the freezing level off the raw
profile, and prints each number with what it means. **`src=BUFR` is required** in
that URL — `GTS`/`UNAWIPS` return an empty page that reads exactly like "no
launch happened" and is not.

Which number answers which question:

- **"How windy will the storms be"** → DCAPE. Under 600 is a nothing; 1000+ means
  downbursts. This is the single best severe-wind discriminator and it is the one
  I used to be blind to.
- **"Will they organize"** → 0-6 km shear. <25 kt pulse junk, 25-40 clusters and
  bowing lines, 40+ supercells.
- **"Tornado risk"** → LCL height with 0-1 km shear. High LCL (>1200 m) means dry
  downdrafts and gusts, not tornadoes, no matter what the CAPE says.
- **"How hard will it rain"** → PWAT. Over 1.75 in is flash-flood efficient.
- **"Hail"** → 700-500 lapse rate plus freezing level. Steep lapse rates with a
  freezing level under ~4200 m; a 14,000 ft freezing level melts most of it.
- **"Will anything even fire"** → MUCAPE with MUCIN.

Read the UPSTREAM site, not just the nearest one, when weather is moving in: for
Lancaster that is PIT for a westerly regime, IAD for anything from the south.
Two launches a day means the 12Z profile is stale by evening — say so rather
than quoting it as current.

## 5a-bis. The radar is NUMBERS, not just colors (verified 2026-08-10)

The WebGL renderer keeps the decoded sweep client-side. `window.__claude_map.radar.radarRenderer.sweep` is:

| field | meaning |
|---|---|
| `values` | Float32Array, `720 radials × gate_depth` (typically 1824), row-major by radial |
| `value` | `{min, max, none, unit}` — unit is `dBZ` for HRF/BRF, `m/s` for HVL/BVL |
| `meters_to_first_gate`, `meters_between_gates` | 2125 and 250 on HRF |
| `azimuth_offset` | 0.5° — the first radial's bearing |
| `datetime` | the scan time of THIS frame (not wall clock) |
| `meta.elevation` | tilt in degrees — you need it for beam height |
| `rr.tower` | `{tower_code, lat, lon, vcp}` — the origin for the geometry |

**As of 2026-08-10 this is a pair of first-class tools — reach for them before execute_js.**

- `sample_radar_values(points: [{lat, lon, label}])` — exact value at up to 25 places in one call, each with range, bearing and **beam height above ground**. The answer to "is anything actually over the house".
- `scan_radar_field(lat, lon, radius_km, mode, threshold, limit)` — `mode:'max'` ranks the strongest cores with lat/lon and distance/bearing from your reference point; `mode:'couplet'` returns the largest gate-to-gate velocity differences, so rotation is a number. Results are thinned so each row is a distinct storm, not 40 gates of the same one.

Set the product first: `max` wants HRF, `couplet` wants HVL. `couplet` **refuses** to run on a non-velocity sweep rather than answering — a shear scan on reflectivity turns every sharp storm edge into a "couplet", which is a confident wrong answer, not a missing one. When it refuses it names the loaded product; call `change_radar_product('HVL')` and scan again.

Both report `nyquist_ms` so you can tell a real couplet from velocity folding (a delta near twice the Nyquist is aliasing). Some sweeps report it as `null` — the note says so explicitly instead of printing "null m/s", and in that case you cannot rule out folding at all.

Two parameter names that are easy to get wrong because they don't match the rest of the surface: `change_radar_site` takes `siteCode` (not `site`), `change_radar_product` takes `product` (not `productCode`), and `fly_to` takes `lng` (not `lon`, even though the sampling tools all take `lon`).

The raw recipe below still works and is the fallback if the tools are missing (an older server build). **Sample the value at a lat/lon:**

```js
(() => {
  const rr = window.__claude_map.radar.radarRenderer, sw = rr.sweep, v = sw.values;
  const R = 6371008.8, rad = Math.PI/180, t = {lat: rr.tower.lat, lon: rr.tower.lon};
  const nrad = v.length / sw.gate_depth, dAz = 360/nrad;
  const val = (lat, lon) => {
    const p1=t.lat*rad, p2=lat*rad, dl=(lon-t.lon)*rad;
    const y=Math.sin(dl)*Math.cos(p2), x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
    const brg=(Math.atan2(y,x)/rad+360)%360;
    const a=Math.sin((p2-p1)/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    const rng=2*R*Math.asin(Math.sqrt(a));
    const ri=Math.round((((brg-sw.azimuth_offset)%360+360)%360)/dAz)%nrad;
    const gi=Math.floor((rng-sw.meters_to_first_gate)/sw.meters_between_gates);
    if (gi<0 || gi>=sw.gate_depth) return null;
    const x2=v[ri*sw.gate_depth+gi];
    return x2 < sw.value.min-0.5 ? null : +x2.toFixed(1);   // below-min is the no-data fill
  };
  return JSON.stringify({product: sw.product, unit: sw.value.unit, scan: sw.datetime,
    here: val(LAT,LON)});
})()
```

Same helper, three jobs worth having:

- **Core intensity / where the worst of it is** — loop a 0.04° lat-lon grid over the view, keep everything ≥50 dBZ, sort. Two dozen lines, one call, and it answers "how strong is it really" with a number instead of an adjective.
- **Rotation, honestly** — on HVL, sample a pair of points ~2 km apart across a suspected couplet and take the difference. Gate-to-gate delta in m/s × 1.94 = knots. That turns "the couplet looks tight" into "58 kt gate to gate".
- **Arrival time** — sample the same grid two frames apart, cross-correlate the leading edge, and you get real motion instead of arithmetic off the warning text.

**Caveats that matter more than the numbers.** This is ONE tilt of ONE tower, not a mosaic: at 150 km on a 0.7° tilt the beam center is ~3 km up, so a surface gust core is invisible and a "42 dBZ" is 42 dBZ *three kilometres above the town*. Always report range from the tower with the value, prefer the closest site (`change_radar_site`), and say "aloft" when it is aloft. `sweep` is only the frame currently displayed — step the animation to sample other times.

Validated 2026-08-10 09:15 EDT against the rendered frame: computed 50+ dBZ maxima at 39.96/-76.56 and 39.8/-77.0 landed exactly on the two orange cores near Red Lion and Hanover.

**Three gotchas that cost me an hour, now handled inside the tools:**

1. `sweep.value` and `sweep.meta` come back as **JSON strings on some builds and objects on others**. Always `typeof v === 'string' ? JSON.parse(v) : v`. The recipe above assumes objects and will throw otherwise.
2. When converting a gate index back to lat/lon, aim at the **centre** of the gate (`meters_to_first_gate + (gi + 0.5) * meters_between_gates`), not its leading edge. Sampling the boundary lets a metre of float error fall into the previous gate, which in a tight gradient reads back 20 dBZ low.
3. `radar.activeSweepDatetime` is a **moment object**. Returned by value over CDP it serialises into several hundred lines of locale tables. Always `.format(...)` it to a string before returning.

Sanity check when a value looks wrong: a sweep is only ~2 minutes old before the next volume lands, so a lat/lon sampled a few minutes after a scan is a *different* sweep, not a bug.

**Pick the tower before you trust the number.** Verified live 2026-08-10: the same point (39.54368, -76.68739) in the same two-minute window read **68 dBZ from KCCX at 4.22 km beam height** and **49 dBZ from KLWX at 1.58 km**. Neither is wrong; the distant tower was sampling a hail core aloft while the near one saw the storm's lower body. A 19 dBZ swing purely from geometry is why `beam_height_km` is on every row. Before reporting a value for somewhere, `change_radar_site` to the tower whose beam is *lowest* there, and if the only available beam is >3 km, say the number is aloft rather than implying it is at the ground.

## 5a-ter. Data already in the app that I used to go fetch by hand

**Both of the first two are now tools: `get_outlooks(lat, lon, day, include_text)` and `get_mesoscale_discussions(lat, lon)`. Use them instead of curling spc.noaa.gov.**

- `map.getSource('sds-severe-weather-outlooks-source')._data` — **49 features**: every SPC outlook polygon, day 1/2/3, categorical AND the tornado/wind/hail probability contours, each with `issued_at` and `full_text` (the entire SWODY narrative). It updates itself, so it had the 12:47Z revision before my own curl would have. **The schema is two shapes in one layer**, and getting this wrong returns a convincing empty result: categorical polygons carry `CATEGORY` (`TSTM`/`MRGL`/`SLGT`/`ENH`/`MDT`/`HIGH`) and no `TYPE`; hazard contours carry `TYPE` (`Tornado`/`Hail`/`Wind`, or `AnySevere` on day 3) with `PROB` as a **fraction** (0.02 = 2%). A hazard polygon with `PROB` undefined is the hatched significant-severe area. `DAY` is the string `"DAY 1"`, not a number — `Number(p.DAY)` is NaN and silently filters everything out.
- `map.getSource('mesoscale-discussions')._data` — active MCDs with `prob_of_watch`, `effective_at`, `expires_at` and the full discussion text. `prob_of_watch` is SPC's own stated odds that the area gets a watch; a high number with no watch yet is the earliest honest heads-up available.
- `w.stormReports`, `w.spotterNetwork` — module instances with their own markers/state.
- `w.iot.lastDevicesData` — 209 IoT/personal weather stations with position and `last_telemetry_at`. The list is metadata only; the actual sensor values come from `iot.streamer` / a per-device fetch, which is NOT worked out yet. Do not claim PWS gust readings until it is.
- `w.lightningDetection` — real module (`fetch`, `preloadData`, `renderForRadarSweep`), but every `strike_interval` flag is false and `rapidStrikeEnabled` is false, so the geojson sources sit empty. Enabling an interval and calling `fetch` is the likely path; unproven.
- `w.hailColorCodes` — the MESH size bins, 0.75IN through 3.75IN.

## 5b. In-app warning cache (FULL warning metadata, no API needed)

The warnings module caches everything the broken tools won't return:
```js
(() => {
  const w = window[0] || window;
  let wm = null;
  for (const k of Object.keys(w)) {
    try { if (w[k] && typeof w[k]==='object' && w[k].cachedMergedData && w[k].tornadoColorCodes) { wm = w[k]; break; } } catch(e) {}
  }
  return wm.cachedMergedData;  // slice/filter before returning — it's big
})()
```
`cachedMergedData` is keyed by type: TO, SV, FF, EW, SQ, SMW, SWS, SPS, TO_WATCH, SV_WATCH, HYDRO_*, FIRE_WARN_RED_FLAG, FIRE_WATCH. Each type maps VTEC-style ids (e.g. `KABR.TO.W.0001`) → props: `tornado` ("RADAR INDICATED"/"OBSERVED"/"POSSIBLE"), `hail` (size string), `wind` (mph string), `tor_dmg_threat` (CONSIDERABLE/DESTRUCTIVE/CATASTROPHIC), `counties[]`, `expiration` (UTC), `emergency` (bool — tornado emergency!), `raw` (full NWS bulletin text), `coordinates` (polygon). `Object.keys(...).length` per type = instant national alert census. Faster and richer than api.weather.gov for "what warnings are active" — use the API only for forecast text or when the app isn't up.

**The `raw` bulletin carries the storm's own motion vector.** Every SVR/TOR text ends with a
`TIME...MOT...LOC` line — e.g. `TIME...MOT...LOC 0159Z 290DEG 40KT 4227 7994` = at 01:59Z the cell
was at 42.27/-79.94 moving *from* 290° at 40 kt. That is the issuing forecaster's own tracked motion,
better than anything you will estimate by eye off two frames, and it makes an ETA one haversine away.
`get_warning_details(warning_id)` returns it along with the polygon; note the `filter` on `get_warnings`
matches the **type code** (`SV`, `TO`, `FF`), not the word "Tornado" — filtering on the word silently
returns `matching: 0` over a full census.

## 6. The meteorologist's playbook — what to show for which question

Pick visuals like a broadcast met, not a tool tour. One message, 1-2 visuals max, caption = what/where/when/what-to-do.
- **"Is it raining / what's on radar"** → RADAR view, nearest site (activateTowerByCode or activateClosestTower), HRF, then `sample_radar_values` at the places that matter and `capture_loop(advance:'playback', frames:24)` for the mp4. Velocity (HVL) only if storms are severe-warned.

  `advance:'playback'` was rewritten 2026-08-10 and no longer trusts the app's animation timer. The app boots holding exactly **one** sweep, so the old version recorded the same frame 24 times and handed back a "video" of a still. It now raises the frame-count preference to what you asked for, calls `prepareForPlayback()`, polls until the step slider stops growing, then walks the slider one real sweep per frame — and errors out loud rather than producing a frozen clip if only one frame ever loads. `frames` is a cap: ask for 30 and you get 30 sweeps (~an hour of history) instead of the app's default 7.
- **"Will it rain tomorrow / this weekend"** → NWS hourly+daily text forecast for the numbers, plus ONE model frame or short loop (HRRR/NAM3KM COMPREF) at the relevant window. Lead with the plain answer (yes/no/when), not the model name.
- **"Severe threat day X"** → SPC category first (it's the official call), NWS timing, then hi-res model: COMPREF loop for timing/placement + MAXUPDH check for organized-rotation potential. CAPE frame if instability is the story.
- **"What do the models show"** → capture_loop video of the run (that IS the deliverable), state run init time + valid range, note model disagreements if you checked more than one.
- **"Big picture / fronts / pattern"** → surface-fronts recipe at CONUS zoom, decluttered, with H/L and the driving low called out; GFS loop if they want the evolution.
- **Active warning near them** → fly to it, HRF + velocity, draw the threat polygon/arrow + their location marker, details from the in-app warning cache (§5b: tornado tag, hail size, damage threat, expiration). Life-safety line FIRST.
- **"How bad was the outbreak / what happened today"** → MRMS 24hr hail swaths + 24hr rotation tracks (§3b) over the region, plus SPC storm reports CSV for counts.
- **Tropical** → §4b: read activeTropicalData for facts (incl. NHC discussion), render cone+track+wind field, capture. Mention watches/warnings from breakpoint_alerts. HWRF/HMON in model view for track/intensity comparison.
- **Winter** → model `PTYPE` / `TSNOW` / `TFRZR` / `TFRZRA` + NWS text. (There is no Kuchera `TSNOWKUCH` product in this app — checked on HRRR, NAM12KM and GFS 2026-09-03. `TSNOW` is what you get.) MRMS `WINTER-MRMS-DATA` for live snow/ice radar.
- **"Is anything going to fire this afternoon" / "could we get storms"** → this is NOT a radar question and answering it off a radar frame is the failure mode. Work `skills/radaromega/reference/signs.md` top-down: environment (`sounding.py`, model CAPE/CIN/shear), then the trigger (Band 09 water vapour, shortwave leading edge), then the state of the cumulus field (Band 02 — flat vs agitated vs orphan anvils vs cloud streets holding flat), then radar last. The negative is a real answer: "cap's holding, streets are staying shallow, I don't think anything fires here" is worth more than a hedge.
- **A storm going up right now** → SATELLITE `BAND13-DATA` (§4c), meso sector if one is pointed at you, `capture_loop`. An overshooting top buys ~30 min over the radar signature; an above-anvil cirrus plume averages 31 min ahead of the severe weather and flags 73% of significant-severe storms. Then confirm on radar, don't lead with it.
- **Live event monitoring** → standing mission polling api.weather.gov alerts; SILENT between real updates — no "next check at X" status posts, ever.

Always: annotate (`clear_drawings` → draw → capture), real terminology translated ("that couplet is rotation — basement by 9:40"), restore the user's home view after remote work. Quiet weather is a one-liner + one clean visual, not an apology.

## 6a. Frame it, or do not send it

**Never pass a guessed `zoom` to `fly_to` before a capture.** This is the single most common way a technically-correct radar image is useless: the storm ends up forty pixels wide in the corner of three states, and the person you sent it to has to squint to find their own town.

Use `fit_view` instead. Give it the storm cores from `scan_radar_field` plus the places that matter — their house, the warned town — and it solves for the zoom that makes all of them fill the frame. It waits out the camera animation and reports the zoom it settled on. Verified 2026-08-10: the same scene I would have shot at zoom 6.9 by hand came out at 8.9, and the difference is a picture you can read on a phone versus one you cannot.

Two habits that go with it: `clear_drawings` before every fresh capture, because a stale "62 dBZ" marker from twenty minutes ago sitting on now-empty sky is worse than no marker; and if the answer is about one specific place, put that place in the points list so it cannot be cropped out.

## 6b. The three scripts — `skills/radaromega/scripts/`

The MCP tools answer questions. These assemble deliverables. All three are standalone, take `--json`, and are documented in their own docstrings.

- **`panel.py`** — the answer to "why do you only ever send reflectivity". Captures the SAME view across six products and tiles them into one labeled sheet, with the plain-English meaning of each panel burned in. Auto-frames off the cores it finds. `panel.py --lat <lat> --lon <lon> --site KDIX`. Roughly a minute for six panels, so do not run it for a drizzle question.

  **The product codes are not the ones you would guess.** This app uses `HCC` for correlation coefficient (not CC), `DRF` for differential reflectivity (not ZDR), `HSV` for storm-relative velocity (not SRM), `HSW` for spectrum width (not SW), and has **no DVIL at all**. `change_radar_product` validates against the live selector as of 2026-08-10 and lists the real codes back at you; before that fix it accepted a stale hardcoded whitelist, set the app to a product its renderer had never heard of, and the app threw `Cannot read properties of null (reading 'substr')` from deep in its draw path — which reads like a broken tool rather than a wrong code.

- **`ground_truth.py`** — what people actually observed, as opposed to what the radar inferred about a volume of air a mile up. NWS Local Storm Reports (via the Iowa Environmental Mesonet, keyless), airport METARs, PennDOT 511PA roadside cameras, and the operator's own sky camera, if one is configured. `--save-cams DIR --skycam` downloads the stills. When radar says 60 dBZ and a spotter says trees down, the spotter wins.

- **`report.py`** — the agency-style page. Headline, the threat broken out by hazard with probabilities, SCIT cell tracks with closest approach and ETA, the strongest cores with beam heights, the forecaster discussion, ground truth, cameras, and the panel and loop embedded. Writes a self-contained directory; hand that to instant-share's `share.sh` and let **it** mint and verify the URL. It must live in a directory made by `create_artifact.sh` or validation blocks the share.

  Images inside the artifact need the `?key=` too, so the template emits `data-src` and rewrites it from `location.search` on load. Do not hardcode a src.

**The deliverable ladder.** Match the effort to the question. A passing "is it going to rain" gets one sentence and maybe one framed still. A warned storm over their house gets the annotated capture within three minutes, then the panel and the report if there is time — life-safety line first, always, before anything pretty. "What happened today" gets the report. Never send six panels when one framed image answers it, and never send one zoomed-out still when they asked what the storm is actually doing.

## 6c. Ground truth sources that do NOT work

Checked 2026-08-10, so nobody re-litigates it: **X/Twitter** search is JS-gated and needs a logged-in session (chrome-devtools is not wired into every session, so treat it as unavailable); **Facebook** returns 404 to unauthenticated post search; **Bluesky's** public API refuses this IP; **mPING** wants an API key. Local Storm Reports are the honest substitute and are better sourced anyway — they are trained spotters and 911 centres rather than randoms, they carry a remark, a magnitude and a location, and `ground_truth.py` already pulls them.

## 6d. Lancaster sits in a radar gap

Worth knowing before quoting any number for the home location. In this deployment's region the nearest WSR-88Ds — KDIX, KLWX, KCCX, KDOX — are all roughly 150 to 170 km away, so the lowest available beam over the house is around **2.5 to 4 km above the ground**. Practical consequences: the radar cannot see a surface gust or a low-level couplet there at all; reflectivity over the house is describing the middle of the storm, not what is falling; and KDIX generally gives the least-bad geometry. This is exactly why the ground-truth sources matter more here than they would somewhere sitting under a tower, and why every value the tools return carries `beam_height_km`.

## 7. Operational habits

- Cold first call auto-launches the app (~10-45s) — send a one-line "pulling up radar" first.
- Never `sleep` in Bash around these tools; use `settle_ms` on captures.
- Full analysis pass runs SILENT (eyeball frames via `capture_view(view: true)`; deliver-only captures skip `view`); the user gets one composed answer.
- A multi-product severe pass takes ~3-5 min with these recipes; pacing message first, `check_incoming` between major steps.
- After working a remote event: `clear_drawings`, fronts off, NHC layers cleared (`nhc._clearAllLayers()`), tower layers restored, home radar reactivated (KCCX/HRF), set_view_mode RADAR, zoom back to home area (-77, 40.8, z7).
- **Two failed set_model calls = restart the app (§1b), not a JS debugging session.** Budget rule: if the model view isn't loading correctly within ~2 minutes of effort, quit + relaunch. The restart path is faster than every workaround.
