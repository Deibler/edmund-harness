/**
 * Everything the recipe page runs in the browser.
 *
 * Step navigation, the per-step timers, the view toggle between one step at a
 * time and the whole thing as a list, the microphone, the photo upload and the
 * "we made it" tap. Moved out of `recipepage.ts` on 2026-08-17 unedited.
 *
 * A string rather than a real module for the same reason as the main site's:
 * the page is one static file behind a token, and a second request for a .js
 * file would need the key appended the way every image does.
 *
 * It takes no parameters. Everything it needs about the recipe arrives in the
 * JSON payload the renderer writes into the page above it.
 */

export const CLIENT = `<script>
(function(){
  var KEY = location.search || '';
  var D = JSON.parse(document.getElementById('d').textContent);
  var LAST = D.steps.length + 1;
  function esc(s){ var d=document.createElement('div'); d.textContent=s==null?'':s; return d.innerHTML; }

  document.getElementById('back').href = '../index.html' + KEY;
  document.querySelectorAll('a[data-page]').forEach(function(a){
    a.href = a.getAttribute('href') + KEY;
  });

  // ── images. Assets 403 without the share token, so it is appended here.
  //    A reference photo that fails takes its own frame with it rather than
  //    leaving a grey box that reads as a broken page.
  function bind(i){
    if (i.src) return;
    i.addEventListener('load', function(){ i.classList.add('ready'); });
    i.addEventListener('error', function(){
      var t = i.closest('.tech'), h = i.closest('.hero');
      if (t) i.remove(); else if (h) h.remove();
    });
    i.src = i.dataset.img + KEY;
  }
  // Only the visible card's images are loaded, since the others are display:none
  // and an IntersectionObserver never fires for them. Reading straight through,
  // every card is visible, so every card's images are wanted.
  function watch(){
    document.querySelectorAll(
      (mode === 'flow' ? '.view' : '.view.on') + ' img[data-img]').forEach(bind);
  }

  /**
   * Two ways to read the same recipe.
   *
   * Step-by-step is the cooking posture and stays the default. The long list is
   * for reading it through, deciding whether to make it, or cooking from
   * something propped on the counter that you are not going to keep tapping.
   *
   * Kept in a cookie rather than the URL so it follows the person across every
   * recipe on the site, which is what a reading preference means. Same cookie
   * name the hub uses for a profile, so it survives the same way.
   */
  function cookie(k, v){
    if (v === undefined) {
      var m = document.cookie.match(new RegExp('(?:^|; )'+k+'=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    }
    document.cookie = k+'='+encodeURIComponent(v)+';path=/;max-age='+(60*60*24*365)+';SameSite=Lax';
    return v;
  }
  var mode = cookie('kitchen_recipe_view') === 'flow' ? 'flow' : 'step';
  function setMode(next, announce){
    mode = next === 'flow' ? 'flow' : 'step';
    cookie('kitchen_recipe_view', mode);
    document.body.classList.toggle('flow', mode === 'flow');
    document.querySelectorAll('[data-mode]').forEach(function(b){
      b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false');
    });
    // Leaving the long list drops you back on whatever step you had scrolled
    // to, rather than at the top of a recipe you were halfway through.
    if (mode === 'flow') { paintWhere(); watch(); if (announce) scrollTo(at); }
    else go(at);
  }
  function scrollTo(n){
    var el = document.querySelector('.view[data-view="'+n+'"]');
    if (el) el.scrollIntoView({block:'start'});
  }
  function paintWhere(){
    document.getElementById('where').textContent = mode === 'flow'
      ? D.steps.length + ' steps'
      : at === 0 ? 'Overview'
      : at >= LAST ? 'Finished' : 'Step ' + at + ' / ' + D.steps.length;
  }

  // ── one step at a time. Position lives in the hash so a phone that locked
  //    mid-recipe comes back exactly where it was.
  var at = 0;
  function go(n){
    at = Math.max(0, Math.min(LAST, n));
    if (mode === 'flow') { paintWhere(); scrollTo(at); return; }
    document.querySelectorAll('.view').forEach(function(v){
      v.classList.toggle('on', Number(v.dataset.view) === at);
    });
    document.getElementById('bar').style.width = (at / LAST * 100) + '%';
    var prev = document.getElementById('prev');
    prev.style.visibility = at === 0 ? 'hidden' : '';
    var next = document.getElementById('next');
    next.textContent = at === 0 ? 'Start cooking'
      : at >= LAST ? 'Back to all meals'
      : at === LAST - 1 ? 'Finish' : 'Next step';
    paintWhere();
    var want = at === 0 ? '' : '#step-' + at;
    if ((location.hash || '') !== want) {
      history.replaceState(null, '', location.pathname + KEY + want);
    }
    window.scrollTo(0, 0);
    watch();
  }
  document.addEventListener('click', function(e){
    var b = e.target.closest('[data-mode]'); if (!b) return;
    closeJump(); setMode(b.dataset.mode, true);
  });
  document.getElementById('next').addEventListener('click', function(){
    if (at >= LAST) { location.href = '../index.html' + KEY; return; }
    go(at + 1);
  });
  document.getElementById('prev').addEventListener('click', function(){ go(at - 1); });
  document.getElementById('restart').addEventListener('click', function(){ go(1); });
  document.getElementById('done').addEventListener('click', function(){
    location.href = '../index.html' + KEY;
  });
  // Saying you cooked it is destructive (the ingredients leave the shelves), so
  // it confirms first, same as everything else that spends something.
  document.getElementById('cooked').addEventListener('click', function(){
    var self = this;
    confirmSheet({
      title: 'Log ' + D.name,
      what: 'This takes the ingredients off the shelves and puts ' + D.name +
        ' in the history for today. If it left leftovers, they go in the fridge.',
      yes: 'Yes, we made it',
      working: 'Logging',
      run: function(){ return post({kind:'cooked', recipe:D.id, name:D.name}); },
      after: function(){
        self.disabled = true; self.textContent = 'Logged';
        document.getElementById('dsub').textContent =
          'Logged. The shelves will catch up in a minute.';
      },
    });
  });
  // Arrows and swipes move between cards, which only means anything when there
  // is one card on screen. Reading the list, a sideways flick is a scroll.
  document.addEventListener('keydown', function(e){
    if (document.querySelector('.sheet.on') || mode === 'flow') return;
    if (e.key === 'ArrowRight') go(at + 1);
    if (e.key === 'ArrowLeft') go(at - 1);
  });
  // Swipe, but only a deliberate one. A short flick while reading a long step
  // should scroll, not skip a step of something somebody is cooking from.
  var sx = 0, sy = 0;
  document.addEventListener('touchstart', function(e){
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, {passive:true});
  document.addEventListener('touchend', function(e){
    if (mode === 'flow') return;
    var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 2) go(at + (dx < 0 ? 1 : -1));
  }, {passive:true});

  // ── sheets and panels
  function openSheet(id){ document.getElementById(id).classList.add('on'); }
  function closeSheets(){
    document.querySelectorAll('.sheet.on').forEach(function(s){ s.classList.remove('on'); });
  }
  var jump = document.getElementById('jump');
  function closeJump(){ jump.hidden = true; }
  document.addEventListener('click', function(e){ if (e.target.closest('[data-close]')) closeSheets(); });
  document.addEventListener('keydown', function(e){
    if (e.key !== 'Escape') return;
    closeSheets(); closeJump(); closeDock();
  });
  // Any tap outside the panel dismisses it. The old modal could only be closed
  // by hitting a thin strip of backdrop, which on a phone is most of the reason
  // it felt broken.
  document.addEventListener('click', function(e){
    if (jump.hidden) return;
    if (e.target.closest('#jump') || e.target.closest('#jumpbtn')) return;
    closeJump();
  }, true);

  document.getElementById('jumpbtn').addEventListener('click', function(){
    if (!jump.hidden) { closeJump(); return; }
    document.getElementById('jumplist').innerHTML =
      '<button class="jrow" data-step="0"'+(at===0?' aria-current="true"':'')+
        '><span class="jn">0</span><span>Overview and ingredients</span>'+
        (at>0?'<span class="tick">done</span>':'')+'</button>' +
      D.steps.map(function(s){
        return '<button class="jrow" data-step="'+s.n+'"'+(at===s.n?' aria-current="true"':'')+
          '><span class="jn">'+s.n+'</span><span>'+esc(s.title)+'</span>'+
          (at>s.n?'<span class="tick">done</span>':'')+'</button>';
      }).join('');
    jump.hidden = false;
  });
  document.getElementById('jumplist').addEventListener('click', function(e){
    var b = e.target.closest('[data-step]'); if (!b) return;
    closeJump(); go(Number(b.dataset.step));
  });

  // ── timers. Deadline-based rather than tick-counted, so a phone that sleeps
  //    for six minutes comes back with six minutes gone instead of none. They
  //    keep running across steps, which is the whole reason they live here.
  var running = [];
  function fmt(ms){
    var s = Math.max(0, Math.round(ms/1000));
    return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
  }
  setInterval(function(){
    var now = Date.now(), html = '';
    running.forEach(function(t){
      var left = t.end - now, done = left <= 0;
      t.btn.querySelector('.t').textContent = done ? 'done' : fmt(left);
      t.btn.dataset.done = done ? '1' : '0';
      if (done && !t.rang) { t.rang = true; if (navigator.vibrate) navigator.vibrate([200,100,200]); }
      html += '<div class="run'+(done?' done':'')+'">'+esc(t.label.slice(0,24))+
        ' <span>'+(done?'done':fmt(left))+'</span></div>';
    });
    document.getElementById('runsin').innerHTML = html;
    document.getElementById('runs').classList.toggle('on', running.length > 0);
  }, 500);
  document.querySelectorAll('[data-timer]').forEach(function(b){
    b.addEventListener('click', function(){
      var i = running.findIndex(function(t){ return t.btn === b; });
      if (i >= 0) {
        running.splice(i,1);
        b.dataset.done = '0';
        b.querySelector('.t').textContent = String(Number(b.dataset.timer)).padStart(2,'0')+':00';
        b.lastElementChild.textContent = 'start timer';
        return;
      }
      running.push({btn:b, end: Date.now() + Number(b.dataset.timer)*60000,
                    label: b.dataset.label, rang:false});
      b.lastElementChild.textContent = 'tap to stop';
    });
  });

  // ── posting
  function who(){
    var m = document.cookie.match(/(?:^|; )kitchen_profile=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function post(p){
    p.ts = new Date().toISOString();
    p.profile = who();
    return fetch('/callback' + KEY, {method:'POST',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify(p)});
  }

  /**
   * Nothing that sets me working starts on one tap.
   *
   * A "tap again to confirm" label on the button itself was the first attempt
   * and it is too quiet: the button still looks like a button, and somebody
   * moving quickly double-taps straight through it. So it is a real sheet that
   * names the action, says what will happen, and has to be dismissed or agreed
   * to. Same shape as the meals page, so the answer to "will this do something"
   * is the same everywhere on the site.
   */
  function confirmSheet(opts){
    document.getElementById('chead').textContent = opts.title;
    document.getElementById('cwhat').textContent = opts.what;
    var yes = document.getElementById('cyes');
    yes.textContent = opts.yes;
    yes.disabled = false;
    openSheet('confirm');
    yes.onclick = function(){
      yes.disabled = true; yes.textContent = opts.working;
      opts.run()
        .then(function(){ closeSheets(); opts.after(); })
        .catch(function(){ yes.disabled = false; yes.textContent = opts.yes;
          document.getElementById('cwhat').textContent = 'Could not reach me just now. Try again in a moment.'; });
    };
  }

  document.getElementById('addlist').addEventListener('click', function(){
    var self = this;
    confirmSheet({
      title: 'Add to the shopping list',
      what: D.missing.length
        ? 'I will work out the real products and sizes for ' + D.missing.join(', ') +
          ', check them against what is already in the kitchen and already on the list, and add ' +
          'what is genuinely missing.'
        : 'Nothing here is short right now. I can still go through the recipe and check whether ' +
          'anything is needed that the kitchen does not track.',
      yes: 'Add to the list',
      working: 'Working it out',
      run: function(){
        return post({kind:'addlist', recipe:D.id, name:D.name, missing:D.missing, items:D.missing});
      },
      after: function(){ self.disabled = true; self.textContent = 'On the shopping list'; },
    });
  });

  document.getElementById('variant').addEventListener('click', function(){
    var self = this;
    confirmSheet({
      title: 'Build a variant',
      what: 'I will write a new version of ' + D.name + ' around what the kitchen actually has' +
        (D.missing.length ? ', working around ' + D.missing.join(' and ') : '') +
        ', save it as another take on this dish, and text it over.',
      yes: 'Build it',
      working: 'Sending',
      run: function(){ return post({kind:'variant', recipe:D.id, name:D.name, missing:D.missing}); },
      after: function(){ self.disabled = true; self.textContent = 'On it, I will text it over'; },
    });
  });

  // ── photographs of the real thing.
  //
  // Downscaled and re-encoded in the browser before it leaves: a modern phone
  // shoots twelve megapixels, the card renders it at four hundred pixels wide,
  // and the difference is entirely upload time on a kitchen wifi. 1600px on the
  // long edge is well past what any surface here displays.
  //
  // Posted as raw bytes to /upload rather than base64 in a callback, because the
  // callback log is parsed on every poll and a megabyte on one line would slow
  // that down forever.
  function shrink(file, cb){
    var img = new Image(), url = URL.createObjectURL(file);
    img.onload = function(){
      var max = 1600, w = img.width, h = img.height;
      var scale = Math.min(1, max / Math.max(w, h));
      var c = document.createElement('canvas');
      c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(function(b){ cb(b || file); }, 'image/jpeg', 0.86);
    };
    // A format the canvas cannot decode still deserves to be uploaded; the
    // server checks the magic bytes and will reject it if it is not an image.
    img.onerror = function(){ URL.revokeObjectURL(url); cb(file); };
    img.src = url;
  }

  document.querySelectorAll('[data-shoot]').forEach(function(label){
    var input = label.querySelector('input');
    var span = label.querySelector('span');
    var original = span.textContent;
    input.addEventListener('change', function(){
      var f = input.files && input.files[0];
      if (!f) return;
      label.dataset.busy = '1'; span.textContent = 'Sending';
      shrink(f, function(blob){
        var q = KEY + (KEY ? '&' : '?') + 'name=' + encodeURIComponent(D.id) +
          '&recipe=' + encodeURIComponent(D.id) +
          (label.dataset.step ? '&step=' + encodeURIComponent(label.dataset.step) : '') +
          '&profile=' + encodeURIComponent(who() || '');
        fetch('/upload' + q, {method:'POST', headers:{'Content-Type':'image/jpeg'}, body: blob})
          .then(function(res){ return res.ok ? res.json() : Promise.reject(res.status); })
          .then(function(){
            label.dataset.busy = '';
            span.textContent = label.dataset.step ? 'Got it, that step is yours now'
                                                  : 'Got it, that is the picture now';
          })
          .catch(function(){
            label.dataset.busy = ''; span.textContent = 'Could not send that. Try again.';
            setTimeout(function(){ span.textContent = original; }, 4000);
          });
      });
    });
  });

  // ── voice. Speech in is the browser's own recogniser: free, no upload, works
  //    with the extractor running. Speech out is generated in my voice and
  //    polled for; if that fails the browser reads the text, because an answer
  //    in the wrong voice beats no answer.
  var vq = document.getElementById('vq'), va = document.getElementById('va'),
      vstate = document.getElementById('vstate'), mic = document.getElementById('mic'),
      vdock = document.getElementById('vdock');
  function openDock(){ vdock.hidden = false; }
  function closeDock(){
    vdock.hidden = true;
    clearTimeout(pollTimer);
    try { player.pause(); } catch(x){}
    try { speechSynthesis.cancel(); } catch(x){}
    if (rec) { try { rec.stop(); } catch(x){} }
    mic.dataset.on = '0';
  }
  var player = new Audio();
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, pollTimer = null, waitingRid = null;

  function unlockAudio(){
    // iOS only starts audio from inside a gesture and the answer arrives seconds
    // later, so the element is primed on the tap that asks the question.
    try {
      player.src = 'data:audio/mp4;base64,AAAAHGZ0eXBNNEEgAAAAAE00QSBpc29tbXA0MgAAAAhmcmVl';
      var p = player.play(); if (p && p.catch) p.catch(function(){});
    } catch(e){}
  }
  function say(t){ vstate.textContent = t; }
  function speakLocally(t){
    try { speechSynthesis.speak(new SpeechSynthesisUtterance(t)); } catch(e){}
  }

  function poll(n){
    clearTimeout(pollTimer);
    var me = who();
    if (!me) return;
    if (n > 40) { say('Still working on it. It will appear here when it lands.'); return; }
    // Two things here are load-bearing and both were bugs.
    //
    // '../' because this page lives in /recipe/ and the voice directory sits at
    // the artifact root, so a bare relative path asked for /recipe/voice/ and
    // 404'd forever while the answer sat correctly written one level up.
    //
    // NOT encodeURIComponent, because the share server matches the raw path and
    // does not percent-decode it, so an encoded '+' was a permanent 404 too.
    // safeName already reduces the principal to path-legal characters, which is
    // what makes leaving it raw correct rather than lucky.
    fetch('../voice/' + me.replace(/[^A-Za-z0-9+.-]/g,'_') + '.json' + KEY, {cache:'no-store'})
      .then(function(r){ return r.ok ? r.json() : {turns:[]}; })
      .then(function(d){
        var hit = (d.turns||[]).filter(function(t){ return t.rid === waitingRid; })[0];
        if (!hit) { pollTimer = setTimeout(function(){ poll(n+1); }, 2500); return; }
        va.textContent = hit.say; say('');
        if (hit.audio) {
          // Stored relative to the artifact root, read from a page one level in.
          player.src = '../' + hit.audio + KEY;
          var p = player.play(); if (p && p.catch) p.catch(function(){ speakLocally(hit.say); });
        } else speakLocally(hit.say);
      })
      .catch(function(){ pollTimer = setTimeout(function(){ poll(n+1); }, 3000); });
  }

  function ask(text){
    if (!text) return;
    openDock();
    if (!who()) {
      say('Open the meals page once and pick who you are, then I know whose question this is.');
      return;
    }
    waitingRid = 'v' + Date.now() + Math.floor(Math.random()*1000);
    vq.textContent = text; va.textContent = ''; say('Thinking');
    post({kind:'voice', rid:waitingRid, text:text, recipe:D.id,
          step: (at >= 1 && at <= D.steps.length) ? at : null})
      .then(function(){ poll(0); })
      .catch(function(){ say('Could not reach me just now.'); });
  }

  document.getElementById('vclose').addEventListener('click', closeDock);
  mic.addEventListener('click', function(){
    unlockAudio();
    if (rec) { try { rec.stop(); } catch(e){} return; }
    openDock();
    vq.textContent = ''; va.textContent = '';
    if (!SR) {
      say('This browser will not listen, so type it instead.');
      document.getElementById('vtext').focus();
      return;
    }
    // Interim results are the point: the words appear as they are spoken, so
    // there is never a silent gap where nothing seems to be happening.
    rec = new SR();
    rec.lang = 'en-US'; rec.interimResults = true; rec.maxAlternatives = 1;
    var heard = '';
    rec.onstart = function(){ mic.dataset.on = '1'; say('Listening'); };
    rec.onresult = function(e){
      heard = '';
      for (var i=0;i<e.results.length;i++) heard += e.results[i][0].transcript;
      vq.textContent = heard;
    };
    rec.onerror = function(e){
      say(e.error === 'not-allowed'
        ? 'Microphone is blocked for this page. Type it instead.'
        : 'Did not catch that. Try again, or type it.');
    };
    rec.onend = function(){
      mic.dataset.on = '0'; rec = null;
      if (heard.trim()) ask(heard.trim()); else if (!va.textContent) say('Heard nothing. Try again.');
    };
    try { rec.start(); } catch(e){ rec = null; say('Could not start listening. Type it instead.'); }
  });
  document.getElementById('vsend').addEventListener('click', function(){
    var el = document.getElementById('vtext');
    unlockAudio(); ask(el.value.trim()); el.value = '';
  });
  document.getElementById('vtext').addEventListener('keydown', function(e){
    if (e.key !== 'Enter') return;
    unlockAudio(); ask(this.value.trim()); this.value = '';
  });


  // ── boot
  var m = /^#step-(\\d+)$/.exec(location.hash || '');
  at = m ? Number(m[1]) : 0;
  // setMode paints the whole page for whichever way this person reads, so it
  // runs before the first go() rather than leaving one frame in the default.
  setMode(mode, false);
  if (mode === 'flow' && at) scrollTo(at);
})();
</script>`;
