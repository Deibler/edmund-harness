#!/usr/bin/env python3
"""Fill templates/hike-brief.html from a JSON spec and inline the map image.

The map is base64-inlined so the page is a single self-contained file. That
matters because instant-share gates every request on ?key=, so a sibling
<img src="map.png"> would 403 and ship a brief with a hole where the map goes.

Usage:
    build_brief.py --spec hike.json --map map.png --out index.html

Spec shape (every field optional except trail_name / standfirst / glance):

{
  "title": "...",                       browser tab, defaults to trail_name
  "kicker": "Lancaster County - day hike",
  "dated": "Read 2026-08-02",
  "trail_name": "Kellys Run to the Pinnacle",
  "standfirst": "one or two sentences on why this one",
  "glance": [["Distance", "3.8 mi loop"], ["Climb", "about 700 ft"]],
  "map_sub": "Traced from OpenStreetMap",
  "map_caption": "...",
  "legs": [{"h": "Mile 0 to 1", "p": "field, then the gorge"}, ...],
  "access": [["Trailhead", "39.84066, -76.31640"], ...],
  "warnings": [{"lbl": "Parking", "p": "Tucquan lots closed indefinitely"}],
  "extra": [{"h": "Section heading", "sub": "...", "p": ["para", "para"]}],
  "sources": ["Lancaster Conservancy preserve page, read 2026-08-02", ...],
  "footer": "..."
}
"""

import argparse
import base64
import html
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "..", "templates", "hike-brief.html")


def esc(s):
    return html.escape(str(s), quote=False)


def rows(pairs):
    out = []
    for lbl, val in pairs:
        out.append(
            '<div class="row"><div class="lbl">%s</div><div class="val">%s</div></div>'
            % (esc(lbl), val if "<" in str(val) else esc(val))
        )
    return "".join(out)


def legs(items):
    out = []
    for i, leg in enumerate(items, 1):
        out.append(
            '<div class="item"><div class="n">%d</div><div><h3>%s</h3><p>%s</p></div></div>'
            % (i, esc(leg.get("h", "")), esc(leg.get("p", "")))
        )
    return "".join(out)


def warnings(items):
    return "".join(
        '<div class="warn"><span class="lbl">%s</span><p>%s</p></div>'
        % (esc(w.get("lbl", "Heads up")), esc(w.get("p", "")))
        for w in items
    )


def extras(items):
    out = []
    for s in items:
        paras = "".join("<p>%s</p>" % esc(p) for p in s.get("p", []))
        sub = '<p class="sub">%s</p>' % esc(s["sub"]) if s.get("sub") else ""
        out.append(
            '<section><div class="wrap"><h2>%s</h2>%s%s</div></section>'
            % (esc(s.get("h", "")), sub, paras)
        )
    return "".join(out)


def sources(items):
    return "".join("<p><b>SOURCE</b> &nbsp;%s</p>" % esc(s) for s in items)


def inline_map(path, max_width):
    """Base64 the map, downscaled to JPEG first.

    render_map.py shoots at 2x for print, which is a 7 MB PNG. Inlining that
    raw makes a 9 MB page that crawls on a phone over a Cloudflare tunnel.
    """
    try:
        from PIL import Image

        im = Image.open(path).convert("RGB")
        if im.width > max_width:
            h = round(im.height * max_width / im.width)
            im = im.resize((max_width, h), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=86, optimize=True)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        with open(path, "rb") as f:
            return "data:image/png;base64," + base64.b64encode(f.read()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--map", help="PNG from render_map.py")
    ap.add_argument("--out", required=True)
    ap.add_argument("--map-width", type=int, default=1720,
                    help="downscale the inlined map to this width")
    a = ap.parse_args()

    with open(a.spec) as f:
        spec = json.load(f)
    with open(TEMPLATE) as f:
        tpl = f.read()

    map_src = ""
    if a.map and os.path.exists(a.map):
        map_src = inline_map(a.map, a.map_width)

    name = spec.get("trail_name", "Hike")
    # Plain text from the spec gets escaped; the helpers above already emit HTML.
    fill = {
        "TITLE": esc(spec.get("title") or name),
        "KICKER": esc(spec.get("kicker", "")),
        "DATED": esc(spec.get("dated", "")),
        "TRAIL_NAME": esc(name),
        "STANDFIRST": esc(spec.get("standfirst", "")),
        "GLANCE_ROWS": rows(spec.get("glance", [])),
        "MAP_SUB": esc(spec.get("map_sub", "")),
        "MAP_IMAGE": map_src,
        "MAP_CAPTION": esc(spec.get("map_caption", "")),
        "LEGS": legs(spec.get("legs", [])),
        "ACCESS_ROWS": rows(spec.get("access", [])),
        "WARNINGS": warnings(spec.get("warnings", [])),
        "EXTRA_SECTIONS": extras(spec.get("extra", [])),
        "SOURCES": sources(spec.get("sources", [])),
        "FOOTER": esc(spec.get("footer", "")),
    }
    for k, v in fill.items():
        tpl = tpl.replace("{{%s}}" % k, v)

    left = [t for t in ("{{" + k + "}}" for k in fill) if t in tpl]
    if left:
        print(json.dumps({"ok": False, "unfilled": left}))
        return 1

    with open(a.out, "w") as f:
        f.write(tpl)
    print(json.dumps({
        "ok": True,
        "path": os.path.abspath(a.out),
        "bytes": os.path.getsize(a.out),
        "map_inlined": bool(map_src),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
