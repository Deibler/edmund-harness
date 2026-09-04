/**
 * The shelf check, as a deck of cards.
 *
 * One item, one question, one gesture. Right if the ledger has it correct, left
 * if it does not, and only then does it ask which kind of wrong. Everything
 * about the pacing is chosen so somebody standing in front of an open fridge
 * gets through thirty items before they get bored, because a check that gets
 * abandoned at item six has taught the ledger almost nothing.
 *
 * WHY A DECK RATHER THAN A LIST. A list of thirty checkboxes is a form, and a
 * form is a thing you put off. A deck has no visible end, gives one decision at
 * a time, and every answer physically removes the question. It is the difference
 * between auditing and just looking, and looking is the only version anybody
 * actually does twice.
 *
 * WHAT IT WRITES. Nothing, directly. Every swipe posts a verdict to the same
 * callback endpoint the rest of the site uses; the drain records it and, at the
 * end, folds the whole pass into the ledger as one retractable batch. That means
 * a closed tab loses nothing, and a pass abandoned half way is still worth
 * exactly what it answered.
 *
 * WHO LOOKED IS NOT OPTIONAL. Attribution is the whole reason this beats a
 * guess, so the page will not start without a profile. Three people share this
 * kitchen and "the ledger thinks there are four onions" is a much weaker
 * statement than "Jordan counted four onions on Sunday".
 */

import type { Assets } from "./assets.ts";
import { DECK_SIZE, checkOrder } from "./reconcile.ts";
import { amount, daysLeft } from "./store.ts";
import type { Item } from "./types.ts";
import { escapeHtml } from "./util.ts";

export type CheckPageCtx = {
  title: string;
  /** Needed to read the log for who-checked-what and this kitchen's own shelf lives. */
  account: string;
  items: Item[];
  assets: Assets;
  /** Who has looked most recently, and when, for the opening line. */
  lastChecked?: { at: string; by: string | null } | null;
  /** principal -> display name, so a card can say whose pass this is. */
  people: Array<{ principal: string; label: string }>;
};

const ago = (iso: string): string => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
};

const CSS = `
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{
  --bg:32 24% 97%; --card:0 0% 100%; --ink:24 12% 12%; --ink-soft:24 8% 38%;
  --ink-faint:24 6% 55%; --line:28 14% 88%; --accent:14 72% 47%;
  --good:142 52% 34%; --warn:38 88% 42%; --bad:0 68% 48%; --tap:48px;
}
@media (prefers-color-scheme:dark){:root{
  --bg:24 10% 8%; --card:24 10% 12%; --ink:32 20% 94%; --ink-soft:30 8% 72%;
  --ink-faint:28 6% 55%; --line:24 8% 22%; --accent:14 82% 60%;
}}
html,body{height:100%}
body{background:hsl(var(--bg));color:hsl(var(--ink));overflow:hidden;
  font:400 16px/1.5 ui-sans-serif,-apple-system,system-ui,sans-serif;
  display:flex;flex-direction:column}
.wrap{max-width:560px;margin:0 auto;width:100%;padding:0 18px}

header{flex:0 0 auto;border-bottom:1px solid hsl(var(--line));background:hsl(var(--bg))}
header .row{display:flex;align-items:center;gap:10px;min-height:54px}
a.back{display:inline-flex;align-items:center;gap:6px;color:hsl(var(--ink-soft));
  text-decoration:none;font:600 13px/1 ui-sans-serif,system-ui,sans-serif;
  min-height:var(--tap)}
.count{margin-left:auto;font:700 13px/1 ui-sans-serif,system-ui,sans-serif;
  font-variant-numeric:tabular-nums;color:hsl(var(--ink-faint))}
.prog{height:3px;background:hsl(var(--line));position:relative}
.prog i{position:absolute;inset:0 auto 0 0;background:hsl(var(--accent));width:0;transition:width .25s}

main{flex:1 1 auto;position:relative;overflow:hidden}
.deck{position:absolute;inset:0;display:grid;place-items:center;padding:20px 18px}
.c{position:absolute;width:min(100%,420px);background:hsl(var(--card));
  border:1px solid hsl(var(--line));border-radius:20px;overflow:hidden;
  box-shadow:0 10px 30px hsl(var(--ink)/.09);will-change:transform;touch-action:pan-y}
.c .shot{aspect-ratio:4/3;background:hsl(var(--line));position:relative;overflow:hidden}
.c .shot img{width:100%;height:100%;object-fit:cover;display:block;opacity:0;transition:opacity .3s}
.c .shot img.ready{opacity:1}
.c .mono{position:absolute;inset:0;display:grid;place-items:center;
  font:700 40px/1 ui-serif,Georgia,serif;color:hsl(var(--ink-faint))}
.c .b{padding:17px 19px 21px}
.c h2{font:600 25px/1.2 ui-serif,Georgia,serif;letter-spacing:-.01em}
.c .qty{margin-top:12px;padding-top:12px;border-top:1px solid hsl(var(--ink)/.85);
  display:flex;align-items:baseline;gap:10px}
.c .qty b{font:700 22px/1 ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums}
.c .qty span{color:hsl(var(--ink-faint));font-size:13.5px}
.c .meta{margin-top:11px;color:hsl(var(--ink-faint));font-size:13.5px}
/* The verdict stamps, revealed by the drag itself rather than by a button. */
.c .stamp{position:absolute;top:16px;padding:7px 13px;border-radius:8px;
  font:800 13px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.12em;
  text-transform:uppercase;opacity:0;transition:opacity .12s;border:2px solid}
.c .yes{left:16px;color:hsl(var(--good));border-color:hsl(var(--good));transform:rotate(-9deg)}
.c .no{right:16px;color:hsl(var(--bad));border-color:hsl(var(--bad));transform:rotate(9deg)}

footer{flex:0 0 auto;border-top:1px solid hsl(var(--line));background:hsl(var(--bg));
  padding:12px 0 calc(12px + env(safe-area-inset-bottom))}
.acts{display:flex;gap:10px}
.btn{flex:1;min-height:52px;border:0;border-radius:13px;cursor:pointer;
  font:600 15px/1.2 ui-sans-serif,system-ui,sans-serif;padding:12px 14px;
  background:hsl(var(--ink));color:hsl(var(--bg))}
.btn.alt{background:transparent;color:hsl(var(--ink));border:1px solid hsl(var(--line))}
.btn.bad{background:transparent;color:hsl(var(--bad));border:1px solid hsl(var(--bad)/.5)}
.btn.ok{background:transparent;color:hsl(var(--good));border:1px solid hsl(var(--good)/.5)}
.hint{text-align:center;color:hsl(var(--ink-faint));font-size:12.5px;margin-top:10px}

.pad{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:4px}
.pad button{min-height:52px;border:1px solid hsl(var(--line));border-radius:12px;
  background:hsl(var(--card));color:hsl(var(--ink));cursor:pointer;
  font:600 19px/1 ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums}
.pad button.wide{grid-column:span 3;font-size:15px}
.amt{display:flex;align-items:center;justify-content:center;gap:16px;margin:6px 0 14px}
.amt .v{font:700 42px/1 ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums;
  min-width:96px;text-align:center}
.amt button{width:56px;height:56px;border-radius:50%;border:1px solid hsl(var(--line));
  background:hsl(var(--card));color:hsl(var(--ink));font:400 28px/1 ui-sans-serif,system-ui,sans-serif;
  cursor:pointer}
.unit{text-align:center;color:hsl(var(--ink-faint));font-size:14px;margin-bottom:6px}

.sheet{position:fixed;inset:0;z-index:90;display:none}
.sheet.on{display:block}
.sheet .bg{position:absolute;inset:0;background:hsl(var(--ink)/.45)}
/* Heights are dvh, not vh.
   On iOS, vh means the viewport with the URL bar HIDDEN, so a sheet anchored to
   the bottom at 92vh extends past the top of what you can actually see and its
   title and close button end up behind the browser chrome. dvh tracks the real
   visible height. vh stays as the first declaration for anything that does not
   know dvh, since being slightly too tall beats collapsing to nothing. */
.sheet .pane{position:absolute;left:0;right:0;bottom:0;max-height:88vh;max-height:84dvh;
  overflow-y:auto;overscroll-behavior:contain;
  background:hsl(var(--bg));border-radius:20px 20px 0 0;
  padding:8px 18px calc(20px + env(safe-area-inset-bottom))}
.sheet .grab{width:38px;height:4px;border-radius:2px;background:hsl(var(--line));margin:6px auto 14px}
.sheet h3{font:600 21px/1.25 ui-serif,Georgia,serif;margin-bottom:6px}
.sheet p{color:hsl(var(--ink-soft));font-size:15px;margin-bottom:16px}
.who{display:flex;align-items:center;gap:11px;width:100%;padding:14px 12px;border-radius:12px;
  border:1px solid hsl(var(--line));background:hsl(var(--card));margin-bottom:9px;
  min-height:var(--tap);cursor:pointer;color:hsl(var(--ink));font-size:16px;text-align:left}
.who .av{width:32px;height:32px;border-radius:50%;background:hsl(var(--ink));color:hsl(var(--bg));
  display:grid;place-items:center;font:700 13px/1 ui-sans-serif,system-ui,sans-serif}

.done{position:absolute;inset:0;display:none;place-items:center;padding:24px 18px;text-align:center}
.done.on{display:grid}
.done h2{font:600 27px/1.2 ui-serif,Georgia,serif;margin-bottom:12px}
.done p{color:hsl(var(--ink-soft));margin-bottom:8px}
.done .sum{margin:16px 0 22px;text-align:left;width:min(100%,420px)}
.done .sum div{display:flex;justify-content:space-between;gap:12px;padding:11px 0;
  border-bottom:1px solid hsl(var(--line));font-size:15px}
.done .sum b{font-variant-numeric:tabular-nums}
.toast{position:fixed;left:50%;bottom:calc(84px + env(safe-area-inset-bottom));
  transform:translate(-50%,10px);background:hsl(var(--ink));color:hsl(var(--bg));
  padding:12px 17px;border-radius:12px;font:500 14px/1.4 ui-sans-serif,system-ui,sans-serif;
  max-width:min(420px,90vw);opacity:0;pointer-events:none;transition:.22s;z-index:95}
.toast.on{opacity:1;transform:translate(-50%,0)}
`;

export function renderCheckPage(ctx: CheckPageCtx): string {
  // Ordered and capped by checkOrder, so the deck opens on the chicken rather
  // than the steak sauce and ends before it becomes a chore. Shared with the
  // version I drive over text, so both ask in the same order.
  const deck = checkOrder(ctx.items, Date.now(), DECK_SIZE, ctx.account).map((i) => ({
    id: i.id,
    name: i.name,
    amount: amount(i),
    qty: i.qty,
    unit: i.unit,
    level: i.level,
    loc: i.loc,
    cat: i.cat,
    photo: ctx.assets.items.has(i.id) ? `img/items/${i.id}.jpg` : null,
    seen: ago(i.updated || i.added),
    days: daysLeft(i),
  }));

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Shelf check</title>
<style>${CSS}</style>
</head><body>
<div id="instant-share-admin" hidden></div>

<header>
  <div class="wrap row">
    <a class="back" id="back" href="index.html">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round"><path d="M15 6l-6 6 6 6"/></svg>Done for now</a>
    <span class="count" id="count"></span>
  </div>
  <div class="prog"><i id="bar"></i></div>
</header>

<main>
  <div class="deck" id="deck"></div>
  <div class="done" id="done"><div>
    <h2 id="dhead">That is the lot</h2>
    <p id="dsub"></p>
    <div class="sum" id="dsum"></div>
    <button class="btn" id="finish">Save what I checked</button>
  </div></div>
</main>

<footer><div class="wrap">
  <div class="acts" id="acts">
    <button class="btn bad" data-v="no">Not right</button>
    <button class="btn ok" data-v="yes">Yes, that is right</button>
  </div>
  <div class="hint" id="hint">Swipe right if the ledger has it correct, left if it does not.</div>
</div></footer>

<div class="sheet" id="who"><div class="bg"></div><div class="pane">
  <div class="grab"></div>
  <h3>Who is looking?</h3>
  <p>A count is worth keeping because somebody actually looked. It should say who.</p>
  <div id="wholist"></div>
</div></div>

<div class="sheet" id="wrong"><div class="bg" data-close></div><div class="pane">
  <div class="grab"></div>
  <h3 id="whead"></h3>
  <p id="wsub"></p>
  <div class="acts" style="flex-direction:column">
    <button class="btn alt" id="gone">It is not here any more</button>
    <button class="btn alt" id="wamount">The amount is wrong</button>
    <button class="btn alt" data-close>Never mind, go back</button>
  </div>
</div></div>

<div class="sheet" id="count-sheet"><div class="bg" data-close></div><div class="pane">
  <div class="grab"></div>
  <h3 id="chead"></h3>
  <div class="amt">
    <button id="minus" aria-label="one less">-</button>
    <div class="v" id="cval">0</div>
    <button id="plus" aria-label="one more">+</button>
  </div>
  <div class="unit" id="cunit"></div>
  <div class="pad" id="cpad"></div>
  <div class="acts" style="margin-top:14px">
    <button class="btn alt" data-close style="flex:1">Cancel</button>
    <button class="btn" id="csave" style="flex:2">That is the amount</button>
  </div>
</div></div>

<div class="toast" id="toast"></div>

<script type="application/json" id="d">${JSON.stringify({
    deck,
    people: ctx.people,
    lastChecked: ctx.lastChecked ?? null,
  }).replace(/</g, "\\u003c")}</script>
<script>
(function(){
  var KEY = location.search || '';
  var D = JSON.parse(document.getElementById('d').textContent);
  document.getElementById('back').href = 'index.html' + KEY;

  function esc(s){ var d=document.createElement('div'); d.textContent=s==null?'':s; return d.innerHTML; }
  var toast = document.getElementById('toast'), tt;
  function say(m){ toast.textContent=m; toast.classList.add('on');
    clearTimeout(tt); tt=setTimeout(function(){toast.classList.remove('on');},3200); }

  // ── who. The pass is worthless unsigned, so this is asked before anything.
  function cookie(k, v){
    if (v === undefined) {
      var m = document.cookie.match(new RegExp('(?:^|; )'+k+'=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    }
    document.cookie = k+'='+encodeURIComponent(v)+';path=/;max-age='+(60*60*24*365)+';SameSite=Lax';
    return v;
  }
  var me = cookie('kitchen_profile');
  if (D.people.length === 1) me = D.people[0].principal;
  if (me && !D.people.some(function(p){ return p.principal === me; })) me = null;

  function askWho(){
    document.getElementById('wholist').innerHTML = D.people.map(function(p){
      return '<button class="who" data-pick="'+esc(p.principal)+'">'+
        '<span class="av">'+esc(p.label.slice(0,1).toUpperCase())+'</span>'+esc(p.label)+'</button>';
    }).join('') || '<p>No profiles on this household yet.</p>';
    document.getElementById('who').classList.add('on');
  }
  document.getElementById('wholist').addEventListener('click', function(e){
    var b = e.target.closest('[data-pick]'); if (!b) return;
    me = cookie('kitchen_profile', b.dataset.pick);
    document.getElementById('who').classList.remove('on');
    var them = D.people.filter(function(p){ return p.principal === me; })[0];
    say('Signed in as ' + (them ? them.label : 'you') + '. This pass is yours.');
  });

  // ── session. Invented here rather than negotiated, so the first swipe is
  //    instant even on a bad connection.
  var SID = 'rc-' + Date.now().toString(36) + Math.floor(Math.random()*1e4).toString(36);
  var at = 0, answers = [];

  function post(p){
    p.ts = new Date().toISOString();
    p.profile = me || null;
    return fetch('/callback' + KEY, {method:'POST',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify(p)});
  }
  function record(item, verdict, qty, unit){
    answers.push({item:item, verdict:verdict, qty:qty});
    // Fire and forget. Each answer is independently useful, so a dropped one
    // costs that item and nothing else; the deck must never wait on the network.
    post({kind:'reconcile', session:SID, item:item, note:verdict, qty:qty, unit:unit})
      .catch(function(){});
  }

  // ── the deck
  var deckEl = document.getElementById('deck');
  var card = null;

  function paintCount(){
    var total = D.deck.length;
    document.getElementById('count').textContent = total ? (Math.min(at+1,total) + ' of ' + total) : '';
    document.getElementById('bar').style.width = total ? (at / total * 100) + '%' : '0';
  }

  function build(i){
    var it = D.deck[i]; if (!it) return null;
    var el = document.createElement('article');
    el.className = 'c';
    el.innerHTML =
      '<div class="stamp yes">Have it</div><div class="stamp no">Not right</div>' +
      '<div class="shot">' + (it.photo
        ? '<img data-img="'+esc(it.photo)+'" alt="">'
        : '<div class="mono">'+esc((it.name||'?').slice(0,2).toUpperCase())+'</div>') + '</div>' +
      '<div class="b"><h2>'+esc(it.name)+'</h2>' +
      '<div class="qty"><b>'+esc(it.amount)+'</b><span>in the '+esc(it.loc)+'</span></div>' +
      '<div class="meta">Last touched '+esc(it.seen)+
        (it.days !== null && it.days !== undefined
          ? ' &middot; ' + (it.days <= 0 ? 'past its date' : it.days + ' days left') : '') +
      '</div></div>';
    var img = el.querySelector('img[data-img]');
    if (img) {
      img.addEventListener('load', function(){ img.classList.add('ready'); });
      img.addEventListener('error', function(){
        var w = img.parentNode; img.remove();
        var d = document.createElement('div'); d.className = 'mono';
        d.textContent = (it.name||'?').slice(0,2).toUpperCase(); w.appendChild(d);
      });
      img.src = it.photo + KEY;
    }
    return el;
  }

  function show(){
    deckEl.innerHTML = '';
    card = build(at);
    if (!card) { finishDeck(); return; }
    deckEl.appendChild(card);
    drag(card);
    paintCount();
  }

  function fly(dir, then){
    if (!card) { then && then(); return; }
    var c = card; card = null;
    c.style.transition = 'transform .28s ease, opacity .28s ease';
    c.style.transform = 'translateX(' + (dir * 620) + 'px) rotate(' + (dir * 18) + 'deg)';
    c.style.opacity = '0';
    setTimeout(function(){ at++; then && then(); show(); }, 200);
  }

  function verdictYes(){
    var it = D.deck[at]; if (!it) return;
    record(it.id, 'have', null, null);
    fly(1);
  }
  function verdictNo(){
    var it = D.deck[at]; if (!it) return;
    document.getElementById('whead').textContent = it.name;
    document.getElementById('wsub').textContent =
      'The ledger says ' + it.amount + ' in the ' + it.loc + '. What is actually true?';
    document.getElementById('wrong').classList.add('on');
  }

  // Dragging. The stamps appear as you pull, so the gesture explains itself the
  // first time without a tutorial.
  function drag(el){
    var x0 = 0, y0 = 0, dx = 0, active = false, decided = false;
    var yes = el.querySelector('.yes'), no = el.querySelector('.no');
    function down(e){
      var t = e.touches ? e.touches[0] : e;
      x0 = t.clientX; y0 = t.clientY; dx = 0; active = true; decided = false;
      el.style.transition = 'none';
    }
    function move(e){
      if (!active) return;
      var t = e.touches ? e.touches[0] : e;
      dx = t.clientX - x0;
      var dy = t.clientY - y0;
      // A mostly-vertical drag is the page being scrolled, not an answer.
      if (!decided && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) { active = false; return; }
      decided = true;
      el.style.transform = 'translateX('+dx+'px) rotate('+(dx/22)+'deg)';
      yes.style.opacity = dx > 24 ? Math.min(1, (dx-24)/70) : 0;
      no.style.opacity  = dx < -24 ? Math.min(1, (-dx-24)/70) : 0;
      if (e.cancelable) e.preventDefault();
    }
    function up(){
      if (!active) return;
      active = false;
      el.style.transition = 'transform .2s ease';
      if (dx > 95) { verdictYes(); return; }
      if (dx < -95) {
        el.style.transform = ''; yes.style.opacity = 0; no.style.opacity = 0;
        verdictNo(); return;
      }
      el.style.transform = ''; yes.style.opacity = 0; no.style.opacity = 0;
    }
    el.addEventListener('touchstart', down, {passive:true});
    el.addEventListener('touchmove', move, {passive:false});
    el.addEventListener('touchend', up);
    el.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  document.getElementById('acts').addEventListener('click', function(e){
    var b = e.target.closest('[data-v]'); if (!b) return;
    if (!me) { askWho(); return; }
    if (b.dataset.v === 'yes') verdictYes(); else verdictNo();
  });
  document.addEventListener('keydown', function(e){
    if (document.querySelector('.sheet.on')) return;
    if (e.key === 'ArrowRight') verdictYes();
    if (e.key === 'ArrowLeft') verdictNo();
  });

  // ── the two kinds of wrong
  document.addEventListener('click', function(e){
    if (e.target.closest('[data-close]')) {
      document.querySelectorAll('.sheet.on').forEach(function(s){
        if (s.id !== 'who') s.classList.remove('on');
      });
    }
  });
  document.getElementById('gone').addEventListener('click', function(){
    var it = D.deck[at]; if (!it) return;
    document.getElementById('wrong').classList.remove('on');
    record(it.id, 'gone', null, null);
    fly(-1);
  });

  var cval = 0, cunitTxt = '';
  document.getElementById('wamount').addEventListener('click', function(){
    var it = D.deck[at]; if (!it) return;
    document.getElementById('wrong').classList.remove('on');
    cval = typeof it.qty === 'number' ? it.qty : 1;
    cunitTxt = it.unit || '';
    document.getElementById('chead').textContent = 'How much ' + it.name.toLowerCase() + '?';
    document.getElementById('cunit').textContent = cunitTxt
      ? cunitTxt + ' (the ledger said ' + it.amount + ')'
      : 'the ledger said ' + it.amount;
    // Quick picks, because most corrections are small whole numbers and a
    // stepper from 12 to 2 is ten taps nobody will do.
    document.getElementById('cpad').innerHTML =
      [0,1,2,3,4,6,8,10,12].map(function(n){
        return '<button data-n="'+n+'">'+n+'</button>'; }).join('') +
      '<button class="wide" data-n="half">About half of what it said</button>';
    paintVal();
    document.getElementById('count-sheet').classList.add('on');
  });
  function paintVal(){ document.getElementById('cval').textContent = String(cval); }
  document.getElementById('minus').addEventListener('click', function(){
    cval = Math.max(0, Math.round((cval - 1) * 100) / 100); paintVal(); });
  document.getElementById('plus').addEventListener('click', function(){
    cval = Math.round((cval + 1) * 100) / 100; paintVal(); });
  document.getElementById('cpad').addEventListener('click', function(e){
    var b = e.target.closest('[data-n]'); if (!b) return;
    var it = D.deck[at];
    cval = b.dataset.n === 'half'
      ? Math.round(((typeof it.qty === 'number' ? it.qty : 2) / 2) * 100) / 100
      : Number(b.dataset.n);
    paintVal();
  });
  document.getElementById('csave').addEventListener('click', function(){
    var it = D.deck[at]; if (!it) return;
    document.getElementById('count-sheet').classList.remove('on');
    // Zero is not a correction, it is the thing being gone. Recording it as an
    // amount would leave a phantom item on the shelf at nothing.
    if (cval <= 0) record(it.id, 'gone', null, null);
    else record(it.id, 'amount', cval, cunitTxt || null);
    fly(-1);
  });

  // ── the end
  function finishDeck(){
    document.getElementById('acts').style.display = 'none';
    document.getElementById('hint').textContent = '';
    document.getElementById('done').classList.add('on');
    var yes = answers.filter(function(a){ return a.verdict === 'have'; }).length;
    var gone = answers.filter(function(a){ return a.verdict === 'gone'; }).length;
    var amt = answers.filter(function(a){ return a.verdict === 'amount'; }).length;
    document.getElementById('dsub').textContent = answers.length
      ? 'Nothing has been written yet. This is what the pass found.'
      : 'You did not answer anything, so there is nothing to save.';
    document.getElementById('dsum').innerHTML = answers.length
      ? '<div><span>Confirmed as listed</span><b>'+yes+'</b></div>' +
        '<div><span>No longer here</span><b>'+gone+'</b></div>' +
        '<div><span>Amount corrected</span><b>'+amt+'</b></div>'
      : '';
    document.getElementById('finish').style.display = answers.length ? '' : 'none';
    document.getElementById('bar').style.width = '100%';
  }
  document.getElementById('finish').addEventListener('click', function(){
    this.disabled = true; this.textContent = 'Saving';
    var self = this;
    post({kind:'reconcile', session:SID, note:'apply'})
      .then(function(){
        self.textContent = 'Saved';
        document.getElementById('dsub').textContent =
          'Written to the ledger as one batch, so it can be undone in one go.';
      })
      .catch(function(){ self.disabled=false; self.textContent='Save what I checked';
        say('Could not reach me just now.'); });
  });

  // ── boot
  if (!D.deck.length) { finishDeck();
    document.getElementById('dhead').textContent = 'Nothing needs checking';
    document.getElementById('dsub').textContent =
      'Everything on the shelves has been seen or logged in the last couple of days.';
  } else {
    show();
    if (!me) askWho();
    else if (D.lastChecked) say('Last checked ' + timeAgo(D.lastChecked.at));
  }
  function timeAgo(iso){
    var mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime())/60000));
    if (mins < 60) return mins + ' min ago';
    var h = Math.round(mins/60);
    if (h < 24) return h + ' hour' + (h===1?'':'s') + ' ago';
    var d = Math.round(h/24);
    return d + ' day' + (d===1?'':'s') + ' ago';
  }
})();
</script>
</body></html>`;
}
