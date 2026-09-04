/** Self-contained trading dashboard page (no build step). */
export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Quant — Trading</title>
<style>
  :root { --bg:#0b0e14; --panel:#151a23; --line:#252c39; --fg:#e6edf3; --mut:#8b96a5; --grn:#3fb950; --red:#f85149; --acc:#58a6ff; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--fg); }
  header { display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid var(--line); }
  header h1 { font-size:16px; margin:0; }
  .kill { margin-left:auto; display:flex; align-items:center; gap:8px; }
  .killbtn { border:1px solid var(--line); background:var(--panel); color:var(--fg); padding:6px 12px; border-radius:8px; cursor:pointer; font-weight:600; }
  .killbtn.on { background:var(--red); border-color:var(--red); color:#fff; }
  .banner { background:var(--red); color:#fff; text-align:center; padding:6px; font-weight:600; display:none; }
  .banner.show { display:block; }
  nav { display:flex; gap:4px; padding:8px 16px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  nav button { background:none; border:1px solid transparent; color:var(--mut); padding:6px 12px; border-radius:8px; cursor:pointer; }
  nav button.active { color:var(--fg); background:var(--panel); border-color:var(--line); }
  main { padding:16px; max-width:1000px; margin:0 auto; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:16px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--mut); font-weight:600; }
  .grn { color:var(--grn); } .red { color:var(--red); } .mut { color:var(--mut); }
  .big { font-size:28px; font-weight:700; }
  .row { display:flex; gap:24px; flex-wrap:wrap; }
  label { display:block; color:var(--mut); font-size:12px; margin:8px 0 2px; }
  input,textarea { width:100%; background:var(--bg); border:1px solid var(--line); color:var(--fg); border-radius:8px; padding:8px; font:inherit; }
  button.act { background:var(--acc); border:none; color:#001; padding:8px 16px; border-radius:8px; cursor:pointer; font-weight:600; margin-top:12px; }
  .login { max-width:320px; margin:80px auto; }
  pre { white-space:pre-wrap; word-break:break-word; }
  .pill { font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--mut); }
</style>
</head>
<body>
<div id="app"><div class="login card" id="login">
  <h1>Quant</h1><p class="mut">Enter dashboard PIN.</p>
  <input id="pin" type="password" placeholder="PIN" />
  <button class="act" onclick="login()">Unlock</button>
  <p id="loginerr" class="red"></p>
</div></div>

<script>
const $ = (id) => document.getElementById(id);
async function api(path, opts){ const r = await fetch('/api'+path, {credentials:'same-origin', ...opts});
  if(r.status===401){ showLogin(); throw new Error('unauth'); } return r.json(); }
function fmt(n){ return (n==null||isNaN(n))?'—':'$'+Number(n).toLocaleString(undefined,{maximumFractionDigits:2}); }

async function login(){ const pin=$('pin').value;
  const r=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin})});
  if(r.ok){ boot(); } else { $('loginerr').textContent=(await r.json()).error||'failed'; } }
// Every value that came from the model or the broker goes through esc()
// before it reaches innerHTML. A symbol, a thesis or an audit detail is
// attacker-influenced text, not markup.
function esc(s){ return String(s??'').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]); }
function showLogin(){ location.reload(); }

let TAB='portfolio';
const TABS=['portfolio','orders','policy','triggers','journal','audit'];

function shell(){
  $('app').innerHTML = \`
    <div id="banner" class="banner">KILL SWITCH ON — autonomous trading halted</div>
    <header><h1>Quant — Robinhood</h1>
      <div class="kill"><span class="mut" id="acct"></span>
        <button id="killbtn" class="killbtn" onclick="toggleKill()">Kill switch</button></div>
    </header>
    <nav>\${TABS.map(t=>\`<button onclick="go('\${t}')" id="tab-\${t}">\${t}</button>\`).join('')}</nav>
    <main id="view"></main>\`;
  go(TAB);
  refreshKill();
}
function go(t){ TAB=t; for(const x of TABS) $('tab-'+x)?.classList.toggle('active',x===t); render(); }

async function refreshKill(){ const k=await api('/killswitch'); const b=$('killbtn'), ban=$('banner');
  b.classList.toggle('on',k.on); b.textContent=k.on?'KILL SWITCH ON':'Kill switch off';
  ban.classList.toggle('show',k.on); }
async function toggleKill(){ const k=await api('/killswitch'); await api('/killswitch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({on:!k.on})}); refreshKill(); }

async function render(){ const v=$('view'); v.innerHTML='<p class="mut">Loading…</p>';
  try{
    if(TAB==='portfolio') return renderPortfolio(v);
    if(TAB==='orders') return renderOrders(v);
    if(TAB==='policy') return renderPolicy(v);
    if(TAB==='triggers') return renderTriggers(v);
    if(TAB==='journal') return renderJournal(v);
    if(TAB==='audit') return renderAudit(v);
  }catch(e){ if(String(e).includes('unauth'))return; v.innerHTML='<p class="red">'+esc(e)+'</p>'; }
}

async function renderPortfolio(v){ const d=await api('/portfolio'); $('acct').textContent=d.account?('acct '+d.account):'account not set';
  const live=d.live&&!d.live.error?d.live:null; const snap=d.cachedSnapshot;
  const p=live?.portfolio||snap||{};
  let pos = live?.positions||[];
  v.innerHTML=\`<div class="card"><div class="row">
      <div><label>Equity</label><div class="big">\${fmt(p.equity)}</div></div>
      <div><label>Cash</label><div class="big">\${fmt(p.cash)}</div></div>
      <div><label>Buying power</label><div class="big">\${fmt(p.buyingPower)}</div></div>
    </div><p class="mut">\${live?'live':'cached snapshot'} \${d.live?.error?('— live error: '+esc(d.live.error)):''}</p></div>
    <div class="card"><h3>Positions</h3>\${pos.length?\`<table><tr><th>Symbol</th><th>Qty</th><th>Avg cost</th><th>Value</th></tr>
      \${pos.map(x=>\`<tr><td>\${esc(x.symbol)}</td><td>\${esc(x.quantity)}</td><td>\${fmt(x.avgCost)}</td><td>\${fmt(x.marketValue)}</td></tr>\`).join('')}</table>\`
      :'<p class="mut">No live positions (configure code-level auth for live data, or check in chat).</p>'}</div>\`;
}

async function renderOrders(v){ const d=await api('/orders');
  v.innerHTML=\`<div class="card"><h3>Orders</h3>\${d.orders.length?\`<table>
    <tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Status</th><th>Fill</th></tr>
    \${d.orders.map(o=>\`<tr><td class="mut">\${new Date(o.submittedAt).toLocaleString()}</td><td>\${esc(o.symbol)}</td>
      <td class="\${o.side==='buy'?'grn':'red'}">\${esc(o.side)}</td><td>\${esc(o.qty)}</td><td>\${esc(o.status)}</td>
      <td>\${o.avgFillPrice?fmt(o.avgFillPrice):'—'}</td></tr>\`).join('')}</table>\`:'<p class="mut">No orders yet.</p>'}</div>\`;
}

async function renderPolicy(v){ const p=await api('/policy'); const l=p.limits;
  v.innerHTML=\`<div class="card"><h3>Policy <span class="pill">v\${esc(p.version)}</span></h3>
    <label>Vision (operator guidance)</label><textarea id="vision" rows="3">\${esc(p.vision||'')}</textarea>
    <div class="row">
      <div style="flex:1"><label>Max % per position (0–1)</label><input id="maxpct" value="\${esc(l.maxPctPerName)}"/></div>
      <div style="flex:1"><label>Max position $</label><input id="maxpos" value="\${esc(l.maxPositionUSD)}"/></div>
    </div><div class="row">
      <div style="flex:1"><label>Daily loss limit $</label><input id="dll" value="\${esc(l.dailyLossLimitUSD)}"/></div>
      <div style="flex:1"><label>Cash floor $</label><input id="floor" value="\${esc(l.cashFloorUSD)}"/></div>
      <div style="flex:1"><label>Max trades/day</label><input id="mtd" value="\${esc(l.maxTradesPerDay)}"/></div>
    </div>
    <label>Forbidden symbols (comma-sep)</label><input id="forbid" value="\${esc((l.forbiddenSymbols||[]).join(', '))}"/>
    <button class="act" onclick="savePolicy()">Save policy</button>
    <p id="psaved" class="grn"></p></div>\`;
}
async function savePolicy(){ const limits={
    maxPctPerName:parseFloat($('maxpct').value), maxPositionUSD:parseFloat($('maxpos').value),
    dailyLossLimitUSD:parseFloat($('dll').value), cashFloorUSD:parseFloat($('floor').value),
    maxTradesPerDay:parseInt($('mtd').value), forbiddenSymbols:$('forbid').value.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean) };
  const p=await api('/policy',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({vision:$('vision').value,limits})});
  $('psaved').textContent='Saved v'+p.version; }

async function renderTriggers(v){ const d=await api('/triggers');
  v.innerHTML=\`<div class="card"><h3>Armed price triggers</h3>\${d.armed.length?\`<table>
    <tr><th>Symbol</th><th>Dir</th><th>Threshold</th><th>Note</th></tr>
    \${d.armed.map(t=>\`<tr><td>\${esc(t.symbol)}</td><td>\${esc(t.direction)}</td><td>\${fmt(t.threshold)}</td><td class="mut">\${esc(t.note||'')}</td></tr>\`).join('')}</table>\`
    :'<p class="mut">No armed triggers. Quant arms these from chat.</p>'}</div>\`;
}

async function renderJournal(v){ const d=await api('/journal');
  v.innerHTML=\`<div class="card"><h3>Decisions</h3>\${d.decisions.length?\`<table>
    <tr><th>Time</th><th>Source</th><th>Verdict</th><th>Thesis</th></tr>
    \${d.decisions.map(x=>\`<tr><td class="mut">\${new Date(x.createdAt).toLocaleString()}</td><td>\${esc(x.wakeSource)}</td>
      <td>\${esc(x.verdict)}</td><td><pre>\${esc((x.thesis||'').slice(0,300))}</pre></td></tr>\`).join('')}</table>\`:'<p class="mut">No decisions yet.</p>'}</div>\`;
}
async function renderAudit(v){ const d=await api('/audit');
  v.innerHTML=\`<div class="card"><h3>Audit log</h3><table><tr><th>Time</th><th>Actor</th><th>Event</th><th>Detail</th></tr>
    \${d.audit.map(a=>\`<tr><td class="mut">\${new Date(a.at).toLocaleString()}</td><td>\${esc(a.actor)}</td><td>\${esc(a.event)}</td><td class="mut">\${esc(a.detail||'')}</td></tr>\`).join('')}</table></div>\`;
}

async function boot(){ const s=await fetch('/api/auth/status').then(r=>r.json());
  if(s.authenticated){ shell(); } else { /* show login (already default) */ } }
boot();
</script>
</body>
</html>`;
