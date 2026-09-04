/**
 * Server-rendered HTML for the mobile annotation page. Single file: inline
 * CSS + inline JS, no framework. Designed to work on iOS Safari and Chrome
 * with one-finger touch to draw rectangles on top of the image.
 *
 * The page never talks to the dashboard's authenticated API — it only POSTs
 * to the token-gated annotation endpoint, which verifies the token itself.
 */

export type PageInputs = {
  /** Public id of the annotation (for logging/debugging only — the key is in the URLs). */
  id: string;
  /** Token-authenticated URL the page loads the source image from. */
  imageUrl: string;
  /** Token-authenticated URL the page POSTs the annotated result to. */
  submitUrl: string;
  instruction: string | null;
};

export function renderAnnotatePage(input: PageInputs): string {
  const hint =
    escapeHtml(input.instruction?.trim()) ||
    "Drag to draw one or more red boxes around what you'd like changed, then add a comment and hit send.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>Mark up image</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; padding: 0; background: #0b0b0d; color: #eee;
    font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", system-ui, sans-serif;
    -webkit-text-size-adjust: 100%; }
  body { padding:
    env(safe-area-inset-top)
    env(safe-area-inset-right)
    env(safe-area-inset-bottom)
    env(safe-area-inset-left);
  }
  .wrap { max-width: 780px; margin: 0 auto; padding: 14px; }
  h1 { font-size: 15px; margin: 4px 0 10px; color: #aeb0b3; font-weight: 500; }
  .hint { font-size: 14px; color: #9a9c9f; margin: 0 0 12px; line-height: 1.45; }
  .stage { position: relative; background: #000; border-radius: 12px; overflow: hidden;
    touch-action: none; user-select: none; -webkit-user-select: none; }
  .stage img { display: block; width: 100%; height: auto; -webkit-user-drag: none; pointer-events: none; }
  .stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
  .toolbar { display: flex; gap: 8px; margin: 10px 0 12px; }
  .toolbar button { flex: 1; padding: 11px 12px; font-size: 15px; color: #e8e8ea;
    background: #1d1d20; border: 1px solid #2c2c30; border-radius: 9px;
    -webkit-tap-highlight-color: transparent; }
  .toolbar button:active { background: #2a2a2e; }
  .toolbar button:disabled { color: #555; }
  textarea { width: 100%; box-sizing: border-box; min-height: 96px; padding: 11px 12px;
    font-size: 16px; color: #eee; background: #141417; border: 1px solid #2c2c30;
    border-radius: 9px; resize: vertical; -webkit-appearance: none; font-family: inherit; }
  textarea:focus { outline: none; border-color: #3b74e0; }
  .send { display: block; width: 100%; margin-top: 12px; padding: 15px; font-size: 17px;
    font-weight: 600; color: #fff; background: #2a7cff; border: none; border-radius: 11px;
    -webkit-tap-highlight-color: transparent; }
  .send:active { background: #2368da; }
  .send:disabled { background: #333a46; color: #7a8090; }
  .count { font-size: 13px; color: #7a7c80; margin: -4px 0 10px; }
  .done, .err { text-align: center; padding: 48px 22px; font-size: 17px; line-height: 1.55; }
  .err { color: #ff6b6b; }
</style>
</head>
<body>
<div class="wrap" id="wrap">
  <h1>Mark up the image</h1>
  <p class="hint">${hint}</p>
  <div class="stage" id="stage">
    <img id="img" src="${escapeAttr(input.imageUrl)}" alt="Image to annotate" crossorigin="anonymous">
    <canvas id="canvas"></canvas>
  </div>
  <div class="count" id="count">0 regions drawn</div>
  <div class="toolbar">
    <button id="undo" type="button" disabled>Undo</button>
    <button id="clear" type="button" disabled>Clear</button>
  </div>
  <textarea id="comment" placeholder="Describe what you'd like changed — tie comments to the numbered boxes if helpful."></textarea>
  <button id="send" class="send" type="button">Send</button>
</div>
<div class="done" id="done" hidden>Sent. Edmund is working on it — check iMessage in a moment.</div>
<div class="err" id="expired" hidden></div>
<script>
(function() {
  "use strict";
  var POST = ${JSON.stringify(input.submitUrl)};
  var $ = function(id) { return document.getElementById(id); };
  var stage = $("stage"), img = $("img"), canvas = $("canvas");
  var ctx = canvas.getContext("2d");
  var undoBtn = $("undo"), clearBtn = $("clear");
  var commentEl = $("comment"), sendBtn = $("send"), countEl = $("count");
  var rects = [];
  var drawing = null;

  function resize() {
    var w = stage.clientWidth, h = stage.clientHeight;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + "px"; canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }

  function render() {
    var w = canvas.width / (window.devicePixelRatio || 1);
    var h = canvas.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, w, h);
    var items = rects.slice();
    if (drawing) items.push(drawing);
    ctx.lineWidth = 3;
    ctx.font = '600 14px -apple-system, system-ui, sans-serif';
    items.forEach(function(r, i) {
      var x = r.x * w, y = r.y * h, rw = r.w * w, rh = r.h * h;
      ctx.fillStyle = 'rgba(255, 59, 48, 0.22)';
      ctx.fillRect(x, y, rw, rh);
      ctx.strokeStyle = '#ff3b30';
      ctx.strokeRect(x, y, rw, rh);
      var label = String(i + 1);
      var lw = 26, lh = 22;
      ctx.fillStyle = '#ff3b30';
      ctx.fillRect(x, Math.max(0, y - lh), lw, lh);
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(label, x + lw / 2, Math.max(0, y - lh) + lh / 2);
    });
    var n = rects.length;
    countEl.textContent = n + (n === 1 ? " region drawn" : " regions drawn");
    undoBtn.disabled = n === 0;
    clearBtn.disabled = n === 0;
  }

  function pt(evt) {
    var r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (evt.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (evt.clientY - r.top) / r.height)),
    };
  }

  canvas.addEventListener('pointerdown', function(e) {
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    var p = pt(e);
    drawing = { x: p.x, y: p.y, w: 0, h: 0, sx: p.x, sy: p.y };
    render();
  });
  canvas.addEventListener('pointermove', function(e) {
    if (!drawing) return;
    var p = pt(e);
    drawing.x = Math.min(drawing.sx, p.x);
    drawing.y = Math.min(drawing.sy, p.y);
    drawing.w = Math.abs(p.x - drawing.sx);
    drawing.h = Math.abs(p.y - drawing.sy);
    render();
  });
  function finish() {
    if (!drawing) return;
    if (drawing.w > 0.012 && drawing.h > 0.012) {
      rects.push({ x: drawing.x, y: drawing.y, w: drawing.w, h: drawing.h });
    }
    drawing = null;
    render();
  }
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  canvas.addEventListener('pointerleave', finish);

  undoBtn.addEventListener('click', function() { rects.pop(); render(); });
  clearBtn.addEventListener('click', function() { rects.length = 0; render(); });

  img.addEventListener('load', resize);
  img.addEventListener('error', function() {
    $("wrap").hidden = true;
    var e = $("expired");
    e.textContent = "The image for this link is unavailable. The annotation session may have expired — ask Edmund to regenerate the link.";
    e.hidden = false;
  });
  window.addEventListener('resize', resize);
  if (img.complete && img.naturalWidth > 0) resize();

  sendBtn.addEventListener('click', async function() {
    var comment = commentEl.value.trim();
    if (!comment && rects.length === 0) {
      alert("Draw a region or add a comment before sending.");
      return;
    }
    sendBtn.disabled = true;
    var origText = sendBtn.textContent;
    sendBtn.textContent = "Sending…";
    try {
      var nw = img.naturalWidth || 1024, nh = img.naturalHeight || 1024;
      var out = document.createElement('canvas');
      out.width = nw; out.height = nh;
      var octx = out.getContext('2d');
      octx.drawImage(img, 0, 0, nw, nh);
      var scale = Math.min(nw, nh);
      octx.lineWidth = Math.max(3, Math.round(scale / 300));
      var fontSize = Math.max(14, Math.round(scale / 40));
      octx.font = '600 ' + fontSize + 'px -apple-system, system-ui, sans-serif';
      rects.forEach(function(r, i) {
        var x = r.x * nw, y = r.y * nh, w = r.w * nw, h = r.h * nh;
        octx.fillStyle = 'rgba(255, 59, 48, 0.22)';
        octx.fillRect(x, y, w, h);
        octx.strokeStyle = '#ff3b30';
        octx.strokeRect(x, y, w, h);
        var label = String(i + 1);
        var pad = Math.round(fontSize * 0.4);
        var lw = fontSize + pad * 2, lh = fontSize + pad;
        octx.fillStyle = '#ff3b30';
        octx.fillRect(x, Math.max(0, y - lh), lw, lh);
        octx.fillStyle = '#fff';
        octx.textBaseline = 'middle';
        octx.textAlign = 'center';
        octx.fillText(label, x + lw / 2, Math.max(0, y - lh) + lh / 2);
      });
      var dataUrl = out.toDataURL('image/png');
      var res = await fetch(POST, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: comment, rects: rects, annotatedPng: dataUrl }),
      });
      if (!res.ok) throw new Error("Server responded " + res.status);
      $("wrap").hidden = true;
      $("done").hidden = false;
    } catch (err) {
      alert("Send failed: " + (err.message || err));
      sendBtn.disabled = false;
      sendBtn.textContent = origText;
    }
  });
})();
</script>
</body>
</html>`;
}

export function renderExpiredPage(reason: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link unavailable</title>
<style>
  body { margin: 0; padding: 60px 22px; font-family: -apple-system, system-ui, sans-serif;
    background: #0b0b0d; color: #eee; text-align: center; line-height: 1.5; }
  h1 { font-size: 19px; margin: 0 0 12px; }
  p { color: #9a9c9f; font-size: 15px; }
</style></head>
<body><h1>Link unavailable</h1><p>${escapeHtml(reason)}</p></body></html>`;
}

function escapeHtml(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
