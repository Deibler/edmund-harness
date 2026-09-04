#!/usr/bin/env python3
"""The storm report, written the way an agency writes one.

A text bubble with a radar picture answers "is it raining". It does not answer
what is coming, when it gets here, how confident anyone is, or what has already
happened to people upwind. Forecast offices solve this with a standard product:
a headline, the threat broken out by type, the timing, the evidence, and the
ground truth. This builds that as a page.

    report.py --lat <lat> --lon <lon> --place "<town>"
    report.py --panel panel.jpg --loop loop.mp4 --out-dir artifact_abc123
    report.py --json

What it assembles, all live:
  headline     the worst active warning, or the outlook if nothing is warned
  threat       SPC categorical + tornado/wind/hail probabilities at the point
  timing       SCIT cell tracks -> closest approach and ETA to the point
  radar        the strongest cores with beam heights, so aloft reads as aloft
  discussion   SPC mesoscale discussions covering the point, watch odds
  ground truth storm reports, airport obs, roadside cameras, the all-sky cam
  media        the interrogation panel and the radar loop, if you pass them

It writes a self-contained directory. Hand that to instant-share's share.sh and
let that script mint and verify the URL. Never build the link yourself.
"""

import argparse
import datetime as dt
import html
import json
import os
import shutil
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = (float(os.environ.get("EDMUND_HOME_LAT", "40.0")), float(os.environ.get("EDMUND_HOME_LON", "-76.0")))  # set in .env
UA = {"User-Agent": "edmund-harness (weather ops)"}

SEVERITY = ["Tornado Warning", "Severe Thunderstorm Warning", "Flash Flood Warning",
            "Tornado Watch", "Severe Thunderstorm Watch", "Flood Warning",
            "Special Weather Statement"]
CATEGORY_NAME = {"TSTM": "General thunderstorms", "MRGL": "Marginal risk", "SLGT": "Slight risk",
                 "ENH": "Enhanced risk", "MDT": "Moderate risk", "HIGH": "High risk"}


def run_json(script, args):
    """Reuse the sibling scripts rather than reimplementing their sources."""
    try:
        out = subprocess.run(
            [sys.executable, os.path.join(HERE, script)] + args + ["--json"],
            capture_output=True, text=True, timeout=300,
        )
        if out.returncode != 0:
            return None, f"{script}: {out.stderr.strip()[:200]}"
        return json.loads(out.stdout), None
    except Exception as e:
        return None, f"{script}: {e}"


def mcp_call(tool, args):
    """One-shot MCP call, for the app-cache reads that have no CLI."""
    node = shutil.which("node") or "node"
    server = os.environ.get(
        "RADAROMEGA_MCP_SERVER",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "vendor", "radaromega-mcp", "dist", "index.js"),
    )
    script = f"""
const {{spawn}} = require('child_process');
const p = spawn({json.dumps(node)}, [{json.dumps(server)}], {{stdio:['pipe','pipe','ignore']}});
let b='', id=0; const w=new Map();
p.stdout.on('data', c => {{ b+=c; let n;
  while ((n=b.indexOf('\\n'))>=0) {{ const l=b.slice(0,n).trim(); b=b.slice(n+1);
    if(!l) continue; let m; try {{ m=JSON.parse(l); }} catch {{ continue; }}
    const f=w.get(m.id); if(f) {{ w.delete(m.id); f(m); }} }} }});
const rpc=(method,params)=>new Promise(r=>{{const i=++id; w.set(i,r);
  p.stdin.write(JSON.stringify({{jsonrpc:'2.0',id:i,method,params}})+'\\n');}});
(async()=>{{
  await rpc('initialize',{{protocolVersion:'2024-11-05',capabilities:{{}},clientInfo:{{name:'r',version:'1'}}}});
  p.stdin.write(JSON.stringify({{jsonrpc:'2.0',method:'notifications/initialized'}})+'\\n');
  const res=await rpc('tools/call',{{name:{json.dumps(tool)},arguments:{json.dumps(args)}}});
  const t=(res.result&&res.result.content||[]).map(x=>x.text).join('\\n');
  console.log(t); p.kill(); process.exit(0);
}})();
"""
    try:
        out = subprocess.run([node, "-e", script], capture_output=True, text=True, timeout=120)
        return json.loads(out.stdout)
    except Exception:
        return None


def active_alerts(lat, lon):
    url = f"https://api.weather.gov/alerts/active?point={lat},{lon}"
    try:
        d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25))
    except Exception:
        return []
    out = []
    for f in d.get("features", []):
        p = f["properties"]
        out.append({
            "event": p.get("event"), "severity": p.get("severity"),
            "headline": (p.get("headline") or "").strip(),
            "expires": p.get("expires"), "sent": p.get("sent"),
            "description": (p.get("description") or "").strip(),
            "instruction": (p.get("instruction") or "").strip(),
            "areaDesc": p.get("areaDesc"),
        })
    out.sort(key=lambda a: SEVERITY.index(a["event"]) if a["event"] in SEVERITY else 99)
    return out


def zulu_to_local(s):
    if not s:
        return ""
    try:
        t = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        return t.astimezone().strftime("%-I:%M %p")
    except Exception:
        return s


# ── page ────────────────────────────────────────────────────────────────
CSS = """
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f1115;color:#e8eaef;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
     -webkit-text-size-adjust:100%}
.wrap{max-width:820px;margin:0 auto;padding:22px 18px 70px}
header{border-bottom:2px solid #2a2f3a;padding-bottom:14px;margin-bottom:22px}
.kicker{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#8b93a3;font-weight:700}
h1{font-size:27px;line-height:1.18;margin:7px 0 6px;font-weight:750;letter-spacing:-.01em}
.stamp{font-size:13px;color:#8b93a3;font-variant-numeric:tabular-nums}
.alert{border-left:5px solid #d63e3e;background:#1d1416;padding:14px 16px;border-radius:0 6px 6px 0;margin:18px 0}
.alert.watch{border-color:#d9922b;background:#1d1a12}
.alert.calm{border-color:#3f8a55;background:#121a15}
.alert h2{font-size:18px;margin-bottom:5px;font-weight:700}
.alert p{font-size:14.5px;color:#c3c9d6}
section{margin:30px 0}
h3{font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:#8b93a3;font-weight:700;
   border-bottom:1px solid #262b35;padding-bottom:7px;margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:14.5px}
td,th{padding:8px 10px 8px 0;text-align:left;vertical-align:top;border-bottom:1px solid #1d222b}
th{color:#8b93a3;font-weight:600;font-size:12.5px;text-transform:uppercase;letter-spacing:.05em}
.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum";white-space:nowrap}
.big{font-size:19px;font-weight:700}
figure{margin:16px 0}
figure img,figure video{width:100%;border-radius:7px;display:block;background:#000}
figcaption{font-size:13px;color:#8b93a3;margin-top:7px;line-height:1.45}
.cams{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:11px}
.cams figure{margin:0}
.cams img{border-radius:5px}
.rep{padding:11px 0;border-bottom:1px solid #1d222b}
.rep .t{font-size:13px;color:#8b93a3;font-variant-numeric:tabular-nums}
.rep .w{font-weight:650;font-size:15px;margin:2px 0}
.rep .r{font-size:14px;color:#aeb5c3}
.pill{display:inline-block;padding:2px 9px;border-radius:11px;font-size:12px;font-weight:700;
      background:#262b35;color:#c3c9d6;margin-right:6px}
.pill.hot{background:#4a1d1f;color:#ff9a9a}
.pill.warm{background:#463317;color:#ffca7a}
.aloft{color:#8b93a3;font-size:13px}
footer{margin-top:44px;padding-top:16px;border-top:1px solid #262b35;font-size:12.5px;color:#6d7484;line-height:1.6}
.none{color:#6d7484;font-size:14.5px;font-style:italic}
@media(max-width:520px){h1{font-size:23px}.wrap{padding:16px 13px 60px}}
"""

# The artifact server demands ?key= on every request, images included, so the
# markup carries data-src and this rewrites it once the key is known from the URL.
KEYJS = """
(function(){
  var k=new URLSearchParams(location.search).get('key');
  if(!k) return;
  document.querySelectorAll('[data-src]').forEach(function(el){
    el.src=el.getAttribute('data-src')+'?key='+k;
  });
})();
"""


def esc(s):
    return html.escape(str(s if s is not None else ""))


def build_html(ctx):
    p = []
    A = p.append
    A(f"<!doctype html><html lang=en><head><meta charset=utf-8>")
    A(f"<meta name=viewport content='width=device-width,initial-scale=1'>")
    A(f"<title>{esc(ctx['title'])}</title><style>{CSS}</style></head><body><div class=wrap>")

    A("<header>")
    A(f"<div class=kicker>Storm report &middot; {esc(ctx['place'])}</div>")
    A(f"<h1>{esc(ctx['headline'])}</h1>")
    A(f"<div class=stamp>Issued {esc(ctx['issued'])} &middot; radar {esc(ctx['sweep_stamp'])} from {esc(ctx['tower'])}</div>")
    A("</header>")

    for al in ctx["alerts"][:3]:
        cls = "alert" + (" watch" if "Watch" in (al["event"] or "") else "")
        A(f"<div class='{cls}'><h2>{esc(al['event'])}</h2>")
        A(f"<p>{esc(al['headline'] or al['areaDesc'])}</p>")
        if al.get("instruction"):
            A(f"<p style='margin-top:8px'>{esc(al['instruction'][:400])}</p>")
        A("</div>")
    if not ctx["alerts"]:
        A("<div class='alert calm'><h2>No active warnings for this point</h2>"
          f"<p>{esc(ctx['calm_line'])}</p></div>")

    # Threat
    if ctx["outlook"]:
        o = ctx["outlook"]
        A("<section><h3>Today's threat</h3>")
        cat = o.get("categorical")
        A(f"<p class=big>{esc(CATEGORY_NAME.get(cat, cat or 'None'))}</p>")
        hz = o.get("hazards") or {}
        if hz:
            A("<table><tr><th>Hazard</th><th>Probability within 25 miles</th></tr>")
            for name, v in hz.items():
                pct = v.get("percent")
                cls = "hot" if (pct or 0) >= 15 else ("warm" if (pct or 0) >= 5 else "")
                sig = " <span class=pill>significant</span>" if v.get("significant") else ""
                A(f"<tr><td>{esc(name)}</td><td><span class='pill {cls}'>{esc(pct)}%</span>{sig}</td></tr>")
            A("</table>")
        A(f"<p class=aloft style='margin-top:10px'>SPC outlook issued {esc(zulu_to_local(o.get('issued_at')))}.</p>")
        A("</section>")

    # Mesoscale discussion
    if ctx["mcds"]:
        A("<section><h3>Forecaster discussion</h3>")
        for m in ctx["mcds"]:
            A(f"<p class=big>MCD {esc(m.get('id','').replace('SWO_',''))} &middot; "
              f"{esc(m.get('prob_of_watch'))}% chance of a watch</p>")
            A(f"<p class=aloft>{esc(m.get('headline'))} &middot; valid until "
              f"{esc(zulu_to_local(m.get('expires_at','').replace(' ','T')+'Z' if m.get('expires_at') else ''))}</p>")
        A("</section>")

    # Timing
    if ctx["cells"]:
        A("<section><h3>What is heading this way</h3>")
        A("<table><tr><th>Cell</th><th>Now</th><th>Top</th><th>Hail</th><th>Closest approach</th></tr>")
        for c in ctx["cells"][:6]:
            eta = c.get("closest_in_min")
            when = "already closest" if not eta else f"in {eta} min"
            hail = f"{c.get('max_hail_in')}\"" if (c.get("max_hail_in") or 0) > 0 else "&mdash;"
            tvs = " <span class='pill hot'>TVS</span>" if c.get("tvs") else ""
            spd = f"{c.get('speed_kt')} kt" if c.get("speed_kt") else "stationary"
            A(f"<tr><td>{esc(c.get('id'))}{tvs}<div class=aloft>{esc(c.get('threat'))} &middot; {esc(spd)}</div></td>"
              f"<td class=num>{esc(c.get('miles'))} mi {esc(c.get('from'))}<div class=aloft>{esc(c.get('max_dbz'))} dBZ</div></td>"
              f"<td class=num>{esc(round((c.get('echo_top_ft') or 0)/1000, 1))}k ft</td>"
              f"<td class=num>{hail}</td>"
              f"<td class=num>{esc(c.get('closest_mi'))} mi<div class=aloft>{esc(when)}</div></td></tr>")
        A("</table>")
        A("<p class=aloft style='margin-top:10px'>Cells and their projected tracks come from the radar's own "
          "SCIT algorithm, not from me eyeballing the loop. A stationary reading means the algorithm has not "
          "yet resolved a motion vector, usually because the cell just formed.</p>")
        A("</section>")

    # Radar numbers
    if ctx["cores"]:
        A("<section><h3>Strongest cores on radar</h3>")
        A("<table><tr><th>Intensity</th><th>Distance</th><th>Beam height</th></tr>")
        for h in ctx["cores"][:6]:
            aloft = " <span class=aloft>(aloft, not at the ground)</span>" if (h.get("beam_height_km") or 0) > 3 else ""
            A(f"<tr><td class='num big'>{esc(h['value'])} dBZ</td>"
              f"<td class=num>{esc(h['km_from_ref'])} km {esc(h.get('bearing_from_ref'))}&deg;</td>"
              f"<td class=num>{esc(h.get('beam_height_km'))} km{aloft}</td></tr>")
        A("</table>")
        A(f"<p class=aloft style='margin-top:10px'>{esc(ctx['beam_note'])}</p>")
        A("</section>")

    # Media
    if ctx.get("panel_file") or ctx.get("loop_file"):
        A("<section><h3>The radar, interrogated</h3>")
        if ctx.get("loop_file"):
            A(f"<figure><video data-src='{esc(ctx['loop_file'])}' autoplay loop muted playsinline></video>"
              f"<figcaption>{esc(ctx['loop_caption'])}</figcaption></figure>")
        if ctx.get("panel_file"):
            A(f"<figure><img data-src='{esc(ctx['panel_file'])}' alt='multi-product panel'>"
              "<figcaption>Same tower, same frame, same minute across six products. "
              "Reflectivity says how much, velocity says whether it is rotating, correlation "
              "coefficient says whether it is rain or debris, echo tops say how tall.</figcaption></figure>")
        A("</section>")

    # Ground truth
    A("<section><h3>On the ground</h3>")
    if ctx["reports"]:
        for r in ctx["reports"][:8]:
            mag = f" &middot; {esc(r['magnitude'])}{esc(r['unit'] or '')}" if r.get("magnitude") else ""
            A(f"<div class=rep><div class=t>{esc(r['valid'][11:16])}Z &middot; {esc(r['km'])} km "
              f"{esc(r['dir'])} &middot; {esc(r['source'])}</div>"
              f"<div class=w>{esc(r['type'])}{mag} &middot; {esc(r['where'])}</div>"
              f"<div class=r>{esc(r['remark'])}</div></div>")
    else:
        A("<p class=none>No storm reports filed near here in the window. "
          "That means nobody has reported damage, not that nothing happened.</p>")

    if ctx["metars"]:
        A("<table style='margin-top:16px'><tr><th>Airport</th><th>Wind</th><th>Visibility</th><th>Weather</th></tr>")
        for o in ctx["metars"]:
            g = f" g{o['gust_kt']}" if o.get("gust_kt") else ""
            A(f"<tr><td>{esc(o['station'])}</td><td class=num>{esc(o.get('wind_kt'))}{esc(g)} kt</td>"
              f"<td class=num>{esc(o.get('visibility'))} mi</td><td>{esc(o.get('weather') or '&mdash;')}</td></tr>")
        A("</table>")
    A("</section>")

    if ctx["cam_files"]:
        A("<section><h3>Looking outside</h3><div class=cams>")
        for c in ctx["cam_files"]:
            A(f"<figure><img data-src='{esc(c['file'])}' alt='camera'>"
              f"<figcaption>{esc(c['label'])}</figcaption></figure>")
        A("</div></section>")

    A("<footer>")
    A(f"Radar from {esc(ctx['tower'])} at {esc(ctx['sweep_stamp'])}. Outlooks and discussions from the Storm "
      "Prediction Center. Storm reports are NWS Local Storm Reports via the Iowa Environmental Mesonet. "
      "Airport observations are METARs. Road cameras are PennDOT 511PA. "
      "Beam height matters: radar samples a volume above your head, so a big number several kilometres up "
      "is not a big number at the ground.")
    A("</footer>")
    A(f"</div><script>{KEYJS}</script></body></html>")
    return "\n".join(p)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lat", type=float, default=HOME[0])
    ap.add_argument("--lon", type=float, default=HOME[1])
    ap.add_argument("--place", default=os.environ.get("EDMUND_HOME_PLACE", "home"))
    ap.add_argument("--radius", type=float, default=90, help="km for radar core search")
    ap.add_argument("--within", type=float, default=45, help="km for ground truth")
    ap.add_argument("--hours", type=int, default=6)
    ap.add_argument("--panel", default=None, help="path to a panel.py sheet to embed")
    ap.add_argument("--loop", default=None, help="path to a capture_loop mp4 to embed")
    ap.add_argument("--loop-caption", default="Radar loop, one frame per real volume scan.")
    ap.add_argument("--cams", type=int, default=4)
    ap.add_argument("--out-dir", required=True, help="directory to write the page and assets into")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    os.makedirs(a.out_dir, exist_ok=True)
    errors = []

    alerts = active_alerts(a.lat, a.lon)

    ol = mcp_call("get_outlooks", {"lat": a.lat, "lon": a.lon}) or {}
    day1 = ((ol.get("summary") or {}).get("day1")) or {}
    if day1:
        day1["issued_at"] = (ol.get("issued_at") or {}).get("day1")

    md = mcp_call("get_mesoscale_discussions", {"lat": a.lat, "lon": a.lon}) or {}
    mcds = [m for m in (md.get("discussions") or []) if m.get("covers_point")]

    scan = mcp_call("scan_radar_field",
                    {"lat": a.lat, "lon": a.lon, "radius_km": a.radius, "threshold": 40, "limit": 8}) or {}
    cores = scan.get("features") or []
    sweep = scan.get("sweep") or {}

    cells, e = run_json("cells.py", ["--lat", str(a.lat), "--lon", str(a.lon), "--within", str(a.within)])
    if e:
        errors.append(e)
    cell_rows = (cells or {}).get("cells") or (cells if isinstance(cells, list) else []) or []

    gt, e = run_json("ground_truth.py", [
        "--lat", str(a.lat), "--lon", str(a.lon), "--within", str(a.within),
        "--hours", str(a.hours), "--cams", str(a.cams),
        "--save-cams", os.path.join(a.out_dir, "cams"), "--skycam",
    ])
    if e:
        errors.append(e)
    gt = gt or {}

    cam_files = []
    for c in (gt.get("cameras") or []):
        if c.get("file"):
            cam_files.append({"file": os.path.relpath(c["file"], a.out_dir),
                              "label": f"{c['road']} &middot; {c['km']} km {c['dir']}"})
    sky = os.path.join(a.out_dir, "cams", "skycam.jpg")
    if os.path.exists(sky):
        cam_files.insert(0, {"file": os.path.relpath(sky, a.out_dir), "label": "Looking straight up from the house"})

    panel_rel = loop_rel = None
    if a.panel and os.path.exists(a.panel):
        shutil.copy2(a.panel, os.path.join(a.out_dir, "panel.jpg"))
        panel_rel = "panel.jpg"
    if a.loop and os.path.exists(a.loop):
        shutil.copy2(a.loop, os.path.join(a.out_dir, "loop.mp4"))
        loop_rel = "loop.mp4"

    if alerts:
        headline = alerts[0]["event"] + " in effect"
    elif mcds:
        headline = f"No warning yet, but SPC puts a watch at {mcds[0].get('prob_of_watch')}%"
    elif day1.get("categorical") in ("SLGT", "ENH", "MDT", "HIGH"):
        headline = f"{CATEGORY_NAME.get(day1['categorical'])} for severe storms today"
    elif cores:
        headline = f"Storms in range, strongest core {cores[0]['value']} dBZ"
    else:
        headline = "Quiet for now"

    lowest = min((c.get("beam_height_km") or 99) for c in cores) if cores else None
    beam_note = (
        f"Lowest beam over these cores is {lowest} km above ground. "
        "Anything sampled above about 3 km is telling you about the storm's middle, not its base."
        if lowest else "No echo over 40 dBZ in range."
    )

    ctx = {
        "title": f"Storm report - {a.place}",
        "place": a.place,
        "headline": headline,
        "issued": dt.datetime.now().strftime("%-I:%M %p on %B %-d"),
        "sweep_stamp": (sweep.get("scan") or "") + "Z",
        "tower": sweep.get("tower") or "?",
        "alerts": alerts,
        "calm_line": (f"Nothing is warned for this point right now. "
                      f"{beam_note}"),
        "outlook": day1,
        "mcds": mcds,
        "cells": cell_rows,
        "cores": cores,
        "beam_note": beam_note,
        "reports": gt.get("storm_reports") or [],
        "metars": gt.get("metars") or [],
        "cam_files": cam_files,
        "panel_file": panel_rel,
        "loop_file": loop_rel,
        "loop_caption": a.loop_caption,
    }

    page = os.path.join(a.out_dir, "index.html")
    open(page, "w").write(build_html(ctx))

    out = {
        "page": page, "out_dir": a.out_dir, "headline": headline,
        "alerts": len(alerts), "cores": len(cores),
        "reports": len(ctx["reports"]), "cameras": len(cam_files),
        "panel": bool(panel_rel), "loop": bool(loop_rel),
        "errors": errors,
        "next": "Run instant-share share.sh on out_dir. Do not construct the URL yourself.",
    }
    print(json.dumps(out, indent=1) if a.json else
          f"{page}\n{headline}\n{len(cores)} cores, {len(ctx['reports'])} reports, {len(cam_files)} cameras"
          + (f"\nerrors: {errors}" if errors else ""))


if __name__ == "__main__":
    sys.exit(main())
