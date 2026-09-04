#!/usr/bin/env python3
"""One storm, interrogated across every product that matters, on one sheet.

A single reflectivity picture answers one question: where is the rain. It cannot
tell you whether the storm is rotating, whether the bright core is hail or just
heavy rain, how deep the updraft is, or whether there is debris in the air. Those
live in the velocity, dual-pol and derived products, and flipping through them one
screenshot at a time is both slow and impossible to compare.

This drives the Radar Omega MCP over stdio, captures the SAME view across a list
of products, and tiles them into one labeled sheet with the plain-English meaning
of each panel burned in. Same tower, same frame, same minute, so the panels are
actually comparable.

    panel.py --lat <lat> --lon <lon> --radius 60
    panel.py --products HRF,HVL,CC,DVIL --site KDIX
    panel.py --lat 40.04 --lon -76.31 --radius 40 --out storm.jpg

Defaults to the severe-interrogation set. The framing is solved with fit_view off
the strongest cores it finds, not a guessed zoom, so the storm fills the sheet.

Panels are captured in sequence over ~6s each, so a six-panel sheet takes about a
minute. That is the cost of real data; do not run it for a drizzle question.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time

from PIL import Image, ImageDraw, ImageFont

SERVER = os.environ.get(
    "RADAROMEGA_MCP_SERVER",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "vendor", "radaromega-mcp", "dist", "index.js"),
)
HOME = (float(os.environ.get("EDMUND_HOME_LAT", "40.0")), float(os.environ.get("EDMUND_HOME_LON", "-76.0")))  # set in .env

# What each product actually tells you. The gloss is the point — a panel labeled
# "CC" teaches nobody anything, a panel labeled "is it debris or is it rain"
# turns the sheet into something you can read without a meteorology degree.
#
# Codes are the app's own, and they are NOT the ones you would guess: correlation
# coefficient is HCC not CC, differential reflectivity is DRF not ZDR, storm-relative
# velocity is HSV not SRM, spectrum width is HSW not SW, and there is no DVIL.
# change_radar_product validates against the live selector and will list the real
# ones back at you if a code is wrong.
PRODUCTS = {
    "HRF": ("Reflectivity", "how much is up there, dBZ. Big numbers can be hail, not rain."),
    "HVL": ("Velocity", "toward the radar vs away, m/s. Red beside green is rotation."),
    "HSV": ("Storm-relative velocity", "same, with the storm's own motion subtracted."),
    "HCC": ("Correlation coefficient", "are the targets uniform. A low blob inside rain is debris."),
    "DRF": ("Differential reflectivity", "flat drops vs round stones. Near zero in big echo means hail."),
    "KDP": ("Specific differential phase", "liquid water content. The real rain-rate signal."),
    "VIL": ("Vertically integrated liquid", "mass of water suspended aloft. The hail-loading number."),
    "ETP": ("Echo tops", "how tall the storm is. Rising tops mean a strengthening updraft."),
    "HCA": ("Hydrometeor class", "the radar's own guess at rain vs hail vs debris."),
    "HSW": ("Spectrum width", "how chaotic the motion is inside the beam. Turbulence."),
    "STP": ("Storm total precip", "how much has already fallen. The flooding picture."),
    "OST": ("One-hour total", "rain in the last hour."),
    "DAA": ("Accumulation array", "gridded rainfall accumulation."),
    "WINTER_EXP": ("Winter radar", "snow/sleet/freezing rain separation."),
}

DEFAULT_SET = ["HRF", "HVL", "HCC", "VIL", "ETP", "HCA"]

FONT_BOLD = "/System/Library/Fonts/Avenir Next Condensed.ttc"
FONT_IDX_HEAVY = 8


class MCP:
    """Minimal stdio JSON-RPC client for the radaromega MCP server."""

    def __init__(self, server=SERVER):
        self.p = subprocess.Popen(
            ["node", server],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        self._id = 0
        self._rpc(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "panel.py", "version": "1.0"},
            },
        )
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.p.stdin.flush()

    def _rpc(self, method, params, timeout=180):
        self._id += 1
        mid = self._id
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": mid, "method": method, "params": params}) + "\n")
        self.p.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError("MCP server closed the pipe")
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("id") == mid:
                return msg
        raise TimeoutError(f"{method} timed out")

    def call(self, tool, args=None):
        msg = self._rpc("tools/call", {"name": tool, "arguments": args or {}})
        if "error" in msg:
            raise RuntimeError(msg["error"])
        parts = [c.get("text", "") for c in msg["result"].get("content", []) if c.get("type") == "text"]
        raw = "\n".join(parts)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw

    def close(self):
        try:
            self.p.terminate()
        except Exception:
            pass


def capture_path(mcp, settle_ms):
    """capture_view answers in prose; the path is the only part we want."""
    out = mcp.call("capture_view", {"settle_ms": settle_ms})
    m = re.search(r"(/\S+\.jpg)", out if isinstance(out, str) else json.dumps(out))
    if not m:
        raise RuntimeError(f"no capture path in: {str(out)[:200]}")
    return m.group(1)


def compose(shots, header, out_path, columns=2):
    """Tile the captures with a title bar and a caption strip under each panel."""
    if not shots:
        raise RuntimeError("nothing captured")
    tile_w = 900
    imgs = []
    for code, path in shots:
        im = Image.open(path).convert("RGB")
        im = im.resize((tile_w, round(im.height * tile_w / im.width)), Image.LANCZOS)
        imgs.append((code, im))
    tile_h = max(im.height for _, im in imgs)

    cap_h, head_h, pad = 74, 96, 10
    rows = (len(imgs) + columns - 1) // columns
    W = columns * tile_w + (columns + 1) * pad
    H = head_h + rows * (tile_h + cap_h + pad) + pad

    sheet = Image.new("RGB", (W, H), (14, 16, 20))
    d = ImageDraw.Draw(sheet)
    f_title = ImageFont.truetype(FONT_BOLD, 40, index=FONT_IDX_HEAVY)
    f_sub = ImageFont.truetype(FONT_BOLD, 25, index=FONT_IDX_HEAVY)
    f_name = ImageFont.truetype(FONT_BOLD, 31, index=FONT_IDX_HEAVY)
    f_gloss = ImageFont.truetype(FONT_BOLD, 24, index=FONT_IDX_HEAVY)

    d.text((pad + 6, 18), header["title"], font=f_title, fill=(238, 240, 245))
    d.text((pad + 6, 62), header["sub"], font=f_sub, fill=(140, 148, 162))

    for i, (code, im) in enumerate(imgs):
        r, c = divmod(i, columns)
        x = pad + c * (tile_w + pad)
        y = head_h + r * (tile_h + cap_h + pad)
        sheet.paste(im, (x, y))
        name, gloss = PRODUCTS.get(code, (code, ""))
        d.rectangle([x, y + im.height, x + tile_w, y + im.height + cap_h], fill=(24, 27, 33))
        d.rectangle([x, y + im.height, x + 5, y + im.height + cap_h], fill=(214, 62, 62))
        d.text((x + 18, y + im.height + 9), f"{name}  ({code})", font=f_name, fill=(238, 240, 245))
        d.text((x + 18, y + im.height + 43), gloss, font=f_gloss, fill=(146, 154, 168))

    sheet.save(out_path, quality=92)
    return out_path, sheet.size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lat", type=float, default=HOME[0])
    ap.add_argument("--lon", type=float, default=HOME[1])
    ap.add_argument("--radius", type=float, default=60, help="km to search for cores when auto-framing")
    ap.add_argument("--products", default=",".join(DEFAULT_SET))
    ap.add_argument("--site", default=None, help="force a tower, e.g. KDIX")
    ap.add_argument("--settle", type=int, default=5000, help="ms to let tiles draw after a product switch")
    ap.add_argument("--columns", type=int, default=2)
    ap.add_argument("--no-frame", action="store_true", help="keep the current view instead of auto-framing")
    ap.add_argument("--keep-drawings", action="store_true", help="leave existing markers/lines on the map")
    ap.add_argument("--out", default=None)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    codes = [c.strip().upper() for c in a.products.split(",") if c.strip()]
    mcp = MCP()
    notes = []
    try:
        if not a.keep_drawings:
            # Markers from an earlier run get burned into every panel, and a stale
            # "62 dBZ" label sitting on a now-empty sky is worse than no label.
            mcp.call("clear_drawings", {})

        if a.site:
            mcp.call("change_radar_site", {"siteCode": a.site})
            time.sleep(3)

        # Frame on the storms, not on a guessed zoom.
        if not a.no_frame:
            mcp.call("change_radar_product", {"product": "HRF"})
            time.sleep(3)
            scan = mcp.call(
                "scan_radar_field",
                {"lat": a.lat, "lon": a.lon, "radius_km": a.radius, "threshold": 40, "limit": 6},
            )
            pts = [{"lat": h["lat"], "lon": h["lon"]} for h in scan.get("features", [])]
            pts.append({"lat": a.lat, "lon": a.lon})
            mcp.call("fit_view", {"points": pts, "padding_px": 80})
            if not scan.get("features"):
                notes.append("no echo over 40 dBZ in range; framed on the point alone")

        probe = mcp.call("sample_radar_values", {"points": [{"label": "ref", "lat": a.lat, "lon": a.lon}]})
        sw = probe.get("sweep", {})

        shots = []
        for code in codes:
            res = mcp.call("change_radar_product", {"product": code})
            if isinstance(res, dict) and res.get("error"):
                notes.append(f"{code}: {res['error']}")
                continue
            shots.append((code, capture_path(mcp, a.settle)))

        stamp = time.strftime("%Y%m%d-%H%M%S")
        out = a.out or os.path.join(os.environ.get("EDMUND_SANDBOX_PATH", "."), f"panel-{stamp}.jpg")
        def field(key, fmt="{}"):
            v = sw.get(key)
            return fmt.format(v) if v is not None else None

        bits = [
            field("scan", "{}Z"),
            field("elevation_deg", "{}° tilt"),
            field("vcp", "VCP {}"),
            f"framed on {a.lat:.4f}, {a.lon:.4f}",
        ]
        header = {
            "title": f"{sw.get('tower','?')} storm interrogation",
            "sub": "  ·  ".join(b for b in bits if b),
        }
        path, size = compose(shots, header, out, columns=a.columns)

        result = {
            "sheet": path,
            "size": list(size),
            "panels": [c for c, _ in shots],
            "sweep": sw,
            "notes": notes,
        }
        print(json.dumps(result, indent=1) if a.json else
              f"{path}\n{len(shots)} panels: {', '.join(c for c, _ in shots)}\n"
              f"{sw.get('tower')} {sw.get('scan')}Z"
              + ("\nnotes: " + "; ".join(notes) if notes else ""))
    finally:
        mcp.close()


if __name__ == "__main__":
    sys.exit(main())
