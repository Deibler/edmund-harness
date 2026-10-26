/**
 * The page a person gets when their print starts: the live camera, the model
 * it is printing in 3D, how far along it is and when it will be done, and at
 * the end a photo and the timelapse.
 *
 * Served from the daemon's printer runtime under /print/<token>/ and
 * published through the kitchen host's tunnel. The camera is live video: the
 * camera host (camera-server.ts) passes the printer's own H.264 through as
 * HLS under /printcam/<token>/, which iPhones and Chrome play natively and
 * other browsers play with hls.js. A polled still comes first and stands in
 * whenever the video cannot play. The 3D view (viewer-model.ts) loads only
 * when someone opens it.
 */

/** hls.js for browsers without native HLS, pinned with its integrity hash. */
export const HLS_JS = {
  src: "https://cdn.jsdelivr.net/npm/hls.js@1.6.19/dist/hls.min.js",
  integrity: "sha384-eIepVstlIv9sSqP0mAsB37yZCJzcs0Y9qhxne7qDj9mO6EneOgR3uvZy28Xn6XqH",
};

/** three.js for the 3D view, pinned. The module build imports the unminified
 *  core by name; the import map sends it to the minified one. */
const THREE_BASE = "https://cdn.jsdelivr.net/npm/three@0.186.0";
export const THREE_JS = {
  module: `${THREE_BASE}/build/three.module.min.js`,
  core: `${THREE_BASE}/build/three.core.js`,
  coreMin: `${THREE_BASE}/build/three.core.min.js`,
  addons: `${THREE_BASE}/examples/jsm/`,
  integrity: {
    [`${THREE_BASE}/build/three.module.min.js`]:
      "sha384-oxXuJrj18wuqDpmzoHiMlDkqW0q78j4G6RIMnGujQSJFPNAOySQPco8ukheqfFpF",
    [`${THREE_BASE}/build/three.core.min.js`]:
      "sha384-SkU9wejqatbKwpdY5t3wOM9rvvfcAdGmvWFm3/HgavlYlxXqMiZbIADYpVuJ8LzZ",
    [`${THREE_BASE}/examples/jsm/controls/OrbitControls.js`]:
      "sha384-LSqANrugPGTgf0eYsQTloqKWy926dOOXo2iZ9y6wLMIDEQoU9AaCLJF1Vcc7oJXr",
  } as Record<string, string>,
};

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

const ICON = {
  expand:
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  reset:
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>',
};

export function renderPage(initial: PageStatus): string {
  const data = JSON.stringify(initial).replace(/</g, "\\u003c");
  const importMap = JSON.stringify({
    imports: {
      three: THREE_JS.module,
      "three/addons/": THREE_JS.addons,
      [THREE_JS.core]: THREE_JS.coreMin,
    },
    integrity: THREE_JS.integrity,
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0b0b0c">
<meta name="color-scheme" content="dark">
<title>${esc(initial.title)}</title>
<script type="importmap">${importMap}</script>
<style>
:root{--bg:#0b0b0c;--raise:#1c1c1e;--text:#f5f5f7;--muted:#8e8e93;--faint:#48484a;--line:rgba(255,255,255,.09);--ok:#30d158;--warn:#ffd60a;--bad:#ff453a}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;background:var(--bg);color:var(--text)}
body{font:15px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",system-ui,sans-serif;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
.hide{display:none!important}
.top{display:flex;align-items:center;justify-content:space-between;max-width:1200px;margin:0 auto;padding:calc(env(safe-area-inset-top) + 14px) 20px 12px}
.printer{font-weight:600;font-size:15px}
.state{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:14px}
.state i{width:8px;height:8px;border-radius:50%;background:var(--faint)}
.state.printing i,.state.preparing i{background:var(--ok)}
.state.paused i{background:var(--warn)}
.state.failed i,.state.cancelled i{background:var(--bad)}
.layout{max-width:1200px;margin:0 auto}
.media{position:relative;aspect-ratio:16/9;background:#000;overflow:hidden;user-select:none;-webkit-user-select:none}
.pane{position:absolute;inset:0}
.pane img,.pane video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000}
.pane canvas{display:block;width:100%;height:100%;touch-action:none}
.note{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:14px;padding:24px;text-align:center}
.chip{position:absolute;top:12px;left:12px;display:flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:6px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;font-weight:600;letter-spacing:.06em}
.chip i{width:6px;height:6px;border-radius:50%;background:var(--bad)}
.chip.idle i{background:var(--muted)}
.seg{position:absolute;top:12px;right:12px;display:flex;padding:2px;border-radius:8px;background:rgba(0,0,0,.6)}
.seg button{height:28px;padding:0 12px;border-radius:6px;font-size:13px;font-weight:500;color:rgba(255,255,255,.75)}
.seg button[aria-pressed="true"]{background:rgba(255,255,255,.18);color:#fff}
.tools{position:absolute;right:10px;bottom:10px;display:flex;gap:6px}
.tool{width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);color:#fff}
.hint{position:absolute;left:12px;bottom:14px;color:rgba(255,255,255,.7);font-size:12px;transition:opacity .4s}
.status{position:absolute;left:12px;bottom:14px;color:rgba(255,255,255,.8);font-size:12px}
.playbtn{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:64px;height:64px;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;display:flex;align-items:center;justify-content:center}
.media.expanded{position:fixed;inset:0;z-index:20;aspect-ratio:auto;padding-top:env(safe-area-inset-top)}
.media:fullscreen{aspect-ratio:auto}
.media:fullscreen .pane img,.media:fullscreen .pane video,.media.expanded .pane img,.media.expanded .pane video{object-fit:contain}
.media:-webkit-full-screen .pane img,.media:-webkit-full-screen .pane video{object-fit:contain}
.info{padding:20px 20px calc(env(safe-area-inset-bottom) + 28px)}
.job{display:flex;gap:14px;align-items:flex-start}
.thumb{width:52px;height:52px;border-radius:10px;background:var(--raise);object-fit:contain;flex:none}
h1{font-size:20px;line-height:1.25;font-weight:600;margin:0;letter-spacing:-.01em;overflow-wrap:anywhere}
.sub{margin:3px 0 0;color:var(--muted);font-size:14px}
.progress{margin-top:22px}
.prow{display:flex;align-items:flex-end;justify-content:space-between;gap:16px}
.pct{font-size:40px;line-height:1;font-weight:600;letter-spacing:-.02em}
.left{text-align:right;font-size:15px}
.left small{display:block;color:var(--muted);font-size:13px;margin-top:2px}
.bar{height:4px;border-radius:2px;background:var(--raise);margin:14px 0 10px;overflow:hidden}
.bar div{height:100%;width:0;background:var(--ok);transition:width .6s ease}
.bar.paused div{background:var(--warn)}
.bar.failed div,.bar.cancelled div{background:var(--bad)}
.lrow{display:flex;justify-content:space-between;color:var(--muted);font-size:13px}
.rows{margin-top:22px;border-top:1px solid var(--line)}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:48px;border-bottom:1px solid var(--line)}
.row .k{color:var(--muted)}
.row .v small{color:var(--muted)}
.fil{display:flex;align-items:center;gap:10px}
.dot{width:12px;height:12px;border-radius:50%;box-shadow:0 0 0 1px rgba(255,255,255,.18) inset;flex:none}
.done{margin-top:22px}
.done video{width:100%;border-radius:10px;background:#000;display:block}
.label{color:var(--muted);font-size:13px;margin:0 0 10px}
@media (min-width:900px){
  .top{padding:24px 32px 16px}
  .layout{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:32px;padding:0 32px 40px;align-items:start}
  .media{border-radius:12px}
  .media.expanded{border-radius:0}
  .info{padding:4px 0 0}
}
</style>
</head>
<body>
<div class="top">
  <div class="printer" id="printer"></div>
  <div class="state" id="state"><i></i><span id="stateText"></span></div>
</div>
<div class="layout">
  <div class="media" id="media">
    <div class="pane" id="camPane">
      <img id="frame" alt="The printer's camera" class="hide">
      <video id="video" class="hide" muted autoplay playsinline disablepictureinpicture></video>
      <div class="note" id="camNote">Waiting for the camera</div>
      <button class="playbtn hide" id="playBtn" aria-label="Play">${ICON.play}</button>
      <div class="chip hide" id="chip"><i></i><span id="chipText">LIVE</span></div>
      <div class="status hide" id="camStatus"></div>
    </div>
    <div class="pane hide" id="modelPane">
      <div class="note" id="modelNote">Loading the model</div>
      <div class="hint hide" id="hint">Drag to turn, pinch to zoom</div>
    </div>
    <div class="seg" role="group" aria-label="View">
      <button id="tabCam" aria-pressed="true">Camera</button>
      <button id="tabModel" aria-pressed="false">Model</button>
    </div>
    <div class="tools">
      <button class="tool hide" id="resetBtn" aria-label="Reset view">${ICON.reset}</button>
      <button class="tool" id="fullBtn" aria-label="Full screen">${ICON.expand}</button>
    </div>
  </div>
  <div class="info">
    <div class="job">
      <img class="thumb hide" id="thumb" alt="">
      <div><h1 id="title"></h1><p class="sub" id="sub"></p></div>
    </div>
    <div class="progress">
      <div class="prow"><div class="pct" id="pct">0%</div><div class="left" id="left"></div></div>
      <div class="bar" id="bar"><div id="fill"></div></div>
      <div class="lrow"><span id="layer"></span><span id="stage"></span></div>
    </div>
    <div class="rows">
      <div class="row"><span class="k">Nozzle</span><span class="v" id="nozzle">-</span></div>
      <div class="row"><span class="k">Bed</span><span class="v" id="bed">-</span></div>
      <div class="row"><span class="k">Speed</span><span class="v" id="speed">-</span></div>
      <div id="fils"></div>
    </div>
    <div class="done hide" id="done">
      <p class="label">Timelapse</p>
      <video id="timelapse" controls playsinline preload="metadata"></video>
    </div>
  </div>
</div>
<script>
(function(){
  var S = ${data};
  var $ = function(id){ return document.getElementById(id); };
  var clock = function(ms){ return new Date(ms).toLocaleTimeString([], {hour:"numeric", minute:"2-digit"}); };
  var day = function(ms){ var d = new Date(ms), t = new Date(); return d.toDateString() === t.toDateString() ? "" : " " + d.toLocaleDateString([], {weekday:"short"}); };
  var dur = function(min){ if (min == null) return ""; if (min < 60) return Math.max(0, Math.round(min)) + " min"; var h = Math.floor(min/60), m = Math.round(min%60); return h + " h" + (m ? " " + m + " min" : ""); };
  var deg = function(t){ if (!t || t.temp == null) return "-"; return Math.round(t.temp) + "\\u00b0" + (t.target ? " <small>/ " + Math.round(t.target) + "\\u00b0</small>" : ""); };
  var cap = function(s){ return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; };
  var active = function(){ return S.phase === "printing" || S.phase === "preparing" || S.phase === "paused"; };
  var over = function(){ return S.phase === "finished" || S.phase === "failed" || S.phase === "cancelled"; };
  var token = location.pathname.split("/")[2];
  var view = "camera";

  function render(){
    $("printer").textContent = S.printer.replace(/^the /i, "");
    var st = $("state"); st.className = "state " + S.phase; $("stateText").textContent = S.phaseLabel;
    document.title = S.title;
    $("title").textContent = S.title;
    var sub = [];
    if (S.requester) sub.push("For " + S.requester);
    if (S.startedMs) sub.push("Started " + clock(S.startedMs) + day(S.startedMs));
    if (S.endedMs) sub.push((S.phase === "finished" ? "Finished " : "Stopped ") + clock(S.endedMs) + day(S.endedMs));
    $("sub").textContent = sub.join(" \\u00b7 ");
    var pct = S.phase === "finished" ? 100 : (S.percent == null ? 0 : S.percent);
    $("pct").textContent = pct + "%";
    var left = "";
    if (active() && S.remainingMin != null) left = dur(S.remainingMin) + " left" + (S.etaMs ? "<small>Done around " + clock(S.etaMs) + "</small>" : "");
    else if (S.phase === "waiting" && S.estimateS) left = "About " + dur(S.estimateS/60);
    $("left").innerHTML = left;
    $("bar").className = "bar " + S.phase; $("fill").style.width = pct + "%";
    $("layer").textContent = S.layer != null && S.totalLayers ? "Layer " + S.layer + " of " + S.totalLayers : "";
    $("stage").textContent = cap(S.stage);
    $("nozzle").innerHTML = deg(S.nozzle);
    $("bed").innerHTML = deg(S.bed);
    $("speed").textContent = cap(S.speed) || "-";
    $("fils").innerHTML = S.filaments.map(function(f){
      return '<div class="row"><span class="fil"><span class="dot" style="background:' + f.color + '"></span>' + f.name + ' ' + f.type + '</span><span class="v">' + (f.grams ? f.grams.toFixed(0) + " g" : "") + '</span></div>';
    }).join("");
    if (S.hasPreview) { var th = $("thumb"); if (!th.getAttribute("src")) th.src = "plate.png"; th.classList.remove("hide"); }
    if (over() && S.hasTimelapse && !$("timelapse").getAttribute("src")) { $("timelapse").src = "timelapse.mp4"; $("done").classList.remove("hide"); }
    renderCamera();
    if (model) model.progress();
  }

  /* ---- camera ---------------------------------------------------------- */

  var video = $("video"), frame = $("frame");
  var playing = false, hls = null, starting = 0, lastTime = -1, lastMove = 0, lastFrame = 0, frameBusy = false;
  var hlsUrl = "/printcam/" + token + "/index.m3u8";

  function chip(text, idle){ var c = $("chip"); c.classList.remove("hide"); c.classList.toggle("idle", !!idle); $("chipText").textContent = text; }
  function camStatus(text){ var s = $("camStatus"); s.textContent = text || ""; s.classList.toggle("hide", !text); }

  function renderCamera(){
    if (S.live) { startVideo(); return; }
    stopVideo();
    if (over() && S.hasFinalPhoto) {
      var src = "final.jpg?v=" + (S.endedMs || 0);
      if (frame.getAttribute("src") !== src) frame.src = src;
      frame.classList.remove("hide"); $("camNote").classList.add("hide");
      chip(S.phase === "finished" ? "FINISHED" : "STOPPED", true);
    } else {
      $("chip").classList.add("hide");
      if (!lastFrame) $("camNote").textContent = S.phase === "waiting" ? "The camera starts with the print" : "The camera is off";
    }
  }
  function onPlaying(){
    playing = true; lastMove = Date.now(); $("playBtn").classList.add("hide");
    video.classList.remove("hide"); $("camNote").classList.add("hide"); camStatus(""); chip("LIVE");
  }
  function stopVideo(){
    playing = false;
    if (hls) { hls.destroy(); hls = null; }
    if (video.getAttribute("src")) { video.removeAttribute("src"); video.load(); }
    video.classList.add("hide");
  }
  function play(){
    var p = video.play();
    if (p && p.catch) p.catch(function(e){ if (e && e.name === "NotAllowedError") $("playBtn").classList.remove("hide"); });
  }
  function startVideo(){
    if (!S.live || playing || hls || video.getAttribute("src") || document.visibilityState !== "visible") return;
    if (Date.now() - starting < 4000) return;
    starting = Date.now();
    if (video.canPlayType("application/vnd.apple.mpegurl")) { video.src = hlsUrl; play(); return; }
    var go = function(){
      if (!window.Hls || !Hls.isSupported() || hls) return;
      hls = new Hls({ liveSyncDuration: 6, liveMaxLatencyDuration: 16, maxLiveSyncPlaybackRate: 1.1, backBufferLength: 10, manifestLoadingMaxRetry: 8, levelLoadingMaxRetry: 8, fragLoadingMaxRetry: 8 });
      hls.on(Hls.Events.ERROR, function(e, d){ if (d.fatal) restartVideo(); });
      hls.loadSource(hlsUrl); hls.attachMedia(video); play();
    };
    if (window.Hls) return go();
    var sc = document.createElement("script");
    sc.src = "${HLS_JS.src}"; sc.integrity = "${HLS_JS.integrity}"; sc.crossOrigin = "anonymous";
    sc.onload = go; document.head.appendChild(sc);
  }
  function restartVideo(){ camStatus("Reconnecting"); stopVideo(); starting = 0; startVideo(); }
  // A picture that stops moving is reloaded; the still keeps the view while it does.
  function watch(){
    if (!playing || document.visibilityState !== "visible") { lastMove = Date.now(); return; }
    if (video.currentTime !== lastTime) { lastTime = video.currentTime; lastMove = Date.now(); camStatus(""); return; }
    if (Date.now() - lastMove > 4000) camStatus("Catching up");
    if (Date.now() - lastMove > 12000) restartVideo();
  }
  function toLiveEdge(){
    if (!playing || hls || !video.seekable.length) return;
    var end = video.seekable.end(video.seekable.length - 1);
    if (end - video.currentTime > 12) video.currentTime = end - 6;
  }
  function pullFrame(){
    if (!S.live || playing || frameBusy || document.visibilityState !== "visible") return;
    frameBusy = true;
    var next = new Image();
    next.onload = function(){ frame.src = next.src; frame.classList.remove("hide"); $("camNote").classList.add("hide"); lastFrame = Date.now(); chip("LIVE"); frameBusy = false; };
    next.onerror = function(){ frameBusy = false; };
    next.src = "frame.jpg?t=" + Date.now();
  }
  video.addEventListener("playing", onPlaying);
  video.addEventListener("error", function(){ if (!hls) restartVideo(); });
  $("playBtn").addEventListener("click", function(){ $("playBtn").classList.add("hide"); play(); });

  /* ---- views and full screen ------------------------------------------ */

  var media = $("media");
  function show(which){
    view = which;
    $("tabCam").setAttribute("aria-pressed", String(which === "camera"));
    $("tabModel").setAttribute("aria-pressed", String(which === "model"));
    $("camPane").classList.toggle("hide", which !== "camera");
    $("modelPane").classList.toggle("hide", which !== "model");
    $("resetBtn").classList.toggle("hide", which !== "model");
    if (which === "model" && !model) loadModel(); else if (model) model.resize();
  }
  $("tabCam").addEventListener("click", function(){ show("camera"); });
  $("tabModel").addEventListener("click", function(){ show("model"); });
  $("thumb").addEventListener("click", function(){ show("model"); });

  var canFull = !!(media.requestFullscreen || media.webkitRequestFullscreen);
  function inFull(){ return document.fullscreenElement || document.webkitFullscreenElement || media.classList.contains("expanded"); }
  function setExpanded(on){ media.classList.toggle("expanded", on); $("fullBtn").innerHTML = on ? '${ICON.close}' : '${ICON.expand}'; if (model) model.resize(); }
  $("fullBtn").addEventListener("click", function(){
    if (inFull()) {
      if (media.classList.contains("expanded")) return setExpanded(false);
      return (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    }
    // The camera on an iPhone goes to the system's own full-screen player.
    if (view === "camera" && playing && video.webkitEnterFullscreen && !canFull) return video.webkitEnterFullscreen();
    if (canFull) return (media.requestFullscreen || media.webkitRequestFullscreen).call(media);
    setExpanded(true);
  });
  document.addEventListener("fullscreenchange", function(){ if (model) model.resize(); });
  document.addEventListener("webkitfullscreenchange", function(){ if (model) model.resize(); });

  /* ---- 3D view --------------------------------------------------------- */

  var model = null, modelLoading = false;
  function modelNote(text){ var n = $("modelNote"); n.textContent = text || ""; n.classList.toggle("hide", !text); }
  async function fetchViewer(){
    for (var i = 0; i < 60; i++) {
      var r = await fetch("viewer.json", {cache: "no-store"});
      if (r.status === 200) return r.json();
      if (r.status !== 202) throw new Error("no model");
      modelNote("Preparing the model");
      await new Promise(function(ok){ setTimeout(ok, 1500); });
    }
    throw new Error("timed out");
  }
  async function loadModel(){
    if (model || modelLoading) return;
    modelLoading = true;
    try {
      var info = await fetchViewer();
      if (info.error) throw new Error(info.error);
      modelNote("Loading the model");
      var res = await Promise.all([import("three"), import("three/addons/controls/OrbitControls.js"), fetch("viewer.bin").then(function(r){ if (!r.ok) throw new Error("no data"); return r.arrayBuffer(); })]);
      model = buildScene(res[0], res[1].OrbitControls, info, res[2]);
      modelNote("");
    } catch (e) {
      modelNote("The 3D view is not available for this print");
    } finally { modelLoading = false; }
  }

  function buildScene(THREE, OrbitControls, info, buf){
    var pane = $("modelPane");
    var renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.localClippingEnabled = true;
    renderer.toneMapping = THREE.NeutralToneMapping;
    pane.insertBefore(renderer.domElement, pane.firstChild);
    var scene = new THREE.Scene();
    scene.background = new THREE.Color("#121214");

    // The printer works in millimetres with z up; the scene puts y up and the
    // plate's centre at the origin.
    var W = info.bed.w, D = info.bed.d;
    var V = info.vertices, T = info.triangles;
    var q = new Uint16Array(buf, 0, V * 3);
    var padded = (V * 6 + 3) & ~3;
    var idx = new Uint32Array(buf, padded, T * 3);
    var fil = new Uint8Array(buf, padded + T * 12, T);
    var span = [0, 1, 2].map(function(k){ return info.max[k] - info.min[k]; });
    var palette = info.colors.map(function(c){ return new THREE.Color(c); });
    var grey = new THREE.Color("#9a9a9e");
    var pos = new Float32Array(T * 9), col = new Float32Array(T * 9);
    for (var t = 0; t < T; t++) {
      var c = palette[fil[t] - 1] || grey;
      for (var k = 0; k < 3; k++) {
        var v = idx[t * 3 + k], o = t * 9 + k * 3;
        var x = info.min[0] + q[v * 3] / 65535 * span[0];
        var y = info.min[1] + q[v * 3 + 1] / 65535 * span[1];
        var z = info.min[2] + q[v * 3 + 2] / 65535 * span[2];
        pos[o] = x - W / 2; pos[o + 1] = z; pos[o + 2] = -(y - D / 2);
        col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    var below = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
    var above = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6);
    var solid = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0, clippingPlanes: [below] }));
    // What has not printed yet shows faintly above the current layer.
    var ghostMat = function(m){ return new THREE.MeshStandardMaterial(Object.assign({ roughness: 0.6, transparent: true, opacity: 0.3, depthWrite: false, clippingPlanes: [above] }, m)); };
    var ghost = new THREE.Mesh(geo, ghostMat({ vertexColors: true }));
    ghost.visible = false;
    scene.add(solid, ghost);

    var plate = new THREE.Mesh(new THREE.BoxGeometry(W, 2, D), new THREE.MeshStandardMaterial({ color: "#2b2b2f", roughness: 0.95 }));
    plate.position.y = -1;
    scene.add(plate);
    var grid = new THREE.GridHelper(W, W / 16, "#3d3d42", "#34343a");
    grid.position.y = 0.02;
    scene.add(grid);
    if (info.tower) {
      var tw = info.tower, th = Math.max(1, tw.h);
      var towerGeo = new THREE.BoxGeometry(tw.x1 - tw.x0, th, tw.y1 - tw.y0);
      var tower = new THREE.Mesh(towerGeo, new THREE.MeshStandardMaterial({ color: "#5a5a60", roughness: 0.8, clippingPlanes: [below] }));
      var towerGhost = new THREE.Mesh(towerGeo, ghostMat({ color: "#5a5a60" }));
      tower.position.set((tw.x0 + tw.x1) / 2 - W / 2, th / 2, -((tw.y0 + tw.y1) / 2 - D / 2));
      towerGhost.position.copy(tower.position);
      scene.add(tower, towerGhost);
    }

    scene.add(new THREE.HemisphereLight("#ffffff", "#2a2a2e", 1.4));
    var key = new THREE.DirectionalLight("#ffffff", 2.2); key.position.set(180, 320, 240); scene.add(key);
    var fill = new THREE.DirectionalLight("#ffffff", 0.7); fill.position.set(-220, 160, -180); scene.add(fill);

    var center = new THREE.Vector3(
      (info.min[0] + info.max[0]) / 2 - W / 2,
      (info.min[2] + info.max[2]) / 2,
      -((info.min[1] + info.max[1]) / 2 - D / 2));
    var radius = Math.max(20, Math.hypot(span[0], span[1], span[2]) / 2);
    var camera = new THREE.PerspectiveCamera(35, 16 / 9, 1, 4000);
    var controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.minDistance = radius * 0.5; controls.maxDistance = Math.max(W, D) * 3;
    controls.maxPolarAngle = Math.PI * 0.495;
    function home(){
      camera.position.copy(center).add(new THREE.Vector3(0.75, 0.62, 1).normalize().multiplyScalar(radius * 2.6));
      controls.target.copy(center); controls.update(); kick();
    }

    var frames = 0;
    function draw(){ if (controls.update()) frames = Math.max(frames, 2); renderer.render(scene, camera); if (--frames > 0) requestAnimationFrame(draw); }
    function kick(){ if (frames <= 0) { frames = 30; requestAnimationFrame(draw); } else frames = 30; }
    controls.addEventListener("change", kick);
    controls.addEventListener("start", function(){ $("hint").style.opacity = "0"; });
    function resize(){
      var w = pane.clientWidth, h = pane.clientHeight; if (!w || !h) return;
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); kick();
    }
    function progress(){
      var printing = (S.phase === "printing" || S.phase === "paused" || S.phase === "preparing") && S.layer != null && S.totalLayers;
      var cut = printing ? info.max[2] * Math.min(1, S.layer / S.totalLayers) : 1e6;
      below.constant = cut; above.constant = -cut; ghost.visible = !!printing;
      if (typeof towerGhost !== "undefined") towerGhost.visible = !!printing;
      kick();
    }
    window.addEventListener("resize", resize);
    $("resetBtn").addEventListener("click", home);
    $("hint").textContent = matchMedia("(pointer: coarse)").matches ? "Drag to turn, pinch to zoom" : "Drag to turn, scroll to zoom";
    $("hint").classList.remove("hide");
    resize(); progress(); home();
    return { resize: resize, progress: progress };
  }

  /* ---- status ---------------------------------------------------------- */

  function pullStatus(){
    if (document.visibilityState !== "visible") return;
    fetch("status.json?t=" + Date.now(), {cache: "no-store"}).then(function(r){ return r.ok ? r.json() : null; }).then(function(j){ if (j) { S = j; render(); } }).catch(function(){});
  }

  render();
  pullFrame();
  setInterval(function(){ watch(); pullFrame(); startVideo(); }, 2000);
  setInterval(pullStatus, 4000);
  document.addEventListener("visibilitychange", function(){
    if (document.visibilityState !== "visible") return;
    pullStatus(); pullFrame();
    if (playing) { play(); toLiveEdge(); } else startVideo();
  });
})();
</script>
</body>
</html>`;
}
