# Fishing data integration

Wires the local **mid-Atlantic fishing data platform** (`~/fishing-data-platform`,
FastAPI on `:8087`) directly into the model's MCP loadout.

## How it works

```
user → main model
         ├─ read_skill("fishing")             endpoint workflow + interpretation rules
         ├─ fishing_query(path, params)        GET JSON/CSV/text directly
         └─ fishing_viz(path, params)          render PNG directly into this chat's sandbox
                                                   └─ send_attachment(saved path)
```

- **Direct tools**: there is no fishing-specific worker, environment gate, poll,
  or result relay. The responding model queries the data in the same turn.
- **Progressive detail**: the two schemas stay concise; endpoint selection,
  evidence limits, and the weather/data split live in `skills/fishing/SKILL.md`.
- **Charts**: `fishing_viz` saves a PNG under the current conversation sandbox
  and returns the path for `send_attachment`.

## Files

| File | Role |
|---|---|
| `integrations/fishing/tools.ts` | Direct `fishing_query` and `fishing_viz` tool definitions |
| `integrations/fishing/src/client.ts` | HTTP client (`fishingGetJson`, `fishingGetImage`) |
| `skills/fishing/SKILL.md` | Endpoint workflow and evidence/interpretation guidance |
| `integrations/fishing/config.ts` | Validated `fishing: { enabled, api_url }` view |

## Config

```toml
[fishing]
enabled = true
api_url = "http://127.0.0.1:8087/api/v1"
```

## Service management (launchd)

The fishing API is a first-class managed service alongside the harness, dashboard,
and trading dashboard. It runs `uv run fishctl serve` (a uv/Python server in
`~/fishing-data-platform`) under a LaunchAgent (`com.edmund-harness.fishing`,
KeepAlive) so it auto-starts at login and relaunches on crash.

The data itself is PostGIS in Docker (`fishdata-postgis`, port `5544`). A live
API process is not sufficient: `/api/v1/meta/health` must report
`"database":"ok"`. Start it from the platform repo with `docker compose up -d`.

```
edmund restart                 # bounces ALL services incl. fishing
edmund restart --fishing       # just the fishing API
edmund start|stop --fishing    # launchd start/stop (install on first start)
edmund status [--fishing]      # state, pid, port (8087), URL, log
edmund logs --fishing [-f]     # tail data/fishing.launchd.out.log
edmund start --fishing --local # foreground (runs scripts/launchd/run-fishing.sh)
```

Wiring (mirrors the dashboard/trading services):
- `scripts/launchd/com.edmund-harness.fishing.plist` + `run-fishing.sh` (wrapper:
  `cd ~/fishing-data-platform && exec uv run fishctl serve`)
- `scripts/launchd/service.sh` — `fishing {install|uninstall|start|stop|restart|status|logs}`
- `cli/services/{paths,launchctl,target,preflight}.ts` — `Svc` gains `"fishing"`;
  default target set is harness + dashboard + trading + fishing; port (8087) parsed
  from `[fishing] api_url`; process signature `fishctl serve`.

Data freshness: run `uv run fishctl scheduler` (separately) if you want connectors
to keep refreshing. MCP tools + config still load per `claude -p` turn, so tool/config
changes take effect on the next message — no harness restart needed.

## What the model can answer

Anything in the dataset: waters & summaries, per-water species composition (bass/
walleye/musky…), stocking, regulations (incl. electric-only / no-motor / HP limits),
depth, access, conditions — plus charts/maps (`/viz/chart`, `/viz/map`: bar/line/pie/
hist/scatter, heatmap/points). Example asks: "what to expect bass-fishing at Blue
Marsh?", "electric-only largemouth lakes near Reading, with a chart", "map catch
hotspots near Lancaster PA".
