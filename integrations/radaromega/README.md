# RadarOmega integration

RadarOmega (`/Applications/RadarOmega.app`) is an **Electron app built with
ToDesktop** (`com.todesktop.200402kk4yak2og`, Electron 38). The entire
application is the radaromega.com **webviewer** — a Mapbox GL web app loaded
in a Chromium window via `frame.php` with a token-authenticated session. That
architecture is what makes the integration possible: launched with
`--remote-debugging-port=<port>`, the renderer exposes Chrome DevTools
Protocol, and the vendored MCP server (`vendor/radaromega-mcp`) drives the
app through it — evaluating JS against the page, reading the app's own data
modules, and screenshotting the compositor.

There is no public RadarOmega HTTP API; the app's backend calls are
token-bound to the session inside the webviewer. Everything goes through the
app's JS surface, which also means the model sees exactly what a human user
of the app would see.

## Layers

```
edmund worker (claude)
  └─ MCP stdio → vendor/radaromega-mcp/dist/index.js   (per-session subprocess)
       └─ CDP WebSocket → RadarOmega renderer (port 9222)
            └─ webviewer JS: Mapbox GL map (cached as window.__claude_map),
               app data modules (warnings, reports, lightning, METARs, NHC),
               window.__claude_drawings for model-drawn overlays
```

## Reliability contract

The MCP server self-heals; no manual steps exist anywhere in the chain:

- **Auto-connect**: every tool runs `ensureConnected()` — attaches to CDP and
  primes the Mapbox map handle. No `connect`/`discover_map` ritual.
- **Auto-launch**: if CDP is unreachable, the server launches the app itself
  (`open -a RadarOmega --args --remote-debugging-port=<port>`, killing a
  stale no-CDP instance first since Electron only honors the flag at launch)
  and polls until CDP answers (≤45s). Disable with `RADAROMEGA_AUTOLAUNCH=0`;
  override the app path with `RADAROMEGA_APP_PATH`.
- **Auto-reconnect**: the CDP socket dropping (app quit/crashed/relaunched)
  marks the client disconnected; the next tool call re-runs the whole ladder.
- **Everything is timeout-bounded**: target discovery 3s, WebSocket upgrade
  5s, every CDP request 30s, launch wait 45s. A tool can be slow once after a
  cold start; it can never hang a session.
- **Single-flight connects**: concurrent tool calls share one connect attempt.

Launch paths (all idempotent, all converge):
1. On demand by the MCP server (the safety net that makes the rest optional).
2. `edmund start|restart` via `cli/services/radaromega.ts` when
   `[radaromega].enabled = true` in config.toml.
3. Manual: `vendor/radaromega-mcp/launch.sh [port]` — exits 0 immediately if
   CDP already answers.

## Tool map (26 tools, `mcp__radaromega__*`)

| Domain | Tools | Notes |
|---|---|---|
| Connection | `connect`, `discover_map` | Optional — self-healing makes both automatic. |
| Model predictions | `set_model(model)`, `set_model_product(product)` | Models: HRRR, NAM3KM, NAM12KM, RAP, GFS, ECMWF, HWRF, HMON (CONUS/GLOBAL). Products: TOR, WIND, HAIL, 2MTEMP, 2MDEWPOINT, COMPREF, EHI1KM, EHI3KM, MUCAPE, SFCCAPE, SCP, STP, MAXUPDH, PTYPE, TFRZR, TPRECIP, TSNOW, TSNOWKUCH. |
| Feature domains | `show_feature(feature)` | severe_weather_outlooks, mesoscale_discussions, tropical_weather_outlooks, hydrological_outlooks, fire_weather, winter_weather_outlooks, climatological_outlooks, marine_tools, power_outages, satellite/mrms/model_settings — clicks the app's own navbar entry. |
| Video | `capture_loop(frames?, interval_ms?, format?)` | Plays the animation, captures a frame sequence, assembles mp4/gif via ffmpeg into the sandbox for `send_attachment`. |
| Navigation | `fly_to(lng, lat, zoom?, bearing?, pitch?)` | `lng`, not `lon`. |
| Radar control | `change_radar_site(siteCode)`, `change_radar_product(product)`, `set_view_mode(mode)` | Products: HRF HVL BRF BVL CC ZDR KDP HCA VIL ETP STP SHR. Modes: RADAR SATELLITE MRMS MODEL. |
| Animation | `control_animation(action, speed?, frames?)` | play/pause/stop/step_forward/step_back. |
| Overlays | `toggle_overlay(overlay, enabled)` | warnings, stormReports, metars, surfaceFronts, lightningDetection, stormNet, stormTracks. Some (warnings) have no toggle in the current build → soft error; they render by default. |
| Raw layers | `list_layers(filter?)`, `toggle_layer(layerId, visible)` | Real Mapbox layer ids. |
| State | `get_map_state`, `get_detailed_state`, `get_radar_info` | `get_detailed_state` = one-call situational snapshot. |
| Weather data | `get_warnings`, `get_warning_details`, `get_storm_reports`, `get_lightning_data`, `get_metar_data`, `get_nhc_data`, `generate_weather_report` | Read from the app's own data modules. |
| Drawing | `draw_marker`, `draw_line`, `draw_polygon`, `clear_drawings` | Coordinates are `[lng, lat]`. Drawn into `window.__claude_drawings`. |
| Measurement | `measure_distance(coordinates)` | |
| Output | `capture_view` | Saves a JPEG under `<sandbox>/radaromega/` (via `EDMUND_SANDBOX_PATH` / `RADAROMEGA_CAPTURE_DIR`) and returns the path for `send_attachment`, plus the image inline for the model's own eyes. |
| Escape hatches | `execute_js`, `introspect_app`, `get_page_text` | For datasets without a named tool (marine/winter/fire/hydro views, menu items). |

## Verified end-to-end (2026-06-09)

With the app **fully quit**, a cold `get_detailed_state` auto-launched
RadarOmega and answered in ~13s. `fly_to` Lancaster PA, `draw_polygon`
("THREAT AREA") + `draw_marker` ("HOME"), and `capture_view` produced an
annotated live Hi-Res Reflectivity JPEG ready for `send_attachment`.

## Config

```toml
[radaromega]
enabled = true
package_path = "./vendor/radaromega-mcp"
cdp_port = 9222
```

Wiring: `src/claude/mcp-config.ts` adds the `radaromega` server to the worker
MCP loadout; `skills/radaromega/SKILL.md` carries the model-facing playbook
(including alert watches via `start_mission`); rebuild the vendor package
after editing its src with `cd vendor/radaromega-mcp && ./node_modules/.bin/tsc`.
