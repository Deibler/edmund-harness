#!/usr/bin/env python3
"""Resolve a named trail to real route geometry, or say honestly that it couldn't.

Three tiers, best first. Never invents a path.

  1. Waymarked Trails  - route relations from OSM, served as per-way geometry.
                         Fast and reliable. Covers blazed/named routes
                         (Conestoga Trail System, Appalachian Trail, Horse-Shoe).
  2. Overpass          - named ways inside a bbox. Covers park loops that aren't
                         route relations. Frequently 504s, so it is tier 2 and
                         every mirror gets a short leash.
  3. Nothing           - returns traced=False. The caller must then render the
                         hiking-overlay tiles instead and SAY the route is not
                         traced. A wrong line on a map gets somebody lost.

Usage:
    trail_geometry.py --name "Conestoga Trail" --lat 39.84066 --lon -76.31640 \
        --out route.geojson
    trail_geometry.py --name "Boone Trail" --lat 40.19824 --lon -75.79285 \
        --radius-km 4 --out route.geojson

Writes GeoJSON (WGS84) and prints a one-line JSON summary to stdout.
"""

import argparse
import json
import math
import sys
import urllib.parse
import urllib.request

UA = "edmund-hike-skill/1.0 (personal trail mapping)"
WMT = "https://hiking.waymarkedtrails.org/api/v1"
OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]


def get(url, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def merc_to_wgs(x, y):
    """EPSG:3857 -> EPSG:4326. Waymarked Trails serves Web Mercator metres."""
    lon = x / 20037508.34 * 180.0
    lat = y / 20037508.34 * 180.0
    lat = 180.0 / math.pi * (2.0 * math.atan(math.exp(lat * math.pi / 180.0)) - math.pi / 2.0)
    return lon, lat


def haversine_km(a_lat, a_lon, b_lat, b_lon):
    r = 6371.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = math.radians(b_lat - a_lat)
    dl = math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def clip_near(segments, lat, lon, radius_km):
    """Keep only the parts of a long trail that are actually near the trailhead.

    The Conestoga is 63 miles. Rendering all of it to show a 10 mile day hike
    makes a map nobody can read.
    """
    if not (lat and lon and radius_km):
        return segments
    kept = []
    for seg in segments:
        run = []
        for pt in seg:
            if haversine_km(lat, lon, pt[1], pt[0]) <= radius_km:
                run.append(pt)
            elif len(run) > 1:
                kept.append(run)
                run = []
            else:
                run = []
        if len(run) > 1:
            kept.append(run)
    return kept or segments


def from_waymarked(name, lat, lon, radius_km):
    q = urllib.parse.urlencode({"query": name, "limit": 8})
    try:
        hits = get(f"{WMT}/list/search?{q}", timeout=30).get("results", [])
    except Exception as e:
        return None, f"waymarked search failed: {e}"
    if not hits:
        return None, "waymarked: no matching route relation"

    for hit in hits:
        if hit.get("type") != "relation":
            continue
        rid = hit["id"]
        try:
            det = get(f"{WMT}/details/relation/{rid}", timeout=60)
        except Exception:
            continue
        segments = []
        for part in det.get("route", {}).get("main", []):
            for way in part.get("ways", []):
                geom = way.get("geometry") or {}
                if geom.get("type") != "LineString":
                    continue
                segments.append([list(merc_to_wgs(x, y)) for x, y in geom["coordinates"]])
        if not segments:
            continue
        clipped = clip_near(segments, lat, lon, radius_km)
        return {
            "segments": clipped,
            "source": "Waymarked Trails (OpenStreetMap route relation)",
            "route_name": det.get("name") or hit.get("name"),
            "osm_relation": rid,
            "blazes": det.get("symbol_description"),
            "clipped": len(clipped) != len(segments),
        }, None
    return None, "waymarked: relations found but none carried geometry"


def from_overpass(name, lat, lon, radius_km):
    if not (lat and lon):
        return None, "overpass: needs a trailhead coordinate"
    d = radius_km / 111.0
    bbox = f"{lat - d},{lon - d * 1.3},{lat + d},{lon + d * 1.3}"
    # Match on a distinctive prefix so "Kellys" also catches "Kelly's Run Trail".
    stem = name.split()[0].rstrip("'s").rstrip("s")
    body = (
        f'[out:json][timeout:40];'
        f'way["highway"~"path|footway|track|bridleway"]["name"~"{stem}",i]({bbox});'
        f"out geom;"
    )
    payload = urllib.parse.urlencode({"data": body}).encode()
    errors = []
    for mirror in OVERPASS_MIRRORS:
        try:
            req = urllib.request.Request(mirror, payload, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=50) as r:
                j = json.load(r)
        except Exception as e:
            errors.append(f"{mirror.split('/')[2]}: {e}")
            continue
        segments = [
            [[p["lon"], p["lat"]] for p in el.get("geometry", [])]
            for el in j.get("elements", [])
            if len(el.get("geometry", [])) > 1
        ]
        if segments:
            return {
                "segments": segments,
                "source": f"OpenStreetMap via Overpass ({mirror.split('/')[2]})",
                "route_name": name,
                "osm_relation": None,
                "blazes": None,
                "clipped": False,
            }, None
        errors.append(f"{mirror.split('/')[2]}: no named ways in bbox")
    return None, "overpass: " + "; ".join(errors)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--radius-km", type=float, default=6.0)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    notes = []
    result, err = from_waymarked(a.name, a.lat, a.lon, a.radius_km)
    if err:
        notes.append(err)
    if not result:
        result, err = from_overpass(a.name, a.lat, a.lon, a.radius_km)
        if err:
            notes.append(err)

    if not result:
        summary = {"traced": False, "notes": notes}
        with open(a.out, "w") as f:
            json.dump({"type": "FeatureCollection", "features": []}, f)
        print(json.dumps(summary))
        return 0

    feature = {
        "type": "Feature",
        "geometry": {"type": "MultiLineString", "coordinates": result["segments"]},
        "properties": {
            "name": result["route_name"],
            "source": result["source"],
            "blazes": result["blazes"],
            "osm_relation": result["osm_relation"],
        },
    }
    with open(a.out, "w") as f:
        json.dump({"type": "FeatureCollection", "features": [feature]}, f)

    pts = sum(len(s) for s in result["segments"])
    print(json.dumps({
        "traced": True,
        "segments": len(result["segments"]),
        "points": pts,
        "source": result["source"],
        "route_name": result["route_name"],
        "blazes": result["blazes"],
        "clipped_to_radius_km": a.radius_km if result["clipped"] else None,
        "notes": notes,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
