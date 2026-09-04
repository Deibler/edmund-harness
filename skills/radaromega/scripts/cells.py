#!/usr/bin/env python3
"""The storm cell table — what the radar's own algorithm thinks each storm is doing.

Every volume scan, the NEXRAD SCIT algorithm identifies discrete cells and
publishes an attribute table: max reflectivity, VIL, echo top, hail probability
and size, tornado vortex signature, storm motion, and four forecast positions at
15-minute increments. RadarOmega mirrors it at data4.radaromega.com and never
surfaces it through a tool, so this reads the feed directly. No app required.

    cells.py                          # cells near home, nearest tower
    cells.py --tower KCCX
    cells.py --lat 40.04 --lon -76.31 --within 60
    cells.py --json

The killer field is `forecast_positions`: a real projected track, which turns
"moving east at 40" into "closest approach 3 mi at 9:27".
"""

import argparse
import json
import math
import os
import sys
import time
import urllib.request

API = "https://data4.radaromega.com/api/nexrad-attributes"
STATIONS = "https://api.weather.gov/radar/stations?stationType=WSR-88D"
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".stations.json")
CACHE_DAYS = 30
HOME = (float(os.environ.get("EDMUND_HOME_LAT", "40.0")), float(os.environ.get("EDMUND_HOME_LON", "-76.0")))  # set in .env
UA = {"User-Agent": "edmund-harness (weather ops)"}
FORECAST_STEP_MIN = 15  # SCIT publishes +15/+30/+45/+60


def get(url, timeout=25):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout))


def stations():
    if os.path.exists(CACHE) and time.time() - os.path.getmtime(CACHE) < CACHE_DAYS * 86400:
        return json.load(open(CACHE))
    out = {}
    for f in get(STATIONS)["features"]:
        lon, lat = f["geometry"]["coordinates"][:2]
        out[f["properties"]["id"]] = [lat, lon, f["properties"].get("name", "")]
    try:
        json.dump(out, open(CACHE, "w"))
    except OSError:
        pass
    return out


def haversine(a, b):
    (la1, lo1), (la2, lo2) = a, b
    p = math.pi / 180
    h = (math.sin((la2 - la1) * p / 2) ** 2
         + math.cos(la1 * p) * math.cos(la2 * p) * math.sin((lo2 - lo1) * p / 2) ** 2)
    # 2 * R * asin(sqrt(h)), R = 3959 mi. The 7918 IS the doubling; dividing by
    # two again halved every distance in the table, so a storm 124 miles out
    # read as 62 and every arrival time was twice as urgent as the truth.
    return 7918 * math.asin(math.sqrt(h))


def bearing(a, b):
    (la1, lo1), (la2, lo2) = a, b
    p = math.pi / 180
    y = math.sin((lo2 - lo1) * p) * math.cos(la2 * p)
    x = (math.cos(la1 * p) * math.sin(la2 * p)
         - math.sin(la1 * p) * math.cos(la2 * p) * math.cos((lo2 - lo1) * p))
    return (math.atan2(y, x) / p + 360) % 360


def compass(deg):
    return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW",
            "WSW", "W", "WNW", "NW", "NNW"][int((deg + 11.25) % 360 / 22.5)]


def closest_approach(target, track):
    """Walk the projected track and find where it passes nearest the target.

    track is [(minutes, lat, lon), ...] starting at 0. Segments are sampled
    rather than solved analytically — the legs are short and this keeps the
    great-circle distance honest.
    """
    best = (haversine(target, (track[0][1], track[0][2])), 0.0)
    for (m0, la0, lo0), (m1, la1, lo1) in zip(track, track[1:]):
        for k in range(1, 21):
            f = k / 20.0
            d = haversine(target, (la0 + (la1 - la0) * f, lo0 + (lo1 - lo0) * f))
            if d < best[0]:
                best = (d, m0 + (m1 - m0) * f)
    return best  # (miles, minutes from scan time)


def threat(s):
    """One word for how much this cell matters, from the attributes alone."""
    st = s.get("storm_structure") or {}
    hd = s.get("hail_data") or {}
    dbz = (s.get("intensity") or {}).get("dbz") or st.get("max_ref") or 0
    vil = st.get("cell_based_vil") or 0
    if s.get("tvs_data"):
        return "TVS"
    # Every numeric field in this feed can come back null, not just absent.
    if (hd.get("probability_severe_hail") or 0) >= 50 or (hd.get("max_expected_hail_size") or 0) >= 1.0:
        return "severe hail"
    if dbz >= 60 or vil >= 45:
        return "strong"
    if dbz >= 50 or vil >= 30:
        return "moderate"
    return "weak"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tower", help="4-letter NEXRAD site; default is nearest to the point")
    ap.add_argument("--lat", type=float, default=HOME[0])
    ap.add_argument("--lon", type=float, default=HOME[1])
    ap.add_argument("--within", type=float, default=90, help="only cells within N miles")
    ap.add_argument("--min-dbz", type=float, default=0)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    target = (a.lat, a.lon)
    sites = stations()
    order = ([a.tower.upper()] if a.tower else
             [c for c, _ in sorted(sites.items(), key=lambda kv: haversine(target, (kv[1][0], kv[1][1])))][:4])

    data = tower = None
    tried = []
    for code in order:
        try:
            files = get("%s/%s/dir.json" % (API, code))["files"]
            data, tower = get("%s/%s/%s" % (API, code, files[-1])), code
            break
        except Exception as e:  # 404 = tower not in the attribute feed
            tried.append("%s (%s)" % (code, type(e).__name__))
    if not data:
        sys.exit("no attribute table available. Tried: %s" % ", ".join(tried))

    rows = []
    for cid, s in (data.get("storms") or {}).items():
        pos = ((s.get("current_position") or {}).get("coordinates") or {})
        if "latitude" not in pos:
            continue
        here = (pos["latitude"], pos["longitude"])
        st = s.get("storm_structure") or {}
        hd = s.get("hail_data") or {}
        mv = s.get("movement") or {}
        dbz = (s.get("intensity") or {}).get("dbz") or st.get("max_ref") or 0
        dist = haversine(target, here)
        if dist > a.within or dbz < a.min_dbz:
            continue
        track = [(0.0, here[0], here[1])]
        for i, f in enumerate(s.get("forecast_positions") or []):
            # A cell forecast to leave coverage publishes a null slot; stop there
            # rather than skipping it, or the remaining legs get the wrong times.
            if not f or f.get("latitude") is None:
                break
            track.append(((i + 1) * FORECAST_STEP_MIN, f["latitude"], f["longitude"]))
        ca_mi, ca_min = closest_approach(target, track) if len(track) > 1 else (dist, 0.0)
        rows.append({
            "id": cid, "lat": here[0], "lon": here[1],
            # Where the cell IS, as seen from the target. The +180 flip that used
            # to live here answered a different question ("what direction is it
            # coming from") but printed in a slot that reads as a position, so a
            # storm to the northwest was reported as being to the southeast.
            "miles": round(dist, 1), "from": compass(bearing(target, here)),
            "bearing_from_target": round(bearing(target, here)),
            "max_dbz": dbz, "vil": st.get("cell_based_vil"),
            "echo_top_ft": st.get("cell_top_height"),
            "max_ref_height_ft": st.get("max_ref_height"),
            "hail_prob": hd.get("probability_hail"),
            "severe_hail_prob": hd.get("probability_severe_hail"),
            "max_hail_in": hd.get("max_expected_hail_size"),
            "tvs": bool(s.get("tvs_data")),
            "speed_kt": mv.get("speed"), "from_deg": mv.get("direction"),
            "closest_mi": round(ca_mi, 1), "closest_in_min": round(ca_min),
            "threat": threat(s),
        })

    rows.sort(key=lambda r: (r["closest_mi"], r["closest_in_min"]))

    if a.json:
        print(json.dumps({"tower": tower, "file_time": data.get("file_time"),
                          "target": target, "cells": rows}, indent=1))
        return

    print("%s attribute table, scan %s — %d cells within %.0f mi of %.4f,%.4f"
          % (tower, data.get("file_time"), len(rows), a.within, a.lat, a.lon))
    if not rows:
        print("  nothing tracked. Quiet, or the cells are outside the radius.")
        return
    for r in rows:
        head = "  %-3s %2.0f dBZ  VIL %-3s top %-6s  %4.1f mi %-3s  %2s kt from %03d" % (
            r["id"], r["max_dbz"], r["vil"], (str(r["echo_top_ft"]) + "ft") if r["echo_top_ft"] else "-",
            r["miles"], r["from"], r["speed_kt"] or 0, r["from_deg"] or 0)
        print(head)
        bits = ["%s" % r["threat"]]
        if r["max_hail_in"]:
            bits.append('hail to %.2f" (%d%% / %d%% severe)'
                        % (r["max_hail_in"], r["hail_prob"] or 0, r["severe_hail_prob"] or 0))
        if r["tvs"]:
            bits.append("TVS FLAGGED")
        if r["closest_mi"] <= 10 and r["closest_in_min"] > 0:
            bits.append("passes within %.1f mi in %d min" % (r["closest_mi"], r["closest_in_min"]))
        elif r["closest_mi"] < r["miles"]:
            bits.append("nearest %.1f mi in %d min" % (r["closest_mi"], r["closest_in_min"]))
        print("       " + ", ".join(bits))
    print("\n  Times are minutes from the scan, not from now — check file_time. "
          "Forecast positions are the radar algorithm's linear extrapolation; they "
          "do not know about growth, decay, or a boundary the cell is about to hit.")


if __name__ == "__main__":
    main()
