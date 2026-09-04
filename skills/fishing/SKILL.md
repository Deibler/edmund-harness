---
name: fishing
description: Ground any PA, MD, NJ, or DE fishing question in the local fishing dataset—waters, bass and other species, stocking, catches, boat access, motor rules, depth, gages, observed conditions, charts, or maps. Use fishing_query and fishing_viz before relying on memory or general web results.
---

# Mid-Atlantic fishing data

Use the local platform as the primary source for fishing questions in PA, MD,
NJ, and DE. It joins waterbodies, species presence, public catch occurrences,
stocking, regulations, access points, monitoring gages, depth, and survey links.

## Answer a water-specific question

1. Resolve the water with `fishing_query` at `/waterbodies`, usually with
   `{q:"<name>", state:"PA"}`. Do not invent an id. If near-duplicates come
   back, prefer the exact named water with the richer survey/source record, or
   inspect both summaries when that distinction matters.
2. Query `/waterbodies/{id}/summary`. This is the join hub and often answers the
   question in one call: species, access, gages, stocking, catches, regulations,
   motor restrictions, depth, and biologist reports.
3. Use a targeted endpoint only for detail the summary does not contain.

Useful endpoints:

- `/fisheries` — species composition by water; filters include `water`,
  `species`, and `state`.
- `/analytics/best-waters` — compare waters by species, state, and propulsion
  restriction.
- `/regulations` — special regulations and `motor_restriction` such as
  `electric_only`, `no_motor`, or `hp_limit`.
- `/stocking`, `/catches`, `/access-points`, `/gages`, `/species` — focused
  records with spatial and ordinary filters.
- `/gages/{site_no}/observations` — observed flow, stage, temperature, or other
  measurements when that gage exposes them.
- `/meta/stats` and `/meta/connectors` — dataset coverage and source freshness.

Common spatial params are `near:"lon,lat,radius_m"` and
`bbox:"west,south,east,north"`. Pagination uses `limit` and `offset`.

## Current conditions and forecasts

Keep evidence types separate. Fishing gages provide observed water conditions;
they do not provide a weather forecast. For a question like “how will Blue
Marsh fish tonight,” use the fishing data for the water/species/access facts and
RadarOmega for current weather, radar, or forecast timing. Say which conclusion
comes from which source.

## Charts and maps

Call `fishing_query` on `/viz/schema` before composing visualization params; it
is the live contract for entities, dimensions, measures, filters, and kinds.
Then call `fishing_viz` with `/viz/chart` or `/viz/map`. The tool saves a PNG and
returns its path. Deliver that path with `send_attachment`; a filesystem path in
message text is not a delivered image.

For underlying numbers instead of a PNG, call `fishing_query` on the same viz
path with `fmt:"json"`.

## Interpret honestly

- Species-presence data proves presence, not today’s bite quality or abundance.
- Catch records are open-licensed GBIF/iNaturalist occurrences, not private
  angler-app logs. A heatmap is sampling density, not a guaranteed hotspot.
- Zero records means “none in this dataset,” not “none exist.”
- Prefer source URLs, survey years, and observation times returned by the API;
  do not turn an old survey into a current claim.
- If a data call fails, query `/meta/health`. A listening API with a failed
  database is unavailable; report that plainly instead of silently replacing
  the local dataset with generic web search.
