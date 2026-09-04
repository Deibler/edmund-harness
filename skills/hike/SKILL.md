---
name: hike
description: Build a hike brief with a real topographic map, the traced route from OpenStreetMap, trailhead coordinates, and verified conditions. Use whenever Alex asks for a hike, a trail, a walk, "somewhere to explore", or asks about a trail he's already on. Never recommend a trail without running this.
---

# Hike

One trail, one brief: topo map with the actual route drawn on it, trailhead
coordinates, mile-by-mile of how the scenery changes, and closures checked
against the land manager rather than a blog.

---

## Hard rules

1. **Never draw a route you did not resolve.** `trail_geometry.py` returns
   `traced: false` when it cannot find real geometry. That is a fine outcome.
   The map then shows the OSM trail network with the trailhead pinned and says
   so in the legend. A confident wrong line on a topo map gets somebody lost.
2. **Never state a coordinate you have not seen in a source this turn.** Two
   independent agreeing sources or don't publish the decimal. Address plus
   "I didn't get a verified pin" beats a plausible-looking wrong one.
3. **Check the land manager for closures before recommending.** AllTrails
   comments lag by years. The Conservancy / DCNR / sanctuary page is the truth.
   Tucquan Glen's parking has been shut indefinitely while every listicle still
   sends people there.
4. **Lead with how the scenery changes.** Alex and Sam have a running joke
   about biome changes and he actively dislikes trails that look the same the
   whole way (he named the Enola Low Grade). A trail that shifts from creek
   bottom to ridge to overlook is the product. Say where each shift happens.
5. **Always give coordinates and a route link.** Standing request as of
   2026-08-02. Decimal degrees, five places, plus a mapping link.

---

## Pipeline

    1. research      web_search + the land manager's own page
    2. geometry      scripts/trail_geometry.py   -> route.geojson
    3. map           scripts/render_map.py       -> map.png
    4. brief         scripts/build_brief.py      -> index.html
    5. deliver       instant-share, or send_attachment for the PNG alone

### 1. Research

Get these before writing anything. Distance and gain from a route source
(AllTrails, HikingProject, Gaia), then **the land manager page** for status:

- Lancaster Conservancy   lancasterconservancy.org/preserves/<slug>/
- PA state parks          pa.gov -> DCNR -> find-a-park -> <park> -> hiking
- Hawk Mountain           hawkmountain.org (private, charges a trail fee)
- National Park Service   nps.gov/<code>

Note the parking situation explicitly. It is the thing that ruins a drive.

### 2. Geometry

    python3 scripts/trail_geometry.py \
        --name "Conestoga Trail" --lat 39.84066 --lon -76.31640 \
        --radius-km 6 --out route.geojson

Prints a JSON summary. `traced: true` means a path was resolved.

`--name` should be the **blazed route name**, not the local loop name. Waymarked
Trails indexes OSM route relations, so "Conestoga Trail" resolves and returns
the whole 63 mile system; `--radius-km` then clips it to the part near your
trailhead. For a park loop with no route relation ("Boone Trail"), it falls
through to Overpass, which is slow and 504s often. If both miss, continue with
`traced: false` and be honest in the caption.

### 3. Map

    python3 scripts/render_map.py \
        --lat 39.84066 --lon -76.31640 --label "Kellys Run and the Pinnacle" \
        --route route.geojson --out map.png

OpenTopoMap basemap plus the Waymarked Trails hiking overlay, screenshotted
with headless Chrome at 2x. No keys, no cost. Output is about 3200x2200 and
several megabytes; downscale before sending over iMessage:

    python3 -c "from PIL import Image; im=Image.open('map.png'); \
      im.convert('RGB').resize((im.width//2, im.height//2)).save('map_send.jpg', quality=88)"

### 4. Brief

Write a spec JSON (shape documented at the top of `build_brief.py`), then:

    python3 scripts/build_brief.py --spec hike.json --map map.png --out $ARTIFACT/index.html

The map is base64-inlined on purpose. instant-share's server gates every
request on `?key=`, so a sibling `<img src="map.png">` would 403 and ship a
brief with a hole in it.

### 5. Deliver

For a full brief use the **instant-share** skill: `create_artifact.sh`, write
`index.html`, `share.sh`, and wait for "Verified working" before sending a URL.
For a quick answer, `send_attachment` the downscaled map and put the
coordinates in the message text.

---

## What goes in the brief

The template has fixed sections. Fill all of them or drop them from the spec.

- **At a glance** - distance, shape (loop / out and back / point to point),
  climb, honest time, terrain, drive time from home, fee if any.
- **The map** - the render. Caption says traced or not traced, and from where.
- **What changes along the way** - the point of the whole thing. Numbered legs
  in walking order, each naming the transition: field to gorge, gorge to ridge,
  ridge to overlook. Name real features, not "beautiful scenery".
- **Getting there** - trailhead decimal coordinates, street address, route link,
  parking capacity, restrooms, second-car needs.
- **Warnings** - closures, fees, water crossings, whether feet get wet.
- **Sources** - every one dated, with what was read.

## Notes that have already cost time

- Alex cannot shuttle two cars by default. Offer a single-car version of any
  point-to-point (usually an out and back to the good part) or he can't do it.
- He does 10 mile days. "Long" means 8+ for him, not 4.
- Overpass mirrors were all 504 or dead on 2026-08-02. Waymarked Trails answered
  in under a second for the same data. Try tier 1 first, always.
- Waymarked Trails serves EPSG:3857 metres, not lat/lon. The converter is in
  `trail_geometry.py`; don't hand-roll it again.
- No emojis anywhere in the output. Alex's standing rule on UI.
