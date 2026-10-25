/**
 * The page a person gets when their print starts: the camera, how far along
 * it is, when it will be done, and at the end a photo and the timelapse.
 *
 * Served from the daemon's printer runtime under /print/<token>/ and
 * published through the kitchen host's tunnel. It polls status.json and the
 * camera frame rather than streaming, because a polled JPEG survives every
 * proxy and an iPhone in low-power mode alike.
 */

export type PageStatus = {
  title: string;
  requester: string;
  printer: string;
  phase: "waiting" | "preparing" | "printing" | "paused" | "finished" | "failed" | "cancelled";
  phaseLabel: string;
  stage: string;
  percent: number | null;
  layer: number | null;
  totalLayers: number | null;
  remainingMin: number | null;
  etaMs: number | null;
  startedMs: number | null;
  endedMs: number | null;
  nozzle: { temp: number | null; target: number | null };
  bed: { temp: number | null; target: number | null };
  speed: string;
  filaments: Array<{ color: string; name: string; type: string; grams: number }>;
  estimateS: number;
  live: boolean;
  hasPreview: boolean;
  hasFinalPhoto: boolean;
  hasTimelapse: boolean;
  updatedMs: number;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderPage(initial: PageStatus): string {
  const data = JSON.stringify(initial).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${esc(initial.title)} · 3D print</title>
<style>
:root{--bg:#f6f4ef;--card:#ffffff;--ink:#1c1b19;--muted:#6e6a62;--line:#e6e1d7;--accent:#1f6f5c;--accent-soft:#dcefe8;--warn:#a45a12;--warn-soft:#fbead8;--bad:#a8322a;--bad-soft:#f8e1de;--track:#ebe6dc;--shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.05)}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--card:#1b1b19;--ink:#ecebe7;--muted:#9c978e;--line:#2b2a27;--accent:#5cc3a4;--accent-soft:#16352c;--warn:#e7a35a;--warn-soft:#3a2914;--bad:#ec7f75;--bad-soft:#3d1c19;--track:#2a2926;--shadow:none}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink)}
body{font:16px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:720px;margin:0 auto;padding:max(20px,env(safe-area-inset-top)) 16px 40px}
.eyebrow{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:4px 0 6px;display:flex;align-items:center;gap:8px}
h1{font-size:28px;line-height:1.15;margin:0 0 4px;font-weight:700;letter-spacing:-.01em;word-break:break-word}
.sub{color:var(--muted);margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);overflow:hidden;margin-bottom:14px}
.cam{position:relative;aspect-ratio:16/9;background:#0e0e0d;display:flex;align-items:center;justify-content:center}
.cam img{width:100%;height:100%;object-fit:cover;display:block}
.cam .empty{color:#bdb8ae;font-size:15px;padding:24px;text-align:center}
.badge{position:absolute;top:12px;left:12px;background:rgba(0,0,0,.55);color:#fff;font-size:12px;font-weight:600;letter-spacing:.04em;padding:5px 10px 5px 9px;border-radius:999px;display:flex;align-items:center;gap:7px;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.dot{width:8px;height:8px;border-radius:50%;background:#ff4d3d;animation:pulse 1.6s ease-in-out infinite}
.badge.still .dot{background:#bdb8ae;animation:none}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.pad{padding:18px 18px 20px}
.row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.pct{font-size:44px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1}
.phase{font-size:14px;font-weight:600;padding:5px 11px;border-radius:999px;background:var(--accent-soft);color:var(--accent);white-space:nowrap}
.phase.paused{background:var(--warn-soft);color:var(--warn)}
.phase.failed,.phase.cancelled{background:var(--bad-soft);color:var(--bad)}
.bar{height:10px;background:var(--track);border-radius:999px;overflow:hidden;margin:16px 0 12px}
.fill{height:100%;width:0;background:var(--accent);border-radius:999px;transition:width .8s ease}
.fill.paused{background:var(--warn)}
.meta{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--muted);font-size:15px;font-variant-numeric:tabular-nums}
.meta b{color:var(--ink);font-weight:600}
.stage{margin-top:10px;font-size:15px;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line)}
.stat{background:var(--card);padding:14px 16px}
.stat .k{font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
.stat .v{font-size:19px;font-weight:600;font-variant-numeric:tabular-nums}
.stat .v small{font-size:13px;color:var(--muted);font-weight:500}
h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 12px;font-weight:600}
.fil{display:flex;align-items:center;gap:12px;padding:8px 0;border-top:1px solid var(--line)}
.fil:first-of-type{border-top:0}
.sw{width:26px;height:26px;border-radius:50%;border:1px solid rgba(0,0,0,.12);flex:none;box-shadow:inset 0 -3px 6px rgba(0,0,0,.12)}
.fil .n{flex:1}
.fil .g{color:var(--muted);font-variant-numeric:tabular-nums}
.media{display:grid;grid-template-columns:1fr;gap:12px}
.media img,.media video{width:100%;border-radius:12px;display:block;background:#0e0e0d}
.preview{display:flex;gap:16px;align-items:center}
.preview img{width:112px;height:112px;object-fit:contain;border-radius:12px;background:var(--bg);flex:none}
.preview p{margin:0;color:var(--muted);font-size:15px}
footer{color:var(--muted);font-size:13px;text-align:center;margin-top:20px}
.hide{display:none!important}
@media (max-width:420px){h1{font-size:24px}.pct{font-size:38px}.grid{grid-template-columns:repeat(2,1fr)}.stat:last-child{grid-column:span 2}}
</style>
</head>
<body>
<main>
  <div class="eyebrow"><span id="printer"></span></div>
  <h1 id="title"></h1>
  <p class="sub" id="sub"></p>

  <section class="card">
    <div class="cam" id="cam">
      <img id="frame" alt="Live view of the printer" class="hide">
      <div class="empty" id="camEmpty">The camera picture will appear here while it prints.</div>
      <div class="badge hide" id="badge"><span class="dot"></span><span id="badgeText">LIVE</span></div>
    </div>
    <div class="pad">
      <div class="row"><div class="pct" id="pct">0%</div><div class="phase" id="phase"></div></div>
      <div class="bar"><div class="fill" id="fill"></div></div>
      <div class="meta" id="meta"></div>
      <div class="stage" id="stage"></div>
    </div>
    <div class="grid">
      <div class="stat"><div class="k">Nozzle</div><div class="v" id="nozzle">-</div></div>
      <div class="stat"><div class="k">Bed</div><div class="v" id="bed">-</div></div>
      <div class="stat"><div class="k">Speed</div><div class="v" id="speed">-</div></div>
    </div>
  </section>

  <section class="card hide" id="doneCard"><div class="pad">
    <h2>Finished print</h2>
    <div class="media" id="media"></div>
  </div></section>

  <section class="card"><div class="pad">
    <h2>Filament</h2>
    <div id="fils"></div>
  </div></section>

  <section class="card hide" id="previewCard"><div class="pad preview">
    <img id="preview" alt="What is being printed">
    <p id="previewText"></p>
  </div></section>

  <footer id="foot">Updates on its own every few seconds.</footer>
</main>
<script>
(function(){
  var S = ${data};
  var $ = function(id){ return document.getElementById(id); };
  var clock = function(ms){ return new Date(ms).toLocaleTimeString([], {hour:"numeric", minute:"2-digit"}); };
  var day = function(ms){ var d = new Date(ms), t = new Date(); return d.toDateString() === t.toDateString() ? "today" : d.toLocaleDateString([], {weekday:"short"}); };
  var dur = function(min){ if (min == null) return ""; if (min < 60) return Math.max(0, Math.round(min)) + " min"; var h = Math.floor(min/60), m = Math.round(min%60); return h + " h" + (m ? " " + m + " min" : ""); };
  var deg = function(t){ if (!t || t.temp == null) return "-"; return Math.round(t.temp) + "&deg;" + (t.target ? " <small>/ " + Math.round(t.target) + "&deg;</small>" : ""); };
  var lastFrame = 0, frameBusy = false, liveSince = 0;

  function render(){
    $("printer").textContent = "3D print on " + S.printer;
    $("title").textContent = S.title;
    var who = S.requester ? "For " + S.requester : "";
    var when = S.startedMs ? "started " + clock(S.startedMs) + (day(S.startedMs) === "today" ? "" : " " + day(S.startedMs)) : "";
    $("sub").textContent = [who, when].filter(Boolean).join(", ");
    var pct = S.phase === "finished" ? 100 : (S.percent == null ? 0 : S.percent);
    $("pct").textContent = pct + "%";
    var ph = $("phase"); ph.textContent = S.phaseLabel; ph.className = "phase " + S.phase;
    var fill = $("fill"); fill.style.width = pct + "%"; fill.className = "fill" + (S.phase === "paused" ? " paused" : "");
    var meta = [];
    if (S.layer != null && S.totalLayers) meta.push("Layer <b>" + S.layer + "</b> of " + S.totalLayers);
    if ((S.phase === "printing" || S.phase === "preparing") && S.remainingMin != null) meta.push("<b>" + dur(S.remainingMin) + "</b> left");
    if ((S.phase === "printing" || S.phase === "preparing") && S.etaMs) meta.push("Done around <b>" + clock(S.etaMs) + "</b>");
    if (S.phase === "waiting" && S.estimateS) meta.push("About <b>" + dur(S.estimateS/60) + "</b> to print");
    if (S.endedMs) meta.push((S.phase === "finished" ? "Finished " : "Stopped ") + "<b>" + clock(S.endedMs) + "</b>");
    $("meta").innerHTML = meta.map(function(m){ return "<span>" + m + "</span>"; }).join("");
    $("stage").textContent = S.stage ? S.stage.charAt(0).toUpperCase() + S.stage.slice(1) : "";
    $("nozzle").innerHTML = deg(S.nozzle);
    $("bed").innerHTML = deg(S.bed);
    $("speed").textContent = S.speed ? S.speed.charAt(0).toUpperCase() + S.speed.slice(1) : "-";
    $("fils").innerHTML = S.filaments.map(function(f){
      return '<div class="fil"><span class="sw" style="background:' + f.color + '"></span><span class="n">' + f.name + ' ' + f.type + '</span><span class="g">' + (f.grams ? f.grams.toFixed(0) + " g" : "") + '</span></div>';
    }).join("") || '<div class="fil"><span class="n">Not known yet</span></div>';
    if (S.hasPreview) { $("previewCard").classList.remove("hide"); $("preview").src = "plate.png"; $("previewText").textContent = "The model as it sits on the plate, " + (S.estimateS ? "about " + dur(S.estimateS/60) + " of printing." : "ready to print."); }
    var done = S.phase === "finished" || S.phase === "failed" || S.phase === "cancelled";
    if (done && (S.hasFinalPhoto || S.hasTimelapse)) {
      $("doneCard").classList.remove("hide");
      var html = "";
      if (S.hasFinalPhoto) html += '<img src="final.jpg?v=' + (S.endedMs || 0) + '" alt="The finished print">';
      if (S.hasTimelapse) html += '<video src="timelapse.mp4" controls playsinline preload="metadata"></video>';
      if ($("media").getAttribute("data-k") !== html) { $("media").innerHTML = html; $("media").setAttribute("data-k", html); }
    }
    if (!S.live) {
      $("badge").classList.add("hide");
      if (done && S.hasFinalPhoto) { showStill("final.jpg?v=" + (S.endedMs || 0)); }
      else if (!lastFrame) { $("camEmpty").textContent = S.phase === "waiting" ? "The camera picture will appear here once it starts." : "The camera is not sending pictures right now."; }
    }
    $("foot").textContent = done ? "This print is over. The page will stay here." : "Updates on its own every few seconds.";
  }

  function showStill(src){
    var img = $("frame"); if (img.getAttribute("src") === src) return;
    img.src = src; img.classList.remove("hide"); $("camEmpty").classList.add("hide");
  }

  function pullFrame(){
    if (!S.live || frameBusy || document.visibilityState !== "visible") return;
    frameBusy = true;
    var next = new Image();
    next.onload = function(){
      var img = $("frame"); img.src = next.src; img.classList.remove("hide"); $("camEmpty").classList.add("hide");
      lastFrame = Date.now(); if (!liveSince) liveSince = lastFrame;
      var b = $("badge"); b.classList.remove("hide", "still"); $("badgeText").textContent = "LIVE";
      frameBusy = false;
    };
    next.onerror = function(){ frameBusy = false; if (Date.now() - lastFrame > 15000) { var b = $("badge"); b.classList.add("still"); $("badgeText").textContent = "PAUSED FEED"; } };
    next.src = "frame.jpg?t=" + Date.now();
  }

  function pullStatus(){
    if (document.visibilityState !== "visible") return;
    fetch("status.json?t=" + Date.now(), {cache: "no-store"}).then(function(r){ return r.ok ? r.json() : null; }).then(function(j){ if (j) { S = j; render(); } }).catch(function(){});
  }

  render();
  pullFrame();
  setInterval(pullFrame, 2000);
  setInterval(pullStatus, 4000);
  document.addEventListener("visibilitychange", function(){ if (document.visibilityState === "visible") { pullStatus(); pullFrame(); } });
})();
</script>
</body>
</html>`;
}
