#!/usr/bin/env python3
"""What is actually happening on the ground, as opposed to what the radar thinks.

Radar measures a volume of air a mile or two above your head and infers the rest.
Everything in here is a direct observation instead: somebody's eyes, a highway
camera, a rain gauge, a snapped power pole. When the radar says 60 dBZ and the
storm reports say trees down two towns over, the reports win.

    ground_truth.py                        # everything within 45 km of home
    ground_truth.py --lat 40.04 --lon -76.31 --within 30 --hours 3
    ground_truth.py --cams 4 --save-cams out/     # download the camera stills
    ground_truth.py --json

Sources, all keyless and public:
  LSR      NWS Local Storm Reports via the Iowa Environmental Mesonet. Spotter,
           trained-observer and public reports of wind damage, hail, flooding,
           with the remark text. This is the closest thing to "what did people
           actually see" that exists as structured data.
  METAR    Airport observations. Real measured wind gust, visibility and present
           weather at a fixed point, updated hourly and on significant change.
  CAMS     PennDOT 511PA traffic cameras, 1500 of them statewide. A 320x240 JPEG
           of an actual road, which answers "is it raining there yet" and "is the
           road flooded" in a way no product can.
  SKYCAM   Alex's own all-sky camera through the SkyStream backend, when it is
           on the network. 4K, looking straight up.

Deliberately NOT here, because they do not work rather than because I skipped them:
X/Twitter search needs a logged-in session and its public search is JS-gated;
Facebook returns 404 to anything unauthenticated; Bluesky's public API refuses
this IP; mPING wants an API key. If you want social ground truth, LSRs are the
real substitute and they are better sourced anyway.
"""

import argparse
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request

HOME = (float(os.environ.get("EDMUND_HOME_LAT", "40.0")), float(os.environ.get("EDMUND_HOME_LON", "-76.0")))  # set in .env
UA = {"User-Agent": "edmund-harness (weather ops)"}
BROWSER_UA = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.511pa.com/"}

LSR = "https://mesonet.agron.iastate.edu/geojson/lsr.geojson?states={states}&hours={hours}"
CAMS = "https://www.511pa.com/List/GetData/Cameras?query={q}&lang=en"
CAM_IMG = "https://www.511pa.com/map/Cctv/{id}"
METAR = "https://aviationweather.gov/api/data/metar?ids={ids}&format=json&hours=2"
SKYCAM = "http://127.0.0.1:8080/api/camera/snapshot"

# Airports that actually matter for Lancaster County weather.
NEARBY_METAR = ["KLNS", "KMDT", "KTHV", "KRDG", "KPHL", "KILG"]


def km(a, b):
    R = 6371.0088
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    return 2 * R * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


def bearing(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dl = math.radians(b[1] - a[1])
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return round((math.degrees(math.atan2(y, x)) + 360) % 360)


def compass(deg):
    pts = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return pts[round(deg / 22.5) % 16]


def get_json(url, headers=UA, timeout=30):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout))


def storm_reports(ref, within, hours, states):
    try:
        d = get_json(LSR.format(states=states, hours=hours))
    except Exception as e:
        return [], f"LSR fetch failed: {e}"
    out = []
    for f in d.get("features", []):
        p = f["properties"]
        try:
            lon, lat = f["geometry"]["coordinates"][:2]
        except Exception:
            continue
        dist = km(ref, (lat, lon))
        if dist > within:
            continue
        out.append({
            "valid": p.get("valid"),
            "type": p.get("typetext"),
            "magnitude": p.get("magnitude"),
            "unit": p.get("unit"),
            "where": f"{p.get('city')}, {p.get('st')}",
            "source": p.get("source"),
            "remark": (p.get("remark") or "").strip(),
            "km": round(dist, 1),
            "dir": compass(bearing(ref, (lat, lon))),
            "lat": lat, "lon": lon,
        })
    out.sort(key=lambda r: r["valid"] or "", reverse=True)
    return out, None


def metars(ids):
    try:
        d = get_json(METAR.format(ids=",".join(ids)))
    except Exception as e:
        return [], f"METAR fetch failed: {e}"
    seen, out = set(), []
    for m in d if isinstance(d, list) else []:
        sid = m.get("icaoId")
        if sid in seen:
            continue
        seen.add(sid)
        out.append({
            "station": sid,
            "time": m.get("reportTime"),
            "wind_kt": m.get("wspd"),
            "gust_kt": m.get("wgst"),
            "visibility": m.get("visib"),
            "weather": m.get("wxString"),
            "temp_c": m.get("temp"),
            "raw": m.get("rawOb"),
        })
    return out, None


def all_cameras(cache_path, max_age_h=24):
    """The camera list is 1500 rows and changes rarely; the images are live."""
    if os.path.exists(cache_path) and time.time() - os.path.getmtime(cache_path) < max_age_h * 3600:
        return json.load(open(cache_path))
    rows = []
    for start in range(0, 1600, 100):
        q = urllib.parse.quote(json.dumps({"columns": [], "order": [], "start": start, "length": 100}))
        try:
            d = get_json(CAMS.format(q=q), headers={**BROWSER_UA, "X-Requested-With": "XMLHttpRequest"})
        except Exception:
            break
        page = d.get("data") or []
        if not page:
            break
        rows += page
        time.sleep(0.12)
    if rows:
        json.dump(rows, open(cache_path, "w"))
    return rows


def cameras_near(ref, within, limit, cache_path):
    rows = all_cameras(cache_path)
    out = []
    for r in rows:
        try:
            wkt = r["latLng"]["geography"]["wellKnownText"]
            m = re.match(r"POINT \((-?[\d.]+) (-?[\d.]+)\)", wkt)
            lat, lon = float(m.group(2)), float(m.group(1))
        except Exception:
            continue
        d = km(ref, (lat, lon))
        if d > within:
            continue
        imgs = r.get("images") or []
        if not imgs:
            continue
        out.append({
            "id": r["id"],
            "km": round(d, 1),
            "dir": compass(bearing(ref, (lat, lon))),
            "road": r.get("roadway"),
            "location": r.get("location"),
            "lat": lat, "lon": lon,
            "url": CAM_IMG.format(id=imgs[0]["id"]),
        })
    out.sort(key=lambda c: c["km"])
    return out[:limit]


def fetch_cam(cam, outdir):
    os.makedirs(outdir, exist_ok=True)
    path = os.path.join(outdir, f"cam-{cam['id']}-{cam['km']}km.jpg")
    try:
        req = urllib.request.Request(cam["url"], headers=BROWSER_UA)
        data = urllib.request.urlopen(req, timeout=25).read()
        # An offline camera answers 200 with an HTML placeholder, which would
        # save happily and then fail to open as an image much later.
        if not data.startswith(b"\xff\xd8"):
            return None
        open(path, "wb").write(data)
        return path
    except Exception:
        return None


def skycam(outdir):
    try:
        data = urllib.request.urlopen(SKYCAM, timeout=15).read()
        if not data.startswith(b"\xff\xd8"):
            return None
        os.makedirs(outdir, exist_ok=True)
        path = os.path.join(outdir, "skycam.jpg")
        open(path, "wb").write(data)
        return path
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lat", type=float, default=HOME[0])
    ap.add_argument("--lon", type=float, default=HOME[1])
    ap.add_argument("--within", type=float, default=45, help="km")
    ap.add_argument("--hours", type=int, default=6, help="how far back to pull storm reports")
    ap.add_argument("--states", default="PA,MD,NJ,DE")
    ap.add_argument("--cams", type=int, default=6, help="how many nearby cameras to list")
    ap.add_argument("--save-cams", default=None, help="download the camera stills into this dir")
    ap.add_argument("--skycam", action="store_true", help="also grab the all-sky camera")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    ref = (a.lat, a.lon)
    here = os.path.dirname(os.path.abspath(__file__))
    reports, lsr_err = storm_reports(ref, a.within, a.hours, a.states)
    obs, metar_err = metars(NEARBY_METAR)
    cams = cameras_near(ref, a.within, a.cams, os.path.join(here, ".cams511.json"))

    saved = []
    if a.save_cams:
        for c in cams:
            p = fetch_cam(c, a.save_cams)
            if p:
                c["file"] = p
                saved.append(p)
        if a.skycam:
            p = skycam(a.save_cams)
            if p:
                saved.append(p)

    result = {
        "ref": {"lat": a.lat, "lon": a.lon},
        "within_km": a.within,
        "storm_reports": reports,
        "metars": obs,
        "cameras": cams,
        "saved": saved,
        "errors": [e for e in (lsr_err, metar_err) if e],
        "unavailable": "X/Twitter (login-gated), Facebook (404), Bluesky (IP blocked), mPING (needs key)",
    }

    if a.json:
        print(json.dumps(result, indent=1))
        return

    print(f"Ground truth within {a.within:.0f} km of {a.lat:.4f}, {a.lon:.4f}\n")
    print(f"STORM REPORTS (last {a.hours}h): {len(reports)}")
    for r in reports[:12]:
        mag = f" {r['magnitude']}{r['unit'] or ''}" if r["magnitude"] else ""
        print(f"  {r['valid'][11:16]}Z  {r['type']}{mag}  {r['km']} km {r['dir']}  {r['where']}")
        if r["remark"]:
            print(f"           {r['remark'][:96]}")
    if not reports:
        print("  none — nothing has been reported on the ground yet")
    print(f"\nAIRPORT OBS:")
    for o in obs:
        g = f", gust {o['gust_kt']} kt" if o.get("gust_kt") else ""
        print(f"  {o['station']}  wind {o.get('wind_kt')} kt{g}  vis {o.get('visibility')}  {o.get('weather') or ''}")
    print(f"\nCAMERAS: {len(cams)}")
    for c in cams:
        print(f"  {c['km']} km {c['dir']}  {c['road']}  {c['location'][:52]}")
        if c.get("file"):
            print(f"           {c['file']}")
    if result["errors"]:
        print("\nerrors: " + "; ".join(result["errors"]))


if __name__ == "__main__":
    sys.exit(main())
