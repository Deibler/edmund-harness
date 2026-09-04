#!/usr/bin/env python3
"""Render a trail map PNG: topo basemap, the traced route, the trailhead pin.

Builds a Leaflet page and screenshots it with headless Chrome. No API keys,
no paid tiles.

Two honest modes:
  traced   - route.geojson has geometry, so the actual path is drawn in orange
             and the view fits the route.
  untraced - no geometry was resolvable. The hiking overlay still renders every
             mapped trail in the area from OSM, the trailhead is pinned, and the
             legend says the route is not traced. Never draw a guessed line.

Usage:
    render_map.py --lat 39.84066 --lon -76.31640 --label "Kellys Run" \
        --route route.geojson --out map.png
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

PAGE = """<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html,body{margin:0;padding:0;background:#f4f1e8}
  #map{width:__W__px;height:__H__px}
  .leaflet-control-attribution{font:10px/1.4 -apple-system,Helvetica,sans-serif;background:rgba(244,241,232,.88)}
  .legend{position:absolute;left:14px;bottom:22px;z-index:900;background:rgba(244,241,232,.94);
          border:1px solid #b9b3a1;padding:9px 12px;font:12px/1.55 -apple-system,Helvetica,sans-serif;color:#17190f}
  .legend b{display:block;font-size:13px;margin-bottom:3px}
  .swatch{display:inline-block;width:20px;height:3px;background:#bf3f10;vertical-align:middle;margin-right:6px}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#17190f;
       border:2px solid #f4f1e8;box-shadow:0 0 0 1px #17190f;vertical-align:middle;margin-right:4px}
</style></head><body>
<div id="map"></div>
<div class="legend">__LEGEND__</div>
<script>
var route = __ROUTE__;
var lat = __LAT__, lon = __LON__;
var map = L.map('map', {zoomControl:false, attributionControl:true});
L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
  maxZoom:17, attribution:'Map data OpenStreetMap contributors, SRTM. Style OpenTopoMap (CC-BY-SA)'
}).addTo(map);
L.tileLayer('https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', {
  maxZoom:18, opacity:0.85, attribution:'Trail overlay: waymarkedtrails.org'
}).addTo(map);

var head = L.circleMarker([lat, lon], {
  radius:8, color:'#17190f', weight:3, fillColor:'#f4f1e8', fillOpacity:1
}).addTo(map);

if (route && route.features && route.features.length) {
  var line = L.geoJSON(route, {style:{color:'#bf3f10', weight:4, opacity:0.95}}).addTo(map);
  var b = line.getBounds().extend(head.getLatLng());
  map.fitBounds(b, {padding:[34,34]});
} else {
  map.setView([lat, lon], __FALLBACK_ZOOM__);
}
window.__ready = false;
map.whenReady(function(){ setTimeout(function(){ window.__ready = true; }, 1200); });
</script></body></html>"""


def build(args, route):
    traced = bool(route.get("features"))
    if traced:
        props = route["features"][0].get("properties", {})
        bits = ['<b>%s</b>' % (args.label or props.get("name") or "Route")]
        bits.append('<span class="swatch"></span>traced route')
        if props.get("blazes"):
            bits.append("<br>" + props["blazes"])
        bits.append('<br><span class="dot"></span>trailhead %.5f, %.5f' % (args.lat, args.lon))
        legend = "".join(bits)
    else:
        legend = (
            '<b>%s</b><span class="dot"></span>trailhead %.5f, %.5f'
            "<br>Route not traced. Coloured lines are the mapped trail<br>network from OpenStreetMap, not this specific loop."
            % (args.label or "Trailhead", args.lat, args.lon)
        )
    return (
        PAGE.replace("__W__", str(args.width))
        .replace("__H__", str(args.height))
        .replace("__ROUTE__", json.dumps(route))
        .replace("__LAT__", repr(args.lat))
        .replace("__LON__", repr(args.lon))
        .replace("__FALLBACK_ZOOM__", str(args.zoom))
        .replace("__LEGEND__", legend)
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--label", default="")
    ap.add_argument("--route", help="GeoJSON from trail_geometry.py")
    ap.add_argument("--out", required=True)
    ap.add_argument("--width", type=int, default=1600)
    ap.add_argument("--height", type=int, default=1100)
    ap.add_argument("--zoom", type=int, default=14)
    a = ap.parse_args()

    route = {"type": "FeatureCollection", "features": []}
    if a.route and os.path.exists(a.route):
        with open(a.route) as f:
            route = json.load(f)

    if not os.path.exists(CHROME):
        print(json.dumps({"ok": False, "error": "Chrome not found at " + CHROME}))
        return 1

    html = build(a, route)
    tmpdir = tempfile.mkdtemp(prefix="hikemap_")
    page = os.path.join(tmpdir, "map.html")
    with open(page, "w") as f:
        f.write(html)

    out = os.path.abspath(a.out)
    cmd = [
        CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
        "--force-device-scale-factor=2",
        "--window-size=%d,%d" % (a.width, a.height),
        # Tiles are many small requests; give them real time to land.
        "--virtual-time-budget=20000",
        "--screenshot=" + out,
        "file://" + page,
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=180)
    if not os.path.exists(out) or os.path.getsize(out) < 20000:
        print(json.dumps({
            "ok": False,
            "error": "screenshot did not render",
            "stderr": proc.stderr.decode()[-500:],
        }))
        return 1

    print(json.dumps({
        "ok": True,
        "path": out,
        "bytes": os.path.getsize(out),
        "traced": bool(route.get("features")),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
