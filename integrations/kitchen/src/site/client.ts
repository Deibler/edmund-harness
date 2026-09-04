/**
 * Everything the page runs in the browser.
 *
 * Split out of `site.ts` on 2026-08-17 by moving text, unedited. It was 1,200
 * lines of JavaScript living inside a template literal inside the renderer,
 * which meant the server-side markup functions and the client-side event
 * handling were the same file and neither could be read on its own.
 *
 * It stays a string rather than becoming a real module because the page is a
 * single static file served from a token-guarded directory: there is no build
 * step and a second request for a .js file would need the key appended to it
 * the same way every image does. One file, one request, no key plumbing.
 *
 * The one thing it does not own is the nav labels, which live beside the nav
 * itself in `site.ts`. They arrive already serialised so this module needs no
 * imports at all.
 */

export function clientScript(labelsJson: string): string {
  return `<script>
(function(){
  var KEY = location.search || '';
  var D = JSON.parse(document.getElementById('data').textContent);

  // ── profile: two people share this link, so who is holding the phone has to
  //    be a real answer before "text this to me" or a favourite mean anything.
  function cookie(k, v){
    if (v === undefined) {
      var m = document.cookie.match(new RegExp('(?:^|; )'+k+'=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    }
    document.cookie = k+'='+encodeURIComponent(v)+';path=/;max-age='+(60*60*24*365)+';SameSite=Lax';
    return v;
  }
  var me = cookie('kitchen_profile');
  if (D.single && D.people.length) me = D.people[0].principal;
  if (me && !D.people.some(function(p){ return p.principal === me; })) me = null;

  function meLabel(){
    var p = D.people.filter(function(x){ return x.principal === me; })[0];
    return p ? p.label : null;
  }
  function paintProfile(){
    var l = meLabel();
    document.getElementById('whoami').textContent = l ? ('signed in as '+l) : 'pick a profile';
    document.getElementById('profilelist').innerHTML = D.people.map(function(p){
      var on = p.principal === me;
      return '<button class="who" data-pick="'+esc(p.principal)+'" style="'+
        (on ? 'border-color:hsl(var(--ink))' : '')+'">'+
        '<span class="avatar">'+esc(p.label.slice(0,1).toUpperCase())+'</span>'+
        '<span style="font-weight:500">'+esc(p.label)+'</span>'+
        (on ? '<span class="tag ready" style="margin-left:auto">You</span>' : '')+'</button>';
    }).join('');
  }

  // ── images
  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function(es){
    es.forEach(function(e){
      if (!e.isIntersecting) return;
      var img = e.target; io.unobserve(img);
      img.addEventListener('load', function(){ img.classList.add('ready'); });
      img.addEventListener('error', function(){
        var w = img.parentNode, alt = img.getAttribute('alt') || '';
        if (!w) return;
        img.remove();
        if (!alt) return;
        var d = document.createElement('div'); d.className = 'mono';
        d.textContent = alt.split(/\\s+/).filter(Boolean).slice(0,2)
          .map(function(x){return x[0].toUpperCase();}).join('');
        w.appendChild(d);
      });
      img.src = img.dataset.img + KEY;
    });
  }, {rootMargin:'500px'}) : null;
  function watch(root){
    (root||document).querySelectorAll('img[data-img]:not([src])').forEach(function(i){
      if (io) io.observe(i); else { i.src = i.dataset.img + KEY; i.classList.add('ready'); }
    });
  }

  function esc(s){ var d=document.createElement('div'); d.textContent=s==null?'':s; return d.innerHTML; }

  // ── sheets
  function openSheet(id){
    document.getElementById(id).classList.add('on');
    document.body.classList.add('locked');
  }
  function closeSheets(){
    document.querySelectorAll('.sheet.on').forEach(function(s){ s.classList.remove('on'); });
    document.body.classList.remove('locked');
  }
  document.addEventListener('click', function(e){
    if (e.target.closest('[data-close]')) { closeSheets(); }
  });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeSheets(); });

  // ── navigation
  var panels = {};
  document.querySelectorAll('[data-panel]').forEach(function(p){ panels[p.dataset.panel] = p; });
  var current = 'home';
  var LABEL = ${labelsJson};
  function go(name){
    if (!panels[name]) name = 'home';
    current = name;
    Object.keys(panels).forEach(function(k){ panels[k].classList.toggle('on', k === name); });
    document.querySelectorAll('[data-go]').forEach(function(b){
      if (b.dataset.go === name) b.setAttribute('aria-current','page');
      else b.removeAttribute('aria-current');
    });
    // On a phone the header is the only place that says where you are, so it
    // shows the page rather than the household once you have left Home.
    document.getElementById('where-t').textContent =
      name === 'home' ? D.title : LABEL[name];
    var ff = document.getElementById('filterbtn');
    ff.style.visibility = FILTERABLE[name] ? '' : 'hidden';
    closeSheets();
    // Just the fragment: a relative '#name' keeps the path and the ?key= query,
    // whereas appending location.search produced '#home?key=' and broke deep links.
    if (location.hash.slice(1) !== name) history.replaceState(null,'','#'+name);
    window.scrollTo(0,0);
    if (name === 'history') drawCal();
    paintBadge();
    watch();
  }
  document.addEventListener('click', function(e){
    var b = e.target.closest('[data-go]'); if (!b) return;
    e.preventDefault(); go(b.dataset.go);
  });
  var chk = document.getElementById('checkgo');
  if (chk) chk.href = 'check.html' + KEY;
  document.getElementById('menubtn').addEventListener('click', function(){
    paintProfile(); openSheet('menu');
  });

  // ── filters, in a sheet. Nothing scrolls sideways on this site.
  var FILTERABLE = {home:1, kitchen:1, history:1};
  var F = {
    home:    {cat:null, ready:false, fav:false, health:0, again:false, view:'grid',
              effort:null, week:false, season:false, occ:null, made:false},
    kitchen: {cat:null, soon:false, view:'grid'},
    history: {show:'meals', view:'list'}
  };
  function activeCount(page){
    var f = F[page]; if (!f) return 0;
    var n = 0;
    if (page === 'home') { if (f.cat) n++; if (f.ready) n++; if (f.fav) n++; if (f.health) n++;
      if (f.again) n++; if (f.effort) n++; if (f.week) n++; if (f.season) n++; if (f.occ) n++;
      if (f.made) n++; }
    if (page === 'kitchen') { if (f.cat) n++; if (f.soon) n++; }
    if (page === 'history') { if (f.show !== 'meals') n++; }
    return n;
  }
  function paintBadge(){
    var n = activeCount(current), b = document.getElementById('fbadge');
    b.hidden = !n; b.textContent = n;
  }
  function opt(label, on, attrs, n){
    return '<button class="fopt" aria-pressed="'+(on?'true':'false')+'" '+attrs+'>'+
      esc(label)+(n!=null?'<span class="ct">'+n+'</span>':'')+'</button>';
  }
  // Counts on the day-shaped filters are measured off the rendered cards rather
  // than passed through the data blob, because the cards are the only thing that
  // knows which dishes survived being second halves of a pair.
  function count(sel){
    var p = panels.home; if (!p) return null;
    return p.querySelectorAll('[data-meal]'+sel).length;
  }
  function buildFilters(){
    var f = F[current], h = '';
    if (current === 'home') {
      h += '<div class="fgroup"><h4>View</h4><div class="seg">'+
        opt('Grid', f.view==='grid', 'data-set="view" data-val="grid"')+
        opt('List', f.view==='list', 'data-set="view" data-val="list"')+'</div></div>';
      h += '<div class="fgroup"><h4>Show only</h4>'+
        opt('Ready to cook now', f.ready, 'data-set="ready"')+
        opt('We have made this before', f.made, 'data-set="made"', count('[data-made="1"]'))+
        // The repeat-a-favourite question, which is a different question from
        // either half on its own: cooked here before AND everything is in the
        // house, so it can go on the stove tonight with no thinking.
        opt('Made before and can make again', f.again, 'data-set="again"', D.againCount)+
        opt('Favourites', f.fav, 'data-set="fav"')+
        opt('Healthy (4 or better)', f.health===4, 'data-set="health" data-val="4"')+'</div>';
      h += '<div class="fgroup"><h4>Kind</h4>'+
        opt('Everything', !f.cat, 'data-set="cat" data-val=""', null)+
        D.mealCats.map(function(c){
          return opt(c.id.charAt(0).toUpperCase()+c.id.slice(1), f.cat===c.id,
            'data-set="cat" data-val="'+esc(c.id)+'"', c.n);
        }).join('')+'</div>';
      // How much of the day it wants, which is the question people actually ask
      // on a Tuesday and again, differently, on a Sunday.
      h += '<div class="fgroup"><h4>How much of a job</h4>'+
        opt('Any', !f.effort, 'data-set="effort" data-val=""')+
        [['quick','Quick'],['weeknight','Weeknight'],['project','Worth an afternoon'],
         ['allday','All day']].map(function(e){
          return opt(e[1], f.effort===e[0], 'data-set="effort" data-val="'+e[0]+'"',
            count('[data-effort="'+e[0]+'"]'));
        }).join('')+'</div>';
      h += '<div class="fgroup"><h4>The kind of week</h4>'+
        opt('Feeds us all week', f.week, 'data-set="week"', count('[data-week="1"]'))+
        opt('In season now', f.season, 'data-set="season"', count('[data-season="1"]'))+
        (D.mood.occasion
          ? opt(D.mood.occasion + ' food', f.occ==='occasion', 'data-set="occ" data-val="occasion"')
          : '')+
        (D.mood.football && !D.mood.occasion
          ? opt('Game day food', f.occ==='gameday', 'data-set="occ" data-val="gameday"',
              count('[data-occ~="gameday"]'))
          : '')+
        '</div>';
    } else if (current === 'kitchen') {
      h += '<div class="fgroup"><h4>View</h4><div class="seg">'+
        opt('Grid', f.view==='grid', 'data-set="view" data-val="grid"')+
        opt('List', f.view==='list', 'data-set="view" data-val="list"')+'</div></div>';
      h += '<div class="fgroup"><h4>Show only</h4>'+
        opt('Use soon', f.soon, 'data-set="soon"')+'</div>';
      h += '<div class="fgroup"><h4>Aisle</h4>'+
        opt('Everything', !f.cat, 'data-set="cat" data-val=""')+
        D.itemCats.map(function(c){
          return opt(c.id.charAt(0).toUpperCase()+c.id.slice(1), f.cat===c.id,
            'data-set="cat" data-val="'+esc(c.id)+'"', c.n);
        }).join('')+'</div>';
    } else if (current === 'history') {
      h += '<div class="fgroup"><h4>View</h4><div class="seg">'+
        opt('List', f.view==='list', 'data-set="view" data-val="list"')+
        opt('Calendar', f.view==='cal', 'data-set="view" data-val="cal"')+'</div></div>';
      h += '<div class="fgroup"><h4>Showing</h4>'+
        opt('Meals I made', f.show==='meals', 'data-set="show" data-val="meals"')+
        opt('Ingredients bought', f.show==='items', 'data-set="show" data-val="items"')+
        opt('Recipes and what they cost', f.show==='recipes', 'data-set="show" data-val="recipes"')+
        '</div>';
    }
    document.getElementById('filterbody').innerHTML = h;
  }
  document.getElementById('filterbtn').addEventListener('click', function(){
    buildFilters(); openSheet('filters');
  });
  document.getElementById('filterbody').addEventListener('click', function(e){
    var b = e.target.closest('.fopt'); if (!b) return;
    var f = F[current], key = b.dataset.set, val = b.dataset.val;
    if (key === 'cat') f.cat = val || null;
    else if (key === 'view') f.view = val;
    else if (key === 'show') f.show = val;
    else if (key === 'health') f.health = f.health === 4 ? 0 : 4;
    else if (key === 'effort') f.effort = val || null;
    else if (key === 'occ') f.occ = f.occ === val ? null : val;
    else f[key] = !f[key];
    buildFilters();
  });
  document.getElementById('fclear').addEventListener('click', function(){
    var f = F[current];
    if (current === 'home') { f.cat=null; f.ready=false; f.fav=false; f.health=0; f.again=false;
      f.effort=null; f.week=false; f.season=false; f.occ=null; f.made=false; }
    if (current === 'kitchen') { f.cat=null; f.soon=false; }
    if (current === 'history') { f.show='meals'; }
    buildFilters(); apply();
  });
  document.getElementById('fapply').addEventListener('click', function(){ apply(); closeSheets(); });

  function apply(){
    var f = F[current], panel = panels[current];
    if (!f || !panel) return;
    panel.dataset.view = f.view;
    var shown = 0, sel = current === 'kitchen' ? '[data-prod]' : '[data-meal]';
    if (current === 'history') {
      panel.querySelectorAll('[data-hview]').forEach(function(v){ v.hidden = v.dataset.hview !== f.view; });
      panel.querySelectorAll('[data-hfilter]').forEach(function(v){ v.hidden = v.dataset.hfilter !== f.show; });
      if (f.view === 'cal') drawCal();
      shown = 1;
    } else {
      panel.querySelectorAll(sel).forEach(function(el){
        var ok = true;
        if (f.cat && el.dataset.cat !== f.cat) ok = false;
        if (current === 'home') {
          if (f.ready && el.dataset.ready !== '1') ok = false;
          if (f.fav && el.dataset.fav !== '1') ok = false;
          if (f.health && Number(el.dataset.health) < f.health) ok = false;
          if (f.again && !(el.dataset.made === '1' && el.dataset.ready === '1')) ok = false;
          if (f.made && el.dataset.made !== '1') ok = false;
          if (f.effort && el.dataset.effort !== f.effort) ok = false;
          if (f.week && el.dataset.week !== '1') ok = false;
          if (f.season && el.dataset.season !== '1') ok = false;
          if (f.occ === 'gameday' && (' '+el.dataset.occ+' ').indexOf(' gameday ') < 0) ok = false;
          if (f.occ === 'occasion' &&
              !OCC_TAGS.some(function(t){ return (' '+el.dataset.occ+' ').indexOf(' '+t+' ') >= 0; })) ok = false;
        } else {
          if (f.soon && el.dataset.soon !== '1') ok = false;
          if (searchTerm && el.dataset.q.indexOf(searchTerm) < 0) ok = false;
        }
        el.style.display = ok ? '' : 'none';
        if (ok) shown++;
      });
    }
    var nr = panel.querySelector('[data-noresults]');
    if (nr) nr.hidden = shown > 0;
    paintChips(); paintBadge(); watch();
  }

  function paintChips(){
    var f = F[current], host = document.querySelector('[data-af="'+current+'"]');
    if (!host || !f) return;
    var out = [];
    if (f.cat) out.push([f.cat.charAt(0).toUpperCase()+f.cat.slice(1), 'cat']);
    if (f.ready) out.push(['Ready now','ready']);
    if (f.again) out.push(['Made before, can make again','again']);
    if (f.fav) out.push(['Favourites','fav']);
    if (f.health) out.push(['Healthy','health']);
    if (f.effort) out.push([EFFORT[f.effort] || f.effort,'effort']);
    if (f.made) out.push(['Made before','made']);
    if (f.week) out.push(['Feeds us all week','week']);
    if (f.season) out.push(['In season','season']);
    if (f.occ === 'gameday') out.push(['Game day','occ']);
    if (f.occ === 'occasion') out.push([(D.mood.occasion||'Occasion')+' food','occ']);
    if (f.soon) out.push(['Use soon','soon']);
    if (current === 'history' && f.show === 'items') out.push(['Ingredients bought','show']);
    if (current === 'history' && f.show === 'recipes') out.push(['Recipes and costs','show']);
    host.innerHTML = out.map(function(o){
      return '<button class="afchip" data-drop="'+o[1]+'">'+esc(o[0])+' '+
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" '+
        'stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
    }).join('');
  }
  document.addEventListener('click', function(e){
    var b = e.target.closest('[data-drop]'); if (!b) return;
    var f = F[current], k = b.dataset.drop;
    if (k === 'cat') f.cat = null;
    else if (k === 'health') f.health = 0;
    else if (k === 'show') f.show = 'meals';
    else if (k === 'effort') f.effort = null;
    else if (k === 'occ') f.occ = null;
    else f[k] = false;
    paintShelves(); apply();
  });

  // ── the shelf chips under the mood band. Same state as the filter sheet, so
  // tapping one and then opening filters shows it already on rather than two
  // controls disagreeing about what the page is showing.
  var EFFORT = {quick:'Quick', weeknight:'Weeknight', project:'Worth an afternoon', allday:'All day'};
  var OCC_TAGS = (D.mood && D.mood.occTags) || [];
  function shelfState(key){
    var f = F.home;
    if (key === 'made') return f.made;
    if (key === 'season') return f.season;
    if (key === 'week') return f.week;
    if (key === 'project') return f.effort === 'project';
    if (key === 'occasion') return f.occ === 'occasion';
    if (key === 'gameday') return f.occ === 'gameday';
    return false;
  }
  function paintShelves(){
    document.querySelectorAll('.shelf[data-shelf]').forEach(function(b){
      b.setAttribute('aria-pressed', shelfState(b.dataset.shelf) ? 'true' : 'false');
    });
  }
  document.addEventListener('click', function(e){
    var b = e.target.closest('.shelf[data-shelf]'); if (!b) return;
    var f = F.home, key = b.dataset.shelf, on = shelfState(key);
    if (key === 'made') f.made = !on;
    else if (key === 'season') f.season = !on;
    else if (key === 'week') f.week = !on;
    else if (key === 'project') f.effort = on ? null : 'project';
    else if (key === 'occasion') f.occ = on ? null : 'occasion';
    else if (key === 'gameday') f.occ = on ? null : 'gameday';
    if (current !== 'home') go('home');
    paintShelves(); apply();
    document.querySelector('[data-panel="home"] .meals').scrollIntoView({behavior:'smooth', block:'start'});
  });

  var searchTerm = '';
  var q = document.getElementById('q');
  if (q) q.addEventListener('input', function(){
    searchTerm = q.value.trim().toLowerCase(); apply();
  });

  // ── calendar
  var calDrawn = false;
  function drawCal(){
    var host = document.getElementById('cal');
    if (!host || calDrawn) return;
    var data = JSON.parse(document.getElementById('cal-data').textContent);
    var keys = Object.keys(data).sort();
    var end = new Date();
    var start = keys.length ? new Date(keys[0]+'T12:00:00') : new Date();
    var months = [], cur = new Date(end.getFullYear(), end.getMonth(), 1);
    var first = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cur >= first && months.length < 14) { months.push(new Date(cur)); cur.setMonth(cur.getMonth()-1); }
    var t = new Date();
    var tk = t.getFullYear()+'-'+String(t.getMonth()+1).padStart(2,'0')+'-'+String(t.getDate()).padStart(2,'0');
    host.innerHTML = months.map(function(m){
      var y = m.getFullYear(), mo = m.getMonth();
      var lead = new Date(y,mo,1).getDay(), n = new Date(y,mo+1,0).getDate(), cells = '';
      for (var i=0;i<lead;i++) cells += '<div class="day empty"></div>';
      for (var d=1;d<=n;d++){
        var key = y+'-'+String(mo+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
        var hit = data[key];
        cells += '<div class="day'+(hit?' has':'')+(key===tk?' today':'')+'">'+
          '<span class="n">'+d+'</span>'+
          (hit?'<span class="m">'+hit.map(esc).join('<br>')+'</span>':'')+'</div>';
      }
      return '<h3>'+m.toLocaleDateString('en-US',{month:'long',year:'numeric'})+'</h3>'+
        '<div class="grid">'+['S','M','T','W','T','F','S'].map(function(x){
          return '<div class="dow">'+x+'</div>'; }).join('')+cells+'</div>';
    }).join('<div style="height:20px"></div>');
    calDrawn = true;
  }

  // ── toast
  var toast = document.getElementById('toast'), tt;
  function say(msg){
    toast.textContent = msg; toast.classList.add('on');
    clearTimeout(tt); tt = setTimeout(function(){ toast.classList.remove('on'); }, 5000);
  }

  function post(payload){
    payload.profile = me || null;
    payload.ts = new Date().toISOString();
    return fetch('/callback' + KEY, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
  }

  function needProfile(){
    if (me) return false;
    paintProfile(); openSheet('menu');
    say('Tell me who you are first, then I know where to send it.');
    return true;
  }

  // ── detail sheet
  var dtitle = document.getElementById('dtitle'), dbody = document.getElementById('dbody'),
      dfoot = document.getElementById('dfoot');
  function detail(title, bodyHtml, footHtml){
    dtitle.textContent = title; dbody.innerHTML = bodyHtml; dfoot.innerHTML = footHtml || '';
    openSheet('detail'); watch(dbody);
  }
  /**
   * What happens after you press the button.
   *
   * Anything that needs me or a model has a gap between the tap and the answer,
   * and a button that goes quiet during that gap reads as broken. So every one
   * of them says, at the point of pressing, where the answer will show up and
   * whether it is worth waiting on this screen. The two are genuinely
   * different: writing a recipe comes back as a text, everything the site can
   * settle itself lands on the page and never sends anything.
   */
  function waitLine(how){
    return '<div class="wait">'+(how === 'text'
      ? '<span><b>I will text you when it is ready.</b> Usually a minute or two. '+
        'You can close this.</span>'
      : '<span><b>This lands on the page itself.</b> Give it about a minute and refresh. '+
        'Nothing gets texted for this one.</span>')+'</div>';
  }

  function needRows(id){
    var c = D.cook[id]; if (!c) return '';
    return c.needs.map(function(n){
      var label = n.state === 'have' ? 'have' : n.state === 'short' ? 'not enough' : 'out';
      var col = n.state === 'have' ? 'var(--good)' : n.state === 'short' ? 'var(--warn)' : 'var(--bad)';
      return '<div class="needline"><span>'+esc(n.name)+'</span>'+
        '<span class="st" style="color:hsl('+col+')">'+label+'</span></div>';
    }).join('');
  }
  function whoPicker(){
    if (D.single) return '';
    return '<h4 style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;'+
      'color:hsl(var(--ink-faint));margin:18px 0 10px">Send it to</h4>' +
      D.people.map(function(p){
        return '<label class="who"><input type="checkbox" name="who" value="'+esc(p.principal)+'"'+
          (p.principal === me ? ' checked' : '')+'><span style="font-weight:500">'+esc(p.label)+
          '</span></label>';
      }).join('');
  }
  function chosen(){
    var picked = [].slice.call(dbody.querySelectorAll('input[name=who]:checked'))
      .map(function(i){ return i.value; });
    return D.single ? D.people.map(function(p){ return p.principal; }) : picked;
  }

  /**
   * "It says I am short, but I am not."
   *
   * A dish reads as un-makeable for two completely different reasons and the
   * site used to treat them as one. Either the house genuinely lacks something,
   * or the LEDGER is stale and the thing is sitting in the cupboard. Only the
   * first is a reason to build a variant, and routing the second one into a
   * variant means solving a problem that does not exist, around an ingredient
   * you already own.
   *
   * So every missing line gets a verdict here first: I have it, I will buy it,
   * or I really am out. Saying "I have it" writes the correction straight to
   * the ledger, and the dish is simply makeable a minute later.
   */
  function shortSheet(id, name){
    var c = D.cook[id] || {};
    var miss = (c.missingDetail || []);
    if (!miss.length) { say('Nothing is short on that one.'); return; }
    detail(c.name || name || id,
      '<p class="note">This says short ' + miss.length + '. Before building a variant around '+
      'that, is any of it actually wrong? The shelves are only as current as the last receipt '+
      'or shelf check.</p>' +
      '<div style="margin-top:14px">' + miss.map(function(m){
        // Two different problems wearing the same word. "Out" means the shelf is
        // empty; "short" means there is some and the recipe wants more, and the
        // correction for the second one is a NUMBER, not a yes. Collapsing them
        // was why saying "I have it" changed nothing: it set the count to one,
        // which is what it already was.
        var isShort = m.state === 'short';
        return '<div class="shortrow" data-short="'+esc(m.id)+'" data-want="'+(m.want||1)+'">'+
          '<div class="nm">'+esc(m.name)+
            '<span class="sub">'+(isShort
              ? 'recipe wants ' + m.want + ', ledger has ' + m.have
              : 'ledger says none in the house')+'</span></div>'+
          '<div class="opts">'+
            '<button class="btn sm alt" data-fix="have" data-id="'+esc(m.id)+'" '+
              'data-want="'+(m.want||1)+'">'+
              (isShort ? 'I have ' + m.want + ' or more' : 'I have it')+'</button>'+
            '<button class="btn sm alt" data-fix="buy" data-id="'+esc(m.id)+'" '+
              'data-name="'+esc(m.name)+'">Buy it</button>'+
            '<button class="btn sm alt" data-fix="out" data-id="'+esc(m.id)+'">Really out</button>'+
          '</div></div>';
      }).join('') + '</div>',
      '<button class="btn alt" data-close style="flex:1">Close</button>' +
      '<button class="btn" data-act2="variant" data-id="'+esc(id)+'" style="flex:2">'+
        'Build a variant anyway</button>');
  }

  // Composing is the one action on this page that starts from no card.
  //
  // Every other button asks for something the catalog already holds; this one
  // exists because a fixed catalog ranked against stock can only return the
  // least-bad card it has, which is how a fridge with two proteins past date
  // gets recommended pasta. The food is named back rather than asked for, so
  // nobody has to describe their own fridge, and the steer is free text because
  // "not pasta" is a real constraint the ledger cannot know.
  function composeSheet(){
    if (needProfile()) return;
    var clock = D.clock || [];
    var lines = clock.length
      ? clock.map(function(c){
          var when = c.days < 0 ? 'past date' : c.days === 0 ? 'today' : c.days + ' days';
          return '<div class="needline"><span>'+esc(c.name)+'</span>'+
            '<span class="st" style="color:hsl('+(c.days <= 0 ? 'var(--bad)' : 'var(--warn)')+')">'+
            when+'</span></div>';
        }).join('')
      : '<p class="note">Nothing is on a clock right now, so this will be built around '+
        'what is in the house generally.</p>';
    detail('Write one for the clock',
      '<p class="note">I will write a dinner around what is actually running out, '+
      'from scratch rather than off a card, and save it so it is here next time.</p>'+
      '<div style="margin-top:12px">'+lines+'</div>'+
      '<label class="fld" style="margin-top:14px">Anything to steer it?'+
      '<input id="cwhy" type="text" maxlength="140" autocomplete="off" '+
      'placeholder="not pasta, something on the grill, quick"></label>'+
      waitLine('text')+
      whoPicker(),
      '<button class="btn alt" data-close style="flex:1">Not now</button>'+
      '<button class="btn acc" id="confirm" style="flex:2">Write it</button>');
    document.getElementById('confirm').addEventListener('click', function(){
      var who = chosen();
      if (!D.single && !who.length) { say('Pick at least one person.'); return; }
      var el = document.getElementById('cwhy');
      this.disabled = true; this.textContent = 'Sending';
      post({kind:'compose', users:who, text:(el && el.value ? el.value.trim() : null),
            name:'dinner for what is going off'})
        .then(function(){ closeSheets(); say('On it. I will write one and text it over.'); })
        .catch(function(){ say('Could not reach me just now. Try again in a moment.'); });
    });
  }

  function makeSheet(id, variant){
    var c = D.cook[id] || {};
    if (needProfile()) return;
    detail(c.name || id,
      '<p class="note">'+(variant
        ? 'I will build a version of this around what the kitchen actually has, and keep it under the original as another take on the same dish.'
        : 'I will write the full recipe out with amounts and steps. If it has been written before you get it instantly.')+'</p>'+
      (c.from && c.from.length ? '<div class="pill" style="margin-top:12px">Built from leftovers</div>' : '')+
      waitLine('text')+
      // A variant is a request with a reason, and the reason is the whole brief.
      // "Build a variant" on its own leaves me guessing whether they mean
      // lighter, faster, spicier or without the shrimp, so it is asked here in
      // their own words instead of inferred from the ingredient shortfall.
      (variant
        ? '<label class="fld" style="margin-top:14px">What should be different?'+
          '<input id="vwhy" type="text" maxlength="140" autocomplete="off" '+
          'placeholder="lighter, no shellfish, ready in 20, spicier"></label>'
        : '')+
      '<div style="margin-top:12px">'+needRows(id)+'</div>'+
      whoPicker(),
      '<button class="btn alt" data-close style="flex:1">Not now</button>'+
      '<button class="btn '+(variant?'acc':'')+'" id="confirm" style="flex:2">'+
        (variant?'Build the variant':'Make this')+'</button>');
    document.getElementById('confirm').addEventListener('click', function(){
      var who = chosen();
      if (!D.single && !who.length) { say('Pick at least one person.'); return; }
      var whyEl = document.getElementById('vwhy');
      var why = whyEl && whyEl.value ? whyEl.value.trim() : '';
      this.disabled = true; this.textContent = 'Sending';
      post({kind: variant?'variant':'make', recipe:id, name:c.name||id, users:who,
            text: why || null, missing:(c.missing||[])})
        .then(function(){ closeSheets(); say(variant
          ? 'On it. I will build a variant and text it over.'
          : 'On it. Recipe coming by text in a minute.'); })
        .catch(function(){ say('Could not reach me just now. Try again in a moment.'); });
    });
  }

  // A written recipe is its own page, not a sheet. Cooking from a bottom sheet
  // means losing it to a stray scroll, and a page has a URL you can send to the
  // other person in the kitchen. Deliberately reachable whatever the shelves
  // say: being out of cream is a reason to read the recipe, not to hide it.
  function openRecipe(id){
    if (!D.book[id]) { say('That one has not been written out yet.'); return; }
    location.href = 'recipe/' + encodeURIComponent(id) + '.html' + KEY;
  }

  function pastSheet(id, name){
    var c = D.cook[id];
    if (!c) {
      detail(name,
        '<p class="note">This one is not in the catalog, so I cannot check it against the shelves. '+
        'I can still write it out.</p>'+waitLine('text')+whoPicker()+
        '<h4 style="margin:20px 0 8px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;'+
        'color:hsl(var(--ink-faint));font-weight:700">Add a note</h4>'+
        '<textarea id="mnote" rows="3" placeholder="How did it turn out?" style="width:100%;'+
        'border:1px solid hsl(var(--line));border-radius:12px;padding:12px;background:hsl(var(--card));'+
        'font-size:16px;resize:none"></textarea>',
        '<button class="btn alt" id="savenote" style="flex:1">Save note</button>'+
        '<button class="btn" id="confirm" style="flex:2">Write it out</button>');
    } else {
      detail(c.name,
        '<p class="note">'+(c.ready
          ? 'Everything for this is in the house right now.'
          : 'Short '+c.missing.length+': '+esc(c.missing.join(', '))+'.')+'</p>'+
        // A dish reached from the history is the likeliest one to already have
        // a written page, and the page is the reason you tapped it.
        (D.book[id] ? '<button class="btn wide" data-act="recipe" data-id="'+esc(id)+
          '" style="margin:14px 0 4px">Open the recipe</button>' : '')+
        '<div style="margin:14px 0">'+needRows(id)+'</div>'+
        (c.ready ? '' : '<button class="btn wide alt" data-act="addlist" data-id="'+esc(id)+
          '" data-name="'+esc(c.name)+'" style="margin-bottom:4px">Add what I need to the list</button>')+
        whoPicker()+
        '<h4 style="margin:20px 0 8px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;'+
        'color:hsl(var(--ink-faint));font-weight:700">Add a note</h4>'+
        '<textarea id="mnote" rows="3" placeholder="How did it turn out?" style="width:100%;'+
        'border:1px solid hsl(var(--line));border-radius:12px;padding:12px;background:hsl(var(--card));'+
        'font-size:16px;resize:none"></textarea>',
        '<button class="btn alt" id="savenote" style="flex:1">Save note</button>'+
        '<button class="btn" id="confirm" style="flex:2">'+
          (c.ready?'Make it again':'Make a variant')+'</button>');
    }
    var sn = document.getElementById('savenote');
    if (sn) sn.addEventListener('click', function(){
      if (needProfile()) return;
      var t = (document.getElementById('mnote')||{}).value || '';
      if (!t.trim()) { say('Write something first.'); return; }
      this.disabled = true;
      post({kind:'note', recipe:id, name:name, text:t.trim()})
        .then(function(){ closeSheets(); say('Noted. I will file it against that meal.'); })
        .catch(function(){ say('Could not reach me just now.'); });
    });
    var cf = document.getElementById('confirm');
    if (cf) cf.addEventListener('click', function(){
      if (needProfile()) return;
      var who = chosen();
      if (!D.single && !who.length) { say('Pick at least one person.'); return; }
      this.disabled = true; this.textContent = 'Sending';
      post({kind: (c && !c.ready) ? 'variant' : 'make', recipe:id, name:name, users:who,
            missing:(c && c.missing) || []})
        .then(function(){ closeSheets(); say('On it. Recipe coming by text.'); })
        .catch(function(){ say('Could not reach me just now.'); });
    });
  }

  // Cook once, eat twice, decided on the dish rather than in a strip above it.
  //
  // Both halves are decidable from here, in both directions: cook the first and
  // the second follows, cook the first and explicitly skip the second, or cook
  // the second on its own by buying what the leftovers would have covered. The
  // pairing is a suggestion, not a contract.
  function pairSheet(id){
    var c = D.cook[id]; if (!c) return;
    var second = (c.after || []).length > 0;
    var other = second ? c.after[0] : (c.leads || [])[0];
    if (!other) return;
    var pairId = second ? (other.id + '>' + id) : (id + '>' + other.id);
    var leg = second ? 'parent' : 'child';
    var legName = second ? other.name : other.name;
    var isSkipped = (D.skips || []).indexOf(pairId + '|' + leg) >= 0;
    var via = esc((other.via || []).join(' and ').replace(/leftover-/g, ''));

    detail(c.name,
      '<p class="note">' + (second
        ? 'This is the second night. It is built from what ' + esc(other.name) +
          ' leaves behind, so normally that gets cooked first.'
        : 'Cook a bigger batch tonight and tomorrow is mostly done already.') + '</p>' +
      '<div style="margin-top:14px">' +
        '<div class="needline"><span><strong>' + (second ? 'First' : 'Tonight') + ':</strong> ' +
          esc(second ? other.name : c.name) + '</span>' +
          '<span class="st" style="text-transform:none;font-weight:400">leaves ' + via + '</span></div>' +
        '<div class="needline"><span><strong>' + (second ? 'Then' : 'Tomorrow') + ':</strong> ' +
          esc(second ? c.name : other.name) + '</span>' +
          '<span class="st" style="text-transform:none;font-weight:400">uses ' + via + '</span></div>' +
      '</div>' +
      (isSkipped
        ? '<p class="note" style="margin-top:14px;color:hsl(var(--accent))">You said you are not doing ' +
          esc(legName) + '. Undo that below.</p>'
        : '') +
      (second && !c.ready
        ? '<p class="note" style="margin-top:14px">Short ' + c.missing.length + ' for making this on its own: ' +
          esc(c.missing.join(', ')) + '.</p>'
        : ''),
      '<button class="btn alt" data-act2="' + (isSkipped ? 'unskip' : 'skip') + '" ' +
        'data-pair="' + esc(pairId) + '" data-leg="' + esc(leg) + '" data-id="' + esc(id) + '" style="flex:1">' +
        (isSkipped ? 'Actually, back on' : 'Not doing ' + esc(legName.split(' ').slice(0,3).join(' '))) + '</button>' +
      '<button class="btn" data-act2="make" data-id="' + esc(second ? other.id : id) + '" style="flex:2">' +
        (second ? 'Make ' + esc(other.name.split(' ').slice(0,4).join(' ')) + ' first' : 'Make this tonight') +
      '</button>' +
      (second
        ? '<button class="btn alt" data-act2="' + (c.ready ? 'make' : 'addlist') + '" data-id="' + esc(id) +
          '" data-name="' + esc(c.name) + '" style="flex:1;margin-top:10px">' +
          (c.ready ? 'Just make this one' : 'Buy for this one instead') + '</button>'
        : ''));
  }

  function variantsSheet(id){
    var c = D.cook[id]; if (!c || !(c.variants||[]).length) return;
    detail(c.name,
      '<p class="note">Other written takes on this dish, usually built around whatever the '+
      'kitchen was missing that day.</p><div style="margin-top:14px">'+
      c.variants.map(function(v){
        return '<button class="hrow2" data-act="recipe" data-id="'+esc(v.id)+'" style="width:100%">'+
          '<div style="min-width:0;text-align:left"><div class="nm">'+esc(v.name)+'</div>'+
          '<div class="dt"><span>'+esc(v.reason||'another take')+'</span></div></div></button>';
      }).join('')+'</div>',
      '<button class="btn alt" data-close style="flex:1">Close</button>'+
      (D.book[id] ? '<button class="btn" data-act2="recipe" data-id="'+esc(id)+
        '" style="flex:2">Open the original</button>' : ''));
  }

  function healthSheet(id){
    var c = D.cook[id]; if (!c || !c.health) return;
    var words = {1:'a treat, not a Tuesday', 2:'heavy, but there are vegetables in it',
                 3:'a normal dinner', 4:'lean protein and vegetables carrying it',
                 5:'about as good as dinner gets here'};
    detail(c.name,
      '<p class="note">Health '+c.health+' out of 5: '+esc(words[c.health]||'')+'.</p>'+
      '<p class="note" style="margin-top:12px">This is a stated opinion written when the dish '+
      'was added, not a computed score. The nutrition table behind the recap is category level '+
      'for most ingredients, so a number derived from it would look measured and would not be.</p>',
      '<button class="btn alt" data-close style="flex:1">Close</button>'+
      '<button class="btn" data-act2="make" data-id="'+esc(id)+'" style="flex:2">Make it</button>');
  }

  // Opening a dish is curiosity. Deciding to buy for it is a separate decision,
  // so it gets a separate tap and a chance to say which parts you actually want.
  // Firing the model straight off the card filled the shopping list with things
  // nobody had chosen, which is how a list stops being read.
  function listSheet(id, name){
    var c = D.cook[id] || {};
    var miss = c.missing || [];
    if (!miss.length) { say('Nothing is missing for that one.'); return; }
    detail(c.name || name || id,
      '<p class="note">Tick what you actually want to pick up. I will work out the real '+
      'product and size against what is already in the kitchen and already on the list, '+
      'so nothing lands twice.</p>' + waitLine('page') +
      '<div style="margin-top:14px">' + miss.map(function(m, i){
        return '<label class="who"><input type="checkbox" name="buy" value="'+esc(m)+'" checked>'+
          '<span style="font-weight:500">'+esc(m)+'</span></label>';
      }).join('') + '</div>',
      '<button class="btn alt" data-close style="flex:1">Not now</button>'+
      '<button class="btn" id="confirm" style="flex:2">Add to the list</button>');
    document.getElementById('confirm').addEventListener('click', function(){
      var picked = [].slice.call(dbody.querySelectorAll('input[name=buy]:checked'))
        .map(function(i){ return i.value; });
      if (!picked.length) { say('Tick at least one thing.'); return; }
      this.disabled = true; this.textContent = 'Adding';
      post({kind:'addlist', recipe:id, name:c.name || name || id,
            missing:picked, items:picked})
        .then(function(){ closeSheets();
          say('Added. It will show on the shopping page in a minute.'); })
        .catch(function(){ say('Could not reach me just now.'); });
    });
  }

  /**
   * Taking a line off the list, which is three different corrections.
   *
   * "I already have this" is a statement about the kitchen and fixes the
   * ledger. "Not this trip" is about today and expires on its own at the next
   * receipt. "I do not buy this" is about the household and is permanent. They
   * used to be one missing feature, and collapsing them into a single delete
   * would have quietly taught the system the wrong lesson two times out of
   * three — the crab legs case, where the fix is a preference, and the
   * bought-it-yesterday case, where the fix is the stock count.
   */
  function lineSheet(key, name, reason, item){
    var opts = '';
    if (item) {
      opts +=
        '<button class="who" data-line="have"><span style="font-weight:500">I already have this'+
          '<span class="ct" style="display:block">Puts it back in the kitchen. It stops being on '+
          'the list because the list stops being wrong.</span></span></button>'+
        '<button class="who" data-line="skip"><span style="font-weight:500">Not this trip'+
          '<span class="ct" style="display:block">Off the list until the next receipt lands. '+
          'Nothing is forgotten.</span></span></button>'+
        '<button class="who" data-line="never"><span style="font-weight:500">I do not buy this'+
          '<span class="ct" style="display:block">Permanent. It will not be suggested again '+
          'and you will not be asked.</span></span></button>';
    }
    if (reason === 'asked') {
      opts += '<button class="who" data-line="drop"><span style="font-weight:500">Take it off'+
        '<span class="ct" style="display:block">You added this line, so removing it means '+
        'nothing more than that.</span></span></button>';
    }
    detail(name,
      '<p class="note">What is wrong with this line? Each answer teaches something '+
      'different, so they are separate on purpose.</p>'+
      '<div style="margin-top:14px">'+opts+'</div>'+
      (item ? '<div style="margin-top:16px">'+
        '<label class="note" for="lineamt">How much to buy, if it matters</label>'+
        '<input id="lineamt" class="inp" placeholder="2 cans" style="margin-top:6px">'+
        '<button class="btn sm" id="lineamtset" style="margin-top:8px">Set the amount</button>'+
      '</div>' : ''),
      '<button class="btn alt" data-close style="flex:1">Leave it</button>');

    dbody.addEventListener('click', function(e){
      var b = e.target.closest('[data-line]'); if (!b) return;
      var what = b.dataset.line;
      b.disabled = true;
      // "I already have this" is a claim about the shelves and goes down the
      // same path as correcting stock anywhere else on the site, rather than
      // through a second implementation that could disagree with the first.
      var payload = what === 'have'
        ? {kind:'restock', items:[item]}
        : {kind:'keep', note:what, id:item || key, name:name};
      post(payload)
        .then(function(){ closeSheets(); say(
          what === 'have' ? 'Got it, putting it back in the kitchen.'
          : what === 'skip' ? 'Off the list for this trip.'
          : what === 'never' ? 'Noted. I will not put that on a list again.'
          : 'Taken off.'); })
        .catch(function(){ b.disabled = false; say('Could not reach me just now.'); });
    });
    var setAmt = document.getElementById('lineamtset');
    if (setAmt) setAmt.addEventListener('click', function(){
      var v = (document.getElementById('lineamt').value || '').trim();
      if (!v) { say('Type an amount first.'); return; }
      this.disabled = true;
      post({kind:'keep', note:'amount', id:item || key, name:name, text:v})
        .then(function(){ closeSheets(); say('Set to '+v+'.'); })
        .catch(function(){ setAmt.disabled = false; say('Could not reach me just now.'); });
    });
  }

  /**
   * The vibe dial.
   *
   * Not a filter and deliberately not phrased as one. It re-ranks; the same
   * dishes are all still there. "Let the day decide" is listed first and is the
   * default state, because the page working with nobody touching it is the
   * whole design, and a pinned vibe is a thing you should be able to hand back.
   */
  function vibeSheet(){
    var cur = D.mood.pinned ? D.mood.vibe : null;
    detail('How do we want to eat?',
      '<p class="note">This changes the order, never what is on the list. Everything you '+
      'can cook is still here either way.</p>'+
      '<div style="margin-top:14px">'+
      '<button class="fopt" data-vibe="" aria-pressed="'+(cur?'false':'true')+'">'+
        'Let the day decide<span class="ct">now: '+esc(D.mood.autoLabel)+'</span></button>'+
      D.vibes.map(function(v){
        return '<button class="fopt" data-vibe="'+esc(v.id)+'" aria-pressed="'+
          (cur===v.id?'true':'false')+'" style="margin-top:8px">'+esc(v.label)+
          '<span class="ct">'+esc(v.blurb)+'</span></button>';
      }).join('')+'</div>',
      '<button class="btn alt" data-close style="flex:1">Close</button>');
  }
  document.addEventListener('click', function(e){
    var b = e.target.closest('[data-vibe]'); if (!b) return;
    var id = b.dataset.vibe;
    [].slice.call(dbody.querySelectorAll('[data-vibe]')).forEach(function(x){
      x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
    });
    post({kind:'pref', text:'vibe', note:id || null})
      .then(function(){ closeSheets();
        say(id ? 'Set. The list will re-sort in a minute.'
               : 'Back to reading the day. It will re-sort in a minute.'); })
      .catch(function(){ say('Could not reach me just now.'); });
  });

  /**
   * How this house cooks: the standing preferences.
   *
   * Every row here has a working answer already, which is the rule this whole
   * integration runs on. Nothing is blank waiting to be filled in, so the page
   * is complete for somebody who never opens this sheet at all.
   */
  function settingsSheet(){
    var p = D.prefs;
    var modes = [['prep','Meal prep','Cook once, eat it for days'],
                 ['normal','Neither in particular','Just show me good dinners'],
                 ['ballout','Ball out','The good stuff, cost is not the point']];
    detail('How we cook',
      '<h4 class="fh">The kind of week</h4>'+
      modes.map(function(m){
        return '<button class="fopt" data-mode="'+m[0]+'" aria-pressed="'+
          ((p.mode||'normal')===m[0]?'true':'false')+'" style="margin-top:8px">'+
          esc(m[1])+'<span class="ct">'+esc(m[2])+'</span></button>';
      }).join('')+
      '<h4 class="fh" style="margin-top:22px">Money</h4>'+
      '<div class="setrow"><div class="nm">Weekly grocery target'+
        '<span class="sub">Used on the shopping page and the recap. Zero means no target.</span></div>'+
        stepper('budget', p.budget == null ? 0 : p.budget, 10, '$')+'</div>'+
      '<div class="setrow"><div class="nm">Ceiling per dinner'+
        '<span class="sub">Nudges the expensive dishes down when it is low. Zero means no opinion.</span></div>'+
        stepper('permeal', p.perMeal == null ? 0 : p.perMeal, 1, '$')+'</div>'+
      '<h4 class="fh" style="margin-top:22px">Ways we do not cook</h4>'+
      '<p class="note">Anything ticked here gets pushed to the bottom rather than hidden.</p>'+
      '<div style="margin-top:10px">'+D.methods.map(function(m){
        return '<button class="fopt" data-avoid="'+esc(m.id)+'" aria-pressed="'+
          (p.avoid.indexOf(m.id)>=0?'true':'false')+'" style="margin-top:8px">'+esc(m.label)+'</button>';
      }).join('')+'</div>',
      '<button class="btn alt" data-close style="flex:1">Close</button>'+
      '<button class="btn" id="confirm" style="flex:2">Save</button>');
    document.getElementById('confirm').addEventListener('click', function(){
      var mode = (dbody.querySelector('[data-mode][aria-pressed="true"]')||{dataset:{}}).dataset.mode;
      var avoid = [].slice.call(dbody.querySelectorAll('[data-avoid][aria-pressed="true"]'))
        .map(function(x){ return x.dataset.avoid; });
      this.disabled = true; this.textContent = 'Saving';
      post({kind:'pref', text:'settings', note:mode || 'normal',
            items:avoid, qty:num('budget'), amount:num('permeal')})
        .then(function(){ closeSheets(); say('Saved. The page will follow in a minute.'); })
        .catch(function(){ say('Could not reach me just now.'); });
    });
  }
  function stepper(key, val, step, prefix){
    return '<div class="stepper" data-step="'+key+'" data-val="'+val+'" data-inc="'+step+'">'+
      '<button data-bump="-1" aria-label="Less">-</button>'+
      '<b>'+(val ? prefix+val : 'none')+'</b>'+
      '<button data-bump="1" aria-label="More">+</button></div>';
  }
  function num(key){
    var el = dbody.querySelector('[data-step="'+key+'"]');
    return el ? Number(el.dataset.val) || null : null;
  }
  document.addEventListener('click', function(e){
    var b = e.target.closest('[data-bump]'); if (!b) return;
    var host = b.closest('[data-step]'), inc = Number(host.dataset.inc);
    var v = Math.max(0, (Number(host.dataset.val)||0) + Number(b.dataset.bump)*inc);
    host.dataset.val = v;
    host.querySelector('b').textContent = v ? '$'+v : 'none';
  });
  document.addEventListener('click', function(e){
    var b = e.target.closest('[data-mode],[data-avoid]'); if (!b) return;
    if (b.dataset.mode != null) {
      [].slice.call(dbody.querySelectorAll('[data-mode]')).forEach(function(x){
        x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
      });
    } else {
      b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    }
  });

  /**
   * A standing dinner text.
   *
   * The one sheet on this site whose output is a message to a real person, so
   * it never opens with a blank form: a new schedule arrives already set to six
   * in the evening, every day, everybody in the house, which is the answer
   * somebody wants nine times out of ten. Editing beats filling in.
   */
  function schedSheet(id){
    var was = null;
    for (var i = 0; i < D.dinners.length; i++) if (D.dinners[i].id === id) was = D.dinners[i];
    var days = was ? was.days : [];
    var to = was ? was.to : [];
    var meal = was ? was.meal : 'dinner';
    var everyone = D.people.map(function(p){ return p.principal; });

    // The buttons ARE the state. Nothing is held in a closure here, because
    // this sheet can be opened repeatedly and a listener that outlives one
    // opening would be editing a schedule the person already closed.
    function dayBtns(){
      return '<div class="dayrow">'+['S','M','T','W','T','F','S'].map(function(l,n){
        return '<button data-day="'+n+'" aria-pressed="'+(isOn(n)?'true':'false')+'">'+l+'</button>';
      }).join('')+'</div>';
    }
    // An empty list means every day, and the buttons have to SHOW that or the
    // default reads as "no days picked, this will never fire".
    function isOn(n){ return days.length === 0 || days.indexOf(n) >= 0; }

    detail(was ? 'Edit this text' : 'A standing text',
      '<h4 class="fh">When</h4>'+
      '<input class="timein" type="time" id="schat" value="'+esc(was ? was.at : '18:00')+'">'+
      dayBtns()+
      '<div class="shelves" style="margin-top:10px">'+
        '<button class="shelf" data-quick="all">Every day</button>'+
        '<button class="shelf" data-quick="wd">Weekdays</button>'+
        '<button class="shelf" data-quick="we">Weekends</button></div>'+
      '<h4 class="fh" style="margin-top:22px">Which meal</h4>'+
      '<div class="seg" style="display:flex;gap:8px;margin-top:8px">'+
        D.meals.map(function(m){
          return '<button class="fopt" data-mealkind="'+esc(m)+'" aria-pressed="'+
            (m===meal?'true':'false')+'">'+esc(m.charAt(0).toUpperCase()+m.slice(1))+'</button>';
        }).join('')+'</div>'+
      (D.single ? '' :
        '<h4 class="fh" style="margin-top:22px">Who gets the text</h4>'+
        D.people.map(function(p){
          var on = to.length === 0 || to.indexOf(p.principal) >= 0;
          return '<label class="who"><input type="checkbox" name="schto" value="'+
            esc(p.principal)+'"'+(on?' checked':'')+'><span style="font-weight:500">'+
            esc(p.label)+'</span></label>';
        }).join(''))+
      '<h4 class="fh" style="margin-top:22px">A steer, if you want one</h4>'+
      '<input class="timein" id="schnote" placeholder="something quick, no pork, whatever" '+
        'value="'+esc(was && was.note ? was.note : '')+'">'+
      '<p class="note" style="margin-top:8px">Advisory. It nudges the pick, it never hides '+
      'food you can actually cook.</p>'+
      // Not waitLine(). Its "nothing gets texted for this one" is true of saving
      // and reads as a contradiction on the one page whose whole subject is a
      // text message.
      '<div class="wait"><span><b>Saving lands on this page, not in a message.</b> '+
      'The dinner texts themselves start at the time you picked, from the next day '+
      'that matches.</span></div>',
      '<button class="btn alt" data-close style="flex:1">Cancel</button>'+
      '<button class="btn" id="confirm" style="flex:2">'+(was?'Save':'Set it up')+'</button>');

    document.getElementById('confirm').addEventListener('click', function(){
      var at = (document.getElementById('schat')||{}).value || '';
      if (!/^\\d{1,2}:\\d{2}$/.test(at)) { say('Pick a time first.'); return; }
      var picked = [].slice.call(dbody.querySelectorAll('[data-day][aria-pressed="true"]'))
        .map(function(x){ return Number(x.dataset.day); });
      if (!picked.length) { say('Pick at least one day.'); return; }
      // Every day is stored as "no days", so a schedule set to all seven keeps
      // meaning all seven if a weekday is ever added to the calendar.
      if (picked.length === 7) picked = [];
      var m = dbody.querySelector('[data-mealkind][aria-pressed="true"]');
      var who = D.single ? everyone
        : [].slice.call(dbody.querySelectorAll('input[name=schto]:checked'))
            .map(function(i){ return i.value; });
      if (!who.length) { say('Pick at least one person to text.'); return; }
      this.disabled = true; this.textContent = 'Saving';
      post({kind:'sched', note:'save', recipe: was ? was.id : null, at:at, days:picked,
            meal: m ? m.dataset.mealkind : 'dinner', users:who,
            text:(document.getElementById('schnote')||{}).value||null})
        .then(function(){ closeSheets();
          say('Set. It will show on this page in a minute.'); })
        .catch(function(){ say('Could not reach me just now.'); });
    });
  }

  // Day and meal toggles, delegated once. Same reason as the settings sheet:
  // a listener bound per opening accumulates, and the third copy is editing
  // state from the first.
  document.addEventListener('click', function(e){
    var q = e.target.closest('[data-quick]');
    if (q) {
      var want = q.dataset.quick === 'all' ? [0,1,2,3,4,5,6]
        : q.dataset.quick === 'wd' ? [1,2,3,4,5] : [0,6];
      dbody.querySelectorAll('[data-day]').forEach(function(b){
        b.setAttribute('aria-pressed', want.indexOf(Number(b.dataset.day)) >= 0 ? 'true' : 'false');
      });
      return;
    }
    var d = e.target.closest('[data-day]');
    if (d) {
      d.setAttribute('aria-pressed', d.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      return;
    }
    // data-mealkind, not data-meal: every recipe card on Home already carries
    // data-meal, so a tap on any dish would otherwise land in this branch.
    var m = e.target.closest('[data-mealkind]');
    if (m) {
      dbody.querySelectorAll('[data-mealkind]').forEach(function(x){
        x.setAttribute('aria-pressed', x === m ? 'true' : 'false');
      });
    }
  });

  // ── explore. Every button here spends real work somewhere, so every one of
  // them asks first.
  function exploreSheet(theme){
    detail(theme ? 'Find me: ' + theme : 'Surprise me',
      '<p class="note">I will go and find eight dishes that are nothing like what you '+
      'cook, and they will replace the ones on this page. Nothing is added to any list '+
      'and nothing touches your shelves.</p>'+waitLine('page'),
      '<button class="btn alt" data-close style="flex:1">Not now</button>'+
      '<button class="btn" id="confirm" style="flex:2">Go and find some</button>');
    document.getElementById('confirm').addEventListener('click', function(){
      this.disabled = true; this.textContent = 'Looking';
      post({kind:'explore', text:theme || null})
        .then(function(){ closeSheets();
          say('On it. Refresh this page in a minute and they will be here.'); })
        .catch(function(){ say('Could not reach me just now.'); });
    });
  }
  function ideaSheet(id, name, mode){
    var d = D.ideas[id] || {};
    var buy = d.buy || [];
    detail(name || id,
      '<p class="note">'+(mode === 'list'
        ? 'This puts the shopping for it on your list. It does not say you are making it, '+
          'and nothing comes off your shelves.'
        : 'I will write this out properly as a recipe page, step by step.')+'</p>'+
      waitLine(mode === 'list' ? 'page' : 'text')+
      (buy.length
        ? '<h4 class="fh" style="margin-top:16px">'+(mode==='list'?'Going on the list':'What it needs')+'</h4>'+
          '<div style="margin-top:8px">'+buy.map(function(x){
            return '<div class="needline"><span>'+esc(x)+'</span></div>'; }).join('')+'</div>'
        : ''),
      '<button class="btn alt" data-close style="flex:1">Not now</button>'+
      '<button class="btn" id="confirm" style="flex:2">'+
        (mode === 'list' ? 'Yes, add it' : 'Yes, write it')+'</button>');
    document.getElementById('confirm').addEventListener('click', function(){
      if (needProfile()) return;
      this.disabled = true; this.textContent = 'Sending';
      post({kind: mode === 'list' ? 'idealist' : 'idearecipe', recipe:id, name:name,
            users: chosen(), missing: buy})
        .then(function(){ closeSheets(); say(mode === 'list'
          ? 'Added. It will show on the shopping page in a minute.'
          : 'On it. I will text you when the page is written.'); })
        .catch(function(){ say('Could not reach me just now.'); });
    });
  }

  // ── actions
  document.addEventListener('click', function(e){
    var b = e.target.closest('[data-act],[data-act2],[data-pick]');
    if (!b) return;
    if (b.dataset.pick) {
      me = cookie('kitchen_profile', b.dataset.pick);
      paintProfile(); loadChat();
      say('Signed in as '+meLabel()+'.');
      return;
    }
    var act = b.dataset.act || b.dataset.act2, id = b.dataset.id;
    if (act === 'fav') {
      if (needProfile()) return;
      var on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      var card = b.closest('[data-meal]'); if (card) card.dataset.fav = on ? '1' : '0';
      post({kind:'favorite', recipe:id, on:on}).catch(function(){
        b.setAttribute('aria-pressed', String(!on));
        if (card) card.dataset.fav = !on ? '1' : '0';
        say('Could not save that just now.');
      });
      return;
    }
    if (act === 'compose') composeSheet();
    else if (act === 'make') makeSheet(id, false);
    else if (act === 'variant') makeSheet(id, true);
    else if (act === 'recipe') openRecipe(id);
    else if (act === 'pair') pairSheet(id);
    // Declining half a pair changes nothing in the kitchen, so it is one tap
    // and it is reversible from the same place.
    else if (act === 'skip' || act === 'unskip') {
      b.disabled = true;
      post({kind:'pairskip', recipe:b.dataset.pair, note:act === 'skip' ? b.dataset.leg : 'undo'})
        .then(function(){ closeSheets(); say(act === 'skip'
          ? 'Noted. I will stop suggesting that half.'
          : 'Back on. It will show again in a minute.'); })
        .catch(function(){ b.disabled=false; say('Could not reach me just now.'); });
    }
    else if (act === 'vibe') vibeSheet();
    else if (act === 'settings') settingsSheet();
    else if (act === 'schnew') schedSheet(null);
    else if (act === 'schedit') schedSheet(b.dataset.sched);
    // Pausing is reversible and changes nothing outside this list, so it is one
    // tap. Deleting is not, so it asks.
    else if (act === 'schtoggle') {
      b.disabled = true;
      post({kind:'sched', recipe:b.dataset.sched, note:b.dataset.on === '1' ? 'pause' : 'resume'})
        .then(function(){ say(b.dataset.on === '1'
          ? 'Paused. It will stop firing within a minute.'
          : 'Back on. The page will catch up in a minute.'); })
        .catch(function(){ b.disabled = false; say('Could not reach me just now.'); });
    }
    else if (act === 'schdel') {
      var sid = b.dataset.sched;
      detail('Delete this text',
        '<p class="note">This stops the standing message for good. Nothing else changes, ' +
        'and you can always set another one up.</p>' + waitLine('page'),
        '<button class="btn alt" data-close style="flex:1">Keep it</button>' +
        '<button class="btn" id="confirm" style="flex:2">Delete it</button>');
      document.getElementById('confirm').addEventListener('click', function(){
        this.disabled = true; this.textContent = 'Deleting';
        post({kind:'sched', recipe:sid, note:'delete'})
          .then(function(){ closeSheets(); say('Gone. The page will catch up in a minute.'); })
          .catch(function(){ say('Could not reach me just now.'); });
      });
    }
    else if (act === 'explore') exploreSheet(b.dataset.theme || '');
    else if (act === 'idealist') ideaSheet(b.dataset.idea, b.dataset.name, 'list');
    else if (act === 'idearecipe') ideaSheet(b.dataset.idea, b.dataset.name, 'recipe');
    else if (act === 'variants') variantsSheet(id);
    else if (act === 'health') healthSheet(id);
    else if (act === 'past') pastSheet(id, b.dataset.name);
    else if (act === 'addlist') listSheet(id, b.dataset.name);
    else if (act === 'short') shortSheet(id, b.dataset.name);
    else if (act === 'tick') {
      var on2 = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on2));
    }
    else if (act === 'lineedit') {
      lineSheet(b.dataset.id, b.dataset.name, b.dataset.reason, b.dataset.item);
    }
    // Saying yes to a restock ask answers it forever; saying yes to an unlock
    // is just today's decision. The difference is the whole reason the tray
    // shrinks over time instead of asking the same question every week.
    else if (act === 'sugadd') {
      b.disabled = true;
      var perm = b.dataset.kind === 'restock';
      post({kind:'keep', note:perm ? 'always' : 'once', id:b.dataset.id, name:b.dataset.name})
        .then(function(){
          var row = b.closest('.sugrow'); if (row) row.style.display = 'none';
          say(perm ? 'On the list, and I will keep it stocked from now on.'
                   : 'Added to this list.');
        })
        .catch(function(){ b.disabled = false; say('Could not reach me just now.'); });
    }
    else if (act === 'sugnever') {
      b.disabled = true;
      post({kind:'keep', note:'never', id:b.dataset.id, name:b.dataset.name})
        .then(function(){
          var row = b.closest('.sugrow'); if (row) row.style.display = 'none';
          say('Noted as a one-off. I will not ask again.');
        })
        .catch(function(){ b.disabled = false; say('Could not reach me just now.'); });
    }
    else if (act === 'listnotes') {
      b.disabled = true;
      post({kind:'notes'})
        .then(function(){ say('Writing it into Apple Notes now.'); })
        .catch(function(){ b.disabled = false; say('Could not reach me just now.'); });
    }
    else if (act === 'listdone') {
      if (needProfile()) return;
      var got = [].slice.call(document.querySelectorAll('[data-act="tick"][aria-pressed="true"]'))
        .map(function(x){ return x.dataset.id; });
      b.disabled = true;
      post({kind:'shopped', items:got})
        .then(function(){ say('Got it. I will log what you picked up and archive the list.'); })
        .catch(function(){ b.disabled = false; say('Could not reach me just now.'); });
    }
    // Finishing or calling off a meal in progress. Both settle without anyone
    // in the loop, so the row leaves as soon as the post lands rather than
    // sitting there looking unpressed until the next render.
    else if (act === 'made' || act === 'cancelled') {
      var row = b.closest('.live-row');
      var btns = row ? [].slice.call(row.querySelectorAll('button')) : [b];
      btns.forEach(function(x){ x.disabled = true; });
      post({kind:'plan', plan:b.dataset.plan, name:b.dataset.name, note:act})
        .then(function(){
          if (row) {
            row.style.display = 'none';
            var wrap = document.querySelector('.live-wrap');
            if (wrap && !wrap.querySelector('.live-row:not([style*="none"])')) wrap.style.display = 'none';
          }
          say(act === 'made'
            ? 'Logged. Taking the ingredients off the shelves now.'
            : 'Called off. Nothing came off the shelves.');
        })
        .catch(function(){
          btns.forEach(function(x){ x.disabled = false; });
          say('Could not reach me just now.');
        });
    }
    // Undoing an automatic cleanup. Deliberately one tap with no confirmation
    // step: the guess was made without asking, so reversing it should not cost
    // more effort than the guess did.
    else if (act === 'unsweep') {
      b.disabled = true;
      post({kind:'unsweep', batch:b.dataset.batch})
        .then(function(){
          b.closest('.sweepcard').style.display = 'none';
          say('Putting it back. The shelves will say so again in a minute.');
        })
        .catch(function(){ b.disabled = false; say('Could not reach me just now.'); });
    }
  });

  // Correcting one short line, from inside the short sheet.
  document.addEventListener('click', function(e){
    var b = e.target.closest('[data-fix]'); if (!b) return;
    var row = b.closest('.shortrow');
    var kind = b.dataset.fix;
    [].slice.call(row.querySelectorAll('button')).forEach(function(x){ x.disabled = true; });
    var done = function(msg){
      row.classList.add('settled');
      row.querySelector('.opts').innerHTML = '<span class="verdict">'+esc(msg)+'</span>';
    };
    // Correcting to what the recipe asks for, not to one. A count shortfall
    // needs a count, and the recipe's own number is the best default available
    // without making somebody type.
    var req = kind === 'have'
      ? {kind:'restock', items:[b.dataset.id], qty: Number(b.dataset.want) || 1}
      : kind === 'buy'
        ? {kind:'addlist', recipe:b.dataset.id, name:b.dataset.name || b.dataset.id,
           missing:[b.dataset.name || b.dataset.id], items:[b.dataset.name || b.dataset.id]}
        : {kind:'note', recipe:b.dataset.id, name:b.dataset.id, text:'confirmed out of stock'};
    post(req)
      .then(function(){
        done(kind === 'have' ? 'back on the shelves'
          : kind === 'buy' ? 'on the shopping list' : 'confirmed out');
        if (kind === 'have') say('Corrected. That dish may not need a variant at all now.');
      })
      .catch(function(){
        [].slice.call(row.querySelectorAll('button')).forEach(function(x){ x.disabled = false; });
        say('Could not reach me just now.');
      });
  });

  // ── chat: per person, carries the page it was asked from, survives navigation
  var msgs = document.getElementById('msgs'), ctext = document.getElementById('ctext');
  var lastCount = 0, pollTimer = null;
  function safeName(p){ return p.replace(/[^A-Za-z0-9+.-]/g,'_'); }
  function paintChat(turns){
    msgs.innerHTML = turns.map(function(t){
      return '<div class="msg '+(t.from === 'me' ? 'me' : 'them')+'">'+esc(t.text)+
        (t.page && t.from === 'them' ? '<span class="ctx">from '+esc(LABEL[t.page]||t.page)+'</span>' : '')+
        '</div>';
    }).join('') || '<div class="empty">Ask me anything about what is in the kitchen, '+
      'a recipe, or how to cut something. I know which page you are on.</div>';
    document.getElementById('chatbody').scrollTop = 99999;
  }
  function loadChat(){
    if (!me) { paintChat([]); return; }
    fetch('chat/'+safeName(me)+'.json'+KEY, {cache:'no-store'})
      .then(function(r){ return r.ok ? r.json() : {turns:[]}; })
      .then(function(d){
        var t = d.turns || [];
        if (t.length !== lastCount) { lastCount = t.length; paintChat(t); }
      })
      .catch(function(){ /* no thread yet is not an error */ });
  }
  document.getElementById('chatbtn').addEventListener('click', function(){
    if (needProfile()) return;
    openSheet('chat'); loadChat();
    // Poll only while the sheet is open. A background poll on a page someone
    // left open all day is a request every few seconds to a free tunnel.
    clearInterval(pollTimer); pollTimer = setInterval(loadChat, 5000);
    setTimeout(function(){ ctext.focus(); }, 250);
  });
  document.getElementById('chat').addEventListener('click', function(e){
    if (e.target.closest('[data-close]')) clearInterval(pollTimer);
  });
  function send(){
    var t = ctext.value.trim();
    if (!t) return;
    if (needProfile()) return;
    var subject = null;
    if (current === 'home' || current === 'history') {
      var open = document.querySelector('#detail.on');
      if (open) subject = dtitle.textContent;
    }
    ctext.value = ''; ctext.style.height = 'auto';
    // Optimistic: their own words appear immediately, the answer arrives by poll.
    var local = msgs.querySelector('.empty') ? [] : null;
    if (local) msgs.innerHTML = '';
    msgs.insertAdjacentHTML('beforeend', '<div class="msg them">'+esc(t)+
      '<span class="ctx">from '+esc(LABEL[current]||current)+'</span></div>');
    document.getElementById('chatbody').scrollTop = 99999;
    lastCount = -1;
    post({kind:'chat', text:t, page:current, subject:subject})
      .catch(function(){ say('Could not reach me just now.'); });
  }
  document.getElementById('csend').addEventListener('click', send);
  ctext.addEventListener('input', function(){
    ctext.style.height = 'auto';
    ctext.style.height = Math.min(120, ctext.scrollHeight) + 'px';
  });
  ctext.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  // ── boot
  paintProfile();
  paintShelves();
  watch();
  go((location.hash || '#home').slice(1));
  apply();
  window.addEventListener('hashchange', function(){ go(location.hash.slice(1)); });
  if (!me && !D.single) setTimeout(function(){ paintProfile(); openSheet('menu'); }, 600);
})();
</script>`;
}
