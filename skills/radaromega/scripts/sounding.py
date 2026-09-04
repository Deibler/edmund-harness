#!/usr/bin/env python3
"""The morning balloon, read for you.

Twice a day (00Z and 12Z, plus special 18Z launches on severe days) the NWS
lets go of a radiosonde at ~90 sites and it reports temperature, dewpoint and
wind every few metres on the way up. That profile is the only direct measurement
of the atmosphere the storms are actually going to grow in — radar shows what
already happened, the sounding shows what is possible.

    sounding.py                      # nearest launch to home, latest available
    sounding.py --site PIT
    sounding.py --lat 40.04 --lon -76.31 --when 00z
    sounding.py --json

Source: University of Wyoming's decoder over the BUFR feed. Note `src=BUFR`
in the URL — the older src values (GTS/UNAWIPS) return an empty page, which
looks exactly like "no launch happened" and is not.
"""

import os
import argparse
import datetime as dt
import html
import json
import math
import re
import sys
import urllib.parse
import urllib.request

HOME = (float(os.environ.get("EDMUND_HOME_LAT", "40.0")), float(os.environ.get("EDMUND_HOME_LON", "-76.0")))  # set in .env

# WMO id -> (name, lat, lon). Eastern + midwest; enough for anything east of the
# Mississippi. Add rows rather than reaching for a different data source.
SITES = {
    "IAD": (72403, "Sterling VA", 38.98, -77.49),
    "PIT": (72520, "Pittsburgh PA", 40.53, -80.23),
    "OKX": (72501, "Upton NY", 40.87, -72.86),
    "WAL": (72402, "Wallops Island VA", 37.85, -75.48),
    "ALB": (72518, "Albany NY", 42.69, -73.83),
    "BUF": (72528, "Buffalo NY", 42.94, -78.73),
    "GYX": (74389, "Gray ME", 43.89, -70.25),
    "CHH": (74494, "Chatham MA", 41.67, -69.97),
    "GSO": (72317, "Greensboro NC", 36.08, -79.95),
    "RNK": (72318, "Blacksburg VA", 37.20, -80.41),
    "ILN": (72426, "Wilmington OH", 39.42, -83.82),
    "DTX": (72632, "Detroit MI", 42.70, -83.47),
    "APX": (72634, "Gaylord MI", 44.91, -84.72),
    "ILX": (74560, "Lincoln IL", 40.15, -89.33),
    "MFL": (72202, "Miami FL", 25.75, -80.38),
    "CHS": (72208, "Charleston SC", 32.90, -80.03),
    "BNA": (72327, "Nashville TN", 36.25, -86.57),
    "JAN": (72235, "Jackson MS", 32.32, -90.08),
    "OUN": (72357, "Norman OK", 35.18, -97.44),
    "TOP": (72456, "Topeka KS", 39.07, -95.62),
}

URL = "https://weather.uwyo.edu/wsgi/sounding"


def haversine(a, b):
    (la1, lo1), (la2, lo2) = a, b
    p = math.pi / 180
    h = (math.sin((la2 - la1) * p / 2) ** 2
         + math.cos(la1 * p) * math.cos(la2 * p) * math.sin((lo2 - lo1) * p / 2) ** 2)
    return 7918 * math.asin(math.sqrt(h)) / 2  # statute miles


def nearest(lat, lon):
    return min(SITES.items(), key=lambda kv: haversine((lat, lon), (kv[1][2], kv[1][3])))


def cycles(when):
    """Launch times to try, newest first. Balloons post ~60-90 min after release."""
    now = dt.datetime.now(dt.timezone.utc)
    out = []
    t = now.replace(minute=0, second=0, microsecond=0)
    t -= dt.timedelta(hours=t.hour % 12)
    for _ in range(5):
        if when == "latest" or when == "%02dz" % t.hour:
            out.append(t)
        t -= dt.timedelta(hours=12)
    return out


def fetch(wmo, stamp):
    q = urllib.parse.urlencode({
        "datetime": stamp.strftime("%Y-%m-%d %H:%M:%S"),
        "id": wmo, "type": "TEXT:LIST", "src": "BUFR",
    })
    req = urllib.request.Request(URL + "?" + q, headers={"User-Agent": "edmund-harness"})
    body = urllib.request.urlopen(req, timeout=45).read().decode("utf-8", "replace")
    return None if "Unable to retrieve" in body else body


def parse_profile(page):
    """The fixed-width table: PRES HGHT TEMP DWPT RELH MIXR DRCT SPED ..."""
    block = re.search(r"<PRE>(.*?)</PRE>", page, re.S)
    rows = []
    for line in html.unescape(re.sub("<[^>]+>", "", block.group(1))).splitlines():
        f = line.split()
        if len(f) < 8 or not re.match(r"^-?\d+\.?\d*$", f[0]):
            continue
        try:
            rows.append({"p": float(f[0]), "z": float(f[1]), "t": float(f[2]),
                         "td": float(f[3]), "dir": float(f[6]), "spd": float(f[7])})
        except ValueError:
            continue
    return rows


def parse_indices(page):
    """Wyoming emits the derived indices as a table of name/value/unit cells."""
    i = page.find("Sounding Indices")
    if i < 0:
        return {}
    text = html.unescape(re.sub("<[^>]+>", "\n", page[i:i + 6000]))
    cells = [c.strip() for c in text.splitlines() if c.strip()]
    out = {}
    for j, c in enumerate(cells):
        if re.fullmatch(r"[A-Z]{3,8}[0-9]?", c) and j + 2 < len(cells):
            try:
                out[c] = float(cells[j + 2])
            except ValueError:
                pass
    return out


def uv(dirdeg, spd):
    r = math.radians(dirdeg)
    return -spd * math.sin(r), -spd * math.cos(r)


def shear(rows, top_m):
    """Bulk shear magnitude, surface to top_m AGL, in knots."""
    if not rows:
        return None
    sfc = rows[0]
    aloft = [r for r in rows if r["z"] - sfc["z"] <= top_m]
    if len(aloft) < 2:
        return None
    u0, v0 = uv(sfc["dir"], sfc["spd"])
    u1, v1 = uv(aloft[-1]["dir"], aloft[-1]["spd"])
    return math.hypot(u1 - u0, v1 - v0) * 1.94384


def level_height(rows, temp_c):
    for a, b in zip(rows, rows[1:]):
        if a["t"] >= temp_c >= b["t"]:
            span = a["t"] - b["t"] or 1
            return a["z"] + (a["t"] - temp_c) / span * (b["z"] - a["z"])
    return None


def lapse_700_500(rows):
    def at(p):
        return min(rows, key=lambda r: abs(r["p"] - p))
    a, b = at(700), at(500)
    dz = (b["z"] - a["z"]) / 1000.0
    return (a["t"] - b["t"]) / dz if dz else None


def read(rows, ix):
    """Plain-English lines. Only says a thing when the number supports it."""
    say = []
    cape, cin = ix.get("MUCAPE"), ix.get("MUCIN")
    if cape is not None:
        word = ("no meaningful instability" if cape < 300 else
                "weak instability" if cape < 1000 else
                "moderate instability" if cape < 2500 else
                "strong instability" if cape < 3500 else "extreme instability")
        say.append("MUCAPE %.0f, %s" % (cape, word)
                   + ("" if cin is None else ", cap %s" % (
                       "essentially none" if cin > -25 else
                       "weak" if cin > -75 else "strong, needs a trigger")))
    d = ix.get("DCAPE")
    if d is not None:
        say.append("DCAPE %.0f, %s downdraft potential — this is the damaging-gust number"
                   % (d, "low" if d < 600 else "decent" if d < 1000 else
                      "high" if d < 1400 else "very high"))
    s6, s1 = shear(rows, 6000), shear(rows, 1000)
    if s6:
        say.append("0-6 km shear %.0f kt, %s" % (s6, "storms stay disorganized" if s6 < 25 else
                   "enough for clusters and bowing lines" if s6 < 40 else "supercell-capable"))
    if s1:
        say.append("0-1 km shear %.0f kt" % s1)
    lcl = ix.get("LCLZ")
    if lcl is not None:
        say.append("LCL %.0f m, %s" % (lcl, "low cloud bases, tornado-friendlier" if lcl < 1000
                   else "high bases, favors dry downdrafts and gusts over tornadoes"))
    pw = ix.get("PWAT")
    if pw is not None:
        say.append("PWAT %.2f in, %s rainfall rates" % (pw / 25.4,
                   "modest" if pw < 30 else "efficient" if pw < 45 else "tropical, flash-flood"))
    lr = lapse_700_500(rows)
    if lr:
        say.append("700-500 mb lapse rate %.1f C/km, %s" % (lr,
                   "poor, weak updrafts" if lr < 6 else "decent" if lr < 7.5 else "steep, hail-supportive"))
    fz = level_height(rows, 0)
    if fz:
        say.append("freezing level %.0f m (%.0f ft), %s" % (fz, fz * 3.281,
                   "hail can survive the fall" if fz < 4200 else "high, hail melts on the way down"))
    if ix.get("LFVT") is not None:
        say.append("lifted index %.1f" % ix["LFVT"])
    return say


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", help="3-letter sounding site, e.g. IAD")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--when", default="latest", choices=["latest", "00z", "12z"])
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    if a.site:
        code = a.site.upper()
        if code not in SITES:
            sys.exit("unknown site %r. Known: %s" % (code, ", ".join(sorted(SITES))))
        wmo, name, slat, slon = SITES[code]
        dist = None if a.lat is None else haversine((a.lat, a.lon), (slat, slon))
    else:
        lat = HOME[0] if a.lat is None else a.lat
        lon = HOME[1] if a.lon is None else a.lon
        code, (wmo, name, slat, slon) = nearest(lat, lon)
        dist = haversine((lat, lon), (slat, slon))

    page = stamp = None
    for c in cycles(a.when):
        page = fetch(wmo, c)
        if page:
            stamp = c
            break
    if not page:
        sys.exit("no %s sounding available for %s yet (checked the last 5 cycles). "
                 "12Z data posts around 13:30Z." % (a.when, code))

    rows, ix = parse_profile(page), parse_indices(page)
    ix["SHEAR6KM"] = shear(rows, 6000)
    ix["SHEAR1KM"] = shear(rows, 1000)
    ix["LAPSE700500"] = lapse_700_500(rows)
    ix["FRZLVL_M"] = level_height(rows, 0)

    if a.json:
        print(json.dumps({"site": code, "name": name, "wmo": wmo,
                          "valid": stamp.strftime("%Y-%m-%dT%H:%MZ"),
                          "levels": len(rows), "indices": ix,
                          "reading": read(rows, ix)}, indent=1))
        return

    head = "%s (%s) %sZ balloon" % (code, name, stamp.strftime("%m/%d %H"))
    if dist:
        head += " — %.0f mi from the point you asked about" % dist
    print(head)
    print("-" * len(head))
    for line in read(rows, ix):
        print("  " + line)
    print("\n  %d levels in the profile. Nearest launches: %s" % (
        len(rows), ", ".join(sorted(SITES))))


if __name__ == "__main__":
    main()
