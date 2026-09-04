#!/usr/bin/env python3
"""A live map of Pennsylvania: radar on top, every traffic camera underneath.

Radar tells you where the storm is. A camera tells you what it is doing to the
road. Putting them on the same map means you can see a line coming and then look
at the pavement it is about to cross, which is the thing you actually want at
5pm on a Friday.

    cammap.py --out-dir artifact_xxx
    cammap.py --out-dir out --center <lat>,<lon> --zoom 9

Radar overlay is the Iowa Environmental Mesonet's NEXRAD base-reflectivity mosaic
(n0q), a public keyless tile service that restitches roughly every five minutes.
Cameras are PennDOT's 511PA feed, 1500 of them, cached alongside this script by
ground_truth.py.

On the video question: PennDOT does serve real HLS for a subset of cameras, but
getting a playable URL is a three-step token dance (GET /Camera/GetVideoUrl, POST
to pa.arcadis-ivds.com for a secure token, then append it to a per-camera base)
and every step is same-origin-only, so a page hosted anywhere else cannot do it
without proxying their tokens — which would also put us in front of their rate
limiter, and it already answers 429 under light use. What this page does instead
is the same thing their own map does between clicks: pulls the still every ten
seconds, which is PennDOT's own refresh rate. It is a live view; it just is not
h.264. Each popup also links out to 511PA itself for the real player.
"""

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cams511.json")

PAGE = """<!doctype html>
<html lang=en>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,maximum-scale=5">
<title>Pennsylvania radar and cameras</title>
<link rel=stylesheet href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%%;background:#0f1115;color:#e8eaef;
  font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
#map{position:absolute;inset:0}
.bar{position:absolute;z-index:600;top:0;left:0;right:0;background:rgba(15,17,21,.93);
  border-bottom:1px solid #2a2f3a;padding:9px 13px;display:flex;gap:12px;align-items:center;
  flex-wrap:wrap;backdrop-filter:blur(8px)}
.bar b{font-size:14px;font-weight:700;letter-spacing:-.01em}
.bar .s{font-size:12px;color:#8b93a3;font-variant-numeric:tabular-nums}
.bar .sp{flex:1}
button{background:#262b35;color:#e8eaef;border:1px solid #39414f;border-radius:6px;
  padding:5px 11px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
button.on{background:#d63e3e;border-color:#d63e3e;color:#fff}
button:active{transform:translateY(1px)}
/* the bar is fixed over the map, so push Leaflet's own controls clear of it
   or the +/- sits on top of the title and eats the first two characters */
.leaflet-top.leaflet-left{margin-top:46px}
.leaflet-control-zoom a{background:#1a1e26;color:#e8eaef;border-color:#2a2f3a}
.leaflet-control-zoom a:hover{background:#262b35}
.leaflet-popup-content-wrapper{background:#171a20;color:#e8eaef;border-radius:9px;
  box-shadow:0 10px 34px rgba(0,0,0,.55)}
.leaflet-popup-tip{background:#171a20}
.leaflet-popup-content{margin:11px 12px;width:302px!important}
.pop h4{font-size:14px;font-weight:700;margin-bottom:2px;line-height:1.3}
.pop .rd{font-size:12px;color:#8b93a3;margin-bottom:8px}
.pop img{width:100%%;border-radius:6px;display:block;background:#000;min-height:150px}
.pop .row{display:flex;gap:7px;margin-top:8px;align-items:center}
.pop a{flex:1;text-align:center;text-decoration:none;background:#262b35;color:#e8eaef;
  border:1px solid #39414f;border-radius:6px;padding:6px 9px;font-size:12.5px;font-weight:600}
.pop .age{font-size:11.5px;color:#6d7484;font-variant-numeric:tabular-nums;white-space:nowrap}
.pop .dead{font-size:12.5px;color:#e08a8a;padding:22px 0;text-align:center}
.legend{position:absolute;z-index:600;bottom:16px;left:12px;background:rgba(15,17,21,.93);
  border:1px solid #2a2f3a;border-radius:8px;padding:9px 11px;font-size:11.5px;color:#8b93a3;
  backdrop-filter:blur(8px);line-height:1.7}
.legend .sc{display:flex;height:9px;width:186px;border-radius:2px;overflow:hidden;margin:5px 0 3px}
.legend .sc i{flex:1}
.legend .lb{display:flex;justify-content:space-between;font-variant-numeric:tabular-nums}
@media(max-width:560px){.leaflet-popup-content{width:238px!important}.legend{display:none}}
</style>
</head>
<body>
<div class=bar>
  <b>PA radar and cameras</b>
  <span class=s id=stamp>loading radar…</span>
  <span class=sp></span>
  <button id=tRadar class=on>Radar</button>
  <button id=tCams class=on>Cameras</button>
</div>
<div id=map></div>
<div class=legend>
  <div>Base reflectivity (dBZ)</div>
  <div class=sc>%(SCALE)s</div>
  <div class=lb><span>5</span><span>25</span><span>45</span><span>65</span><span>75</span></div>
  <div style="margin-top:6px">%(NCAM)d cameras · stills refresh every 10s</div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var CAMS = %(CAMS)s;

var map = L.map('map', {center: [%(LAT)f, %(LON)f], zoom: %(ZOOM)d, zoomControl: true, minZoom: 6});
L.control.scale({imperial:true, metric:false}).addTo(map);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap, &copy; CARTO', subdomains:'abcd', maxZoom: 19
}).addTo(map);

// IEM restitches the mosaic roughly every five minutes. Cache-bust on a five
// minute bucket rather than every load, so panning reuses tiles instead of
// re-pulling the whole viewport.
function radarUrl() {
  var bucket = Math.floor(Date.now() / 300000);
  return 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png?v=' + bucket;
}
var radar = L.tileLayer(radarUrl(), {opacity: 0.62, maxZoom: 19, attribution: 'NEXRAD via Iowa Environmental Mesonet'});
radar.addTo(map);

function stampNow() {
  var d = new Date();
  document.getElementById('stamp').textContent = 'radar as of ' +
    d.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
}
stampNow();
setInterval(function () { radar.setUrl(radarUrl()); stampNow(); }, 300000);

// One <img> per open popup, swapped on a timer. Cameras are 320x240 and PennDOT
// refreshes them every ten seconds, so anything faster just re-downloads a
// duplicate and burns their bandwidth.
var timers = {};
function popupHtml(c) {
  return '<div class=pop><h4>' + c.n + '</h4>' +
    '<div class=rd>' + (c.r || '') + '</div>' +
    '<a href="https://www.511pa.com/map/Cctv/' + c.m + '" target=_blank rel=noopener ' +
      'style="padding:0;border:0;background:none">' +
      '<img id="ci' + c.i + '" alt="camera"></a>' +
    '<div class=row>' +
    '<a href="https://www.google.com/maps/search/?api=1&query=' + c.a + ',' + c.o +
      '" target=_blank rel=noopener>Where is this</a>' +
    '<a href="https://www.511pa.com/" target=_blank rel=noopener>511PA</a>' +
    '<span class=age id="ca' + c.i + '">live</span>' +
    '</div></div>';
}
function startCam(c) {
  var el = document.getElementById('ci' + c.i);
  var age = document.getElementById('ca' + c.i);
  if (!el) return;
  var n = 0;
  function tick() {
    el.src = 'https://www.511pa.com/map/Cctv/' + c.m + '?t=' + Date.now();
    n++;
    if (age) age.textContent = 'live · ' + n;
  }
  el.onerror = function () {
    var p = el.parentNode;
    if (p) p.innerHTML = '<div class=dead>This camera is offline right now.</div>';
    if (timers[c.i]) { clearInterval(timers[c.i]); delete timers[c.i]; }
  };
  tick();
  timers[c.i] = setInterval(tick, 10000);
}

var camLayer = L.layerGroup();
CAMS.forEach(function (c) {
  var mk = L.circleMarker([c.a, c.o], {
    radius: 5, color: '#5cc8ff', weight: 1.6, fillColor: '#1d7fb0', fillOpacity: 0.82
  });
  mk.bindPopup(function () { return popupHtml(c); }, {maxWidth: 330, autoPan: true});
  mk.on('popupopen', function () { setTimeout(function () { startCam(c); }, 30); });
  mk.on('popupclose', function () {
    if (timers[c.i]) { clearInterval(timers[c.i]); delete timers[c.i]; }
  });
  camLayer.addLayer(mk);
});
camLayer.addTo(map);

// 1500 circles is fine on a laptop and miserable on a phone at state zoom, so
// thin them out until you are actually looking at somewhere.
function density() {
  var z = map.getZoom();
  if (z >= 9) { if (!map.hasLayer(camLayer) && camsOn) camLayer.addTo(map); return; }
  if (z < 8 && map.hasLayer(camLayer) && CAMS.length > 400) { map.removeLayer(camLayer); }
  else if (camsOn && !map.hasLayer(camLayer)) { camLayer.addTo(map); }
}
var camsOn = true;
map.on('zoomend', density);

document.getElementById('tRadar').onclick = function () {
  if (map.hasLayer(radar)) { map.removeLayer(radar); this.classList.remove('on'); }
  else { radar.addTo(map); this.classList.add('on'); }
};
document.getElementById('tCams').onclick = function () {
  camsOn = !camsOn;
  if (camsOn) { camLayer.addTo(map); this.classList.add('on'); }
  else { map.removeLayer(camLayer); this.classList.remove('on'); }
};
</script>
</body>
</html>
"""

# The NWS reflectivity ramp, roughly, for the legend strip.
RAMP = ["#04e9e7", "#019ff4", "#0300f4", "#02fd02", "#01c501", "#008e00",
        "#fdf802", "#e5bc00", "#fd9500", "#fd0000", "#d40000", "#bc0000",
        "#f800fd", "#9854c6"]


def load_cams(path):
    if not os.path.exists(path):
        sys.exit(f"no camera cache at {path} — run ground_truth.py once to build it")
    import re
    rows = json.load(open(path))
    out = []
    for r in rows:
        try:
            wkt = r["latLng"]["geography"]["wellKnownText"]
            m = re.match(r"POINT \((-?[\d.]+) (-?[\d.]+)\)", wkt)
            lat, lon = float(m.group(2)), float(m.group(1))
        except Exception:
            continue
        imgs = r.get("images") or []
        if not imgs:
            continue
        img = imgs[0]
        if img.get("disabled") or img.get("blocked"):
            continue
        out.append({
            "i": r["id"],
            "m": img["id"],
            "a": round(lat, 5),
            "o": round(lon, 5),
            "n": (r.get("location") or r.get("cameraName") or "Camera")[:80],
            "r": r.get("roadway") or "",
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--center", default="40.9,-77.6", help="lat,lon")
    ap.add_argument("--zoom", type=int, default=7)
    ap.add_argument("--cache", default=CACHE)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    lat, lon = [float(x) for x in a.center.split(",")]
    cams = load_cams(a.cache)
    os.makedirs(a.out_dir, exist_ok=True)

    html = PAGE % {
        "CAMS": json.dumps(cams, separators=(",", ":")),
        "NCAM": len(cams),
        "LAT": lat, "LON": lon, "ZOOM": a.zoom,
        "SCALE": "".join(f"<i style='background:{c}'></i>" for c in RAMP),
    }
    page = os.path.join(a.out_dir, "index.html")
    open(page, "w").write(html)

    res = {"page": page, "cameras": len(cams), "bytes": len(html),
           "next": "share.sh the out-dir; do not build the URL yourself"}
    print(json.dumps(res, indent=1) if a.json else
          f"{page}\n{len(cams)} cameras, {len(html)//1024} KB")


if __name__ == "__main__":
    sys.exit(main())
