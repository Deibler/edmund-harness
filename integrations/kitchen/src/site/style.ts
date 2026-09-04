/**
 * The site's stylesheet and web-font links.
 *
 * Split out of `site.ts` on 2026-08-17 purely by moving text: this file is the
 * same declarations that used to sit at the top of the renderer, unedited. It
 * is 500 lines of CSS and it was the single largest reason nothing else in that
 * file could be found.
 *
 * The rules themselves are documented where they sit, because most of them
 * exist to work around something specific about a phone browser and the comment
 * is the only record of what.
 */

export const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link href="https://fonts.googleapis.com/css2?' +
  "family=Fraunces:opsz,wght,SOFT,WONK@9..144,300..900,0..100,0..1&" +
  'family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">';

export const CSS = `
:root{
  --paper:38 33% 97%; --paper-2:36 26% 94%; --ink:20 14% 11%;
  --ink-soft:22 9% 38%; --ink-faint:24 7% 56%;
  --line:30 14% 87%; --card:0 0% 100%;
  --accent:14 72% 41%; --accent-soft:14 60% 96%;
  --good:150 42% 30%; --warn:32 82% 42%; --bad:0 62% 44%;
  --r:14px; --tap:48px;
}
@media (prefers-color-scheme:dark){
  :root{
    --paper:24 12% 8%; --paper-2:24 10% 13%; --ink:36 30% 95%;
    --ink-soft:30 8% 68%; --ink-faint:28 6% 52%;
    --line:24 8% 21%; --card:24 10% 12%;
    --accent:14 70% 56%; --accent-soft:14 30% 18%;
    --good:150 40% 62%; --warn:32 78% 62%; --bad:0 65% 66%;
  }
}
*{box-sizing:border-box;border-color:hsl(var(--line));-webkit-tap-highlight-color:transparent}
/* An explicit display beats the [hidden] attribute's UA rule, and several things
   here are display:grid or flex. Without this the "0" filter badge and the
   empty-state blocks stay on screen while claiming to be hidden. */
[hidden]{display:none !important}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:hsl(var(--paper));color:hsl(var(--ink));
  font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;
  -webkit-font-smoothing:antialiased;overscroll-behavior-y:none}
body.locked{overflow:hidden}
h1,h2,h3,.display{font-family:Fraunces,Georgia,serif;font-optical-sizing:auto;
  font-variation-settings:"SOFT" 30,"WONK" 1;letter-spacing:-.015em;margin:0}
.tabular{font-variant-numeric:tabular-nums}
button{font:inherit;color:inherit;cursor:pointer;background:none;border:0}
input,textarea{font:inherit;color:inherit}
.wrap{max-width:1180px;margin:0 auto;padding:0 18px}
[data-panel]{display:none}
[data-panel].on{display:block;animation:in .26s cubic-bezier(.2,.7,.3,1)}
@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
svg{display:block}

/* header: where you are, filter, menu. Nothing else. */
header{position:sticky;top:0;z-index:60;background:hsl(var(--paper)/.9);
  backdrop-filter:saturate(1.6) blur(14px);border-bottom:1px solid hsl(var(--line))}
.hrow{display:flex;align-items:center;gap:10px;height:60px}
/* The household name is derived from whoever lives there, so its length is not
   something this stylesheet gets to choose. At a fixed 19px "Sam and Alex's
   Kitchen" ellipsised to "Sam and Alex's Kitch…" on a 390px phone — the
   title of the whole site, clipped, on every page. Scale with the viewport
   instead and cap at the old size so wider screens are unchanged. */
.where{font-family:Fraunces,serif;font-weight:600;font-size:clamp(15px,4.7vw,19px);
  letter-spacing:-.02em;
  margin-right:auto;display:flex;align-items:baseline;gap:8px;min-width:0}
.where span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.where small{font-family:Inter,sans-serif;font-weight:500;font-size:10.5px;letter-spacing:.14em;
  text-transform:uppercase;color:hsl(var(--ink-faint));flex:none}
.iconbtn{width:var(--tap);height:var(--tap);border:1px solid hsl(var(--line));border-radius:13px;
  background:hsl(var(--card));display:grid;place-items:center;flex:none;position:relative}
.iconbtn:active{transform:scale(.95)}
.iconbtn .badge{position:absolute;top:-4px;right:-4px;min-width:19px;height:19px;padding:0 5px;
  border-radius:99px;background:hsl(var(--accent));color:#fff;font-size:11px;font-weight:700;
  display:grid;place-items:center;border:2px solid hsl(var(--paper))}
.dnav{display:none;gap:3px;margin-right:8px}
.dnav button{padding:9px 13px;border-radius:999px;font-size:14px;font-weight:500;
  color:hsl(var(--ink-soft))}
.dnav button[aria-current="page"]{background:hsl(var(--ink));color:hsl(var(--paper))}
@media(min-width:940px){.dnav{display:flex}.menubtn{display:none}}

/* sheets: menu, filters, detail, chat all use one primitive */
.sheet{position:fixed;inset:0;z-index:90;display:none}
.sheet.on{display:block}
.sheet .bg{position:absolute;inset:0;background:hsl(var(--ink)/.45);
  animation:fade .22s ease}
@keyframes fade{from{opacity:0}to{opacity:1}}
/* Heights are dvh, not vh.
   On iOS, vh means the viewport with the URL bar HIDDEN, so a sheet anchored to
   the bottom at 92vh extends past the top of what you can actually see and its
   title and close button end up behind the browser chrome. dvh tracks the real
   visible height. vh stays as the first declaration for anything that does not
   know dvh, since being slightly too tall beats collapsing to nothing. */
.sheet .pane{position:absolute;left:0;right:0;bottom:0;max-height:92vh;max-height:88dvh;display:flex;
  flex-direction:column;background:hsl(var(--paper));border-radius:22px 22px 0 0;
  animation:up .3s cubic-bezier(.2,.8,.3,1)}
@keyframes up{from{transform:translateY(24px);opacity:.5}to{transform:none;opacity:1}}
.sheet .grab{width:38px;height:4px;border-radius:99px;background:hsl(var(--line));
  margin:9px auto 4px;flex:none}
.sheet .shead{display:flex;align-items:center;gap:12px;padding:8px 18px 12px;flex:none;
  border-bottom:1px solid hsl(var(--line))}
.sheet .shead h3{font-size:21px;font-weight:600;margin-right:auto}
.sheet .sbody{overflow-y:auto;-webkit-overflow-scrolling:touch;padding:16px 18px;
  flex:1 1 auto;min-height:0;overscroll-behavior:contain}
.sheet .sfoot{flex:none;padding:12px 18px calc(16px + env(safe-area-inset-bottom));
  border-top:1px solid hsl(var(--line));background:hsl(var(--paper));display:flex;gap:10px}
@media(min-width:760px){
  .sheet .pane{left:50%;right:auto;bottom:auto;top:50%;transform:translate(-50%,-50%);
    width:min(640px,94vw);max-height:86vh;max-height:86dvh;border-radius:18px}
  @keyframes up{from{transform:translate(-50%,-46%);opacity:.5}
    to{transform:translate(-50%,-50%);opacity:1}}
  .sheet .grab{display:none}
}
.sheet.full .pane{top:0;bottom:0;max-height:none;border-radius:0}
@media(min-width:760px){.sheet.full .pane{top:50%;bottom:auto;max-height:86vh;border-radius:18px}}

/* nav list inside the menu sheet */
.navitem{display:flex;align-items:center;gap:14px;width:100%;padding:15px 14px;border-radius:13px;
  text-align:left;font-size:17px;font-weight:500;min-height:var(--tap)}
.navitem small{margin-left:auto;font-size:12.5px;color:hsl(var(--ink-faint));font-weight:400}
.navitem[aria-current="page"]{background:hsl(var(--ink));color:hsl(var(--paper))}
.navitem[aria-current="page"] small{color:hsl(var(--paper)/.65)}

/* filter sheet */
.fgroup{margin-bottom:22px}
.fgroup h4{font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;
  color:hsl(var(--ink-faint));margin:0 0 10px}
.fopt{display:flex;align-items:center;gap:12px;width:100%;padding:13px 14px;border-radius:12px;
  border:1px solid hsl(var(--line));background:hsl(var(--card));margin-bottom:8px;
  font-size:15px;min-height:var(--tap);text-align:left}
.fopt .ct{margin-left:auto;font-size:13px;color:hsl(var(--ink-faint))}
.fopt[aria-pressed="true"]{background:hsl(var(--ink));color:hsl(var(--paper));
  border-color:hsl(var(--ink))}
.fopt[aria-pressed="true"] .ct{color:hsl(var(--paper)/.7)}
.seg{display:flex;gap:8px}
.seg .fopt{margin:0;justify-content:center}

/* section furniture */
.head{padding:30px 0 16px;border-bottom:1px solid hsl(var(--line));margin-bottom:20px}
.head h2{font-size:clamp(27px,7vw,40px);font-weight:600;line-height:1.04}
.head p{margin:8px 0 0;color:hsl(var(--ink-soft));font-size:14.5px;max-width:56ch;line-height:1.5}
.eyebrow{font-size:11px;letter-spacing:.15em;text-transform:uppercase;font-weight:700;
  color:hsl(var(--accent));margin-bottom:8px}
.active-filters{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:16px}
.afchip{display:inline-flex;align-items:center;gap:7px;background:hsl(var(--ink));
  color:hsl(var(--paper));border-radius:999px;padding:7px 12px;font-size:13px;font-weight:500}

/* photography */
.shot{background:hsl(var(--paper-2));position:relative;overflow:hidden}
.shot img{width:100%;height:100%;object-fit:cover;display:block;opacity:0;
  transition:opacity .4s ease}
.shot img.ready{opacity:1}
.mono{position:absolute;inset:0;display:grid;place-items:center;font-family:Fraunces,serif;
  font-weight:600;color:hsl(var(--ink-faint));letter-spacing:.06em;font-size:20px}

/* meal cards */
.meals{display:grid;gap:16px;grid-template-columns:1fr}
@media(min-width:620px){.meals{grid-template-columns:repeat(auto-fill,minmax(272px,1fr))}}
[data-view="list"] .meals{grid-template-columns:1fr;gap:9px}
.meal{position:relative;border-radius:var(--r);overflow:hidden;background:hsl(var(--card));
  border:1px solid hsl(var(--line));display:flex;flex-direction:column}
.meal .shot{aspect-ratio:16/10}
.meal .body{padding:14px 15px 15px;display:flex;flex-direction:column;gap:8px;flex:1}
.meal h3{font-size:19px;font-weight:600;line-height:1.18;padding-right:34px}
.meal .desc{font-size:13.5px;color:hsl(var(--ink-soft));line-height:1.45;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.clockrow{margin-top:12px;padding:11px 13px;border-radius:var(--r);
  background:hsl(var(--accent)/.08);border:1px solid hsl(var(--accent)/.22);
  display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:space-between}
.clockrow p{font-size:13px;color:hsl(var(--ink));line-height:1.4;flex:1;min-width:180px}
.meal .why{font-size:12.5px;color:hsl(var(--accent));line-height:1.4;font-weight:500;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.meal .foot{margin-top:auto;padding-top:2px}
.star{position:absolute;top:8px;right:8px;width:38px;height:38px;border-radius:50%;
  background:hsl(var(--paper)/.9);backdrop-filter:blur(6px);display:grid;place-items:center;z-index:2}
.star svg{width:19px;height:19px;fill:none;stroke:hsl(var(--ink));stroke-width:1.8}
.star[aria-pressed="true"] svg{fill:hsl(var(--accent));stroke:hsl(var(--accent))}
/* Badges stack down the left so a dish can be several things at once. Each is a
   button: an icon that says "this is special" and cannot be acted on is
   decoration, and decoration is what people stop seeing. */
.badges{position:absolute;top:8px;left:8px;display:flex;flex-direction:column;gap:6px;z-index:2}
.badges button{width:38px;height:38px;border-radius:50%;border:0;padding:0;
  background:hsl(var(--paper)/.92);backdrop-filter:blur(6px);display:grid;place-items:center;
  cursor:pointer}
.badges svg{width:20px;height:20px;color:hsl(var(--ink))}
.badges .bg-recycle svg{color:hsl(var(--accent))}
.badges .bg-leaf svg{color:hsl(var(--good))}
.badges .bg-leaf{position:relative}
.badges .bg-leaf b{position:absolute;right:-1px;bottom:-1px;background:hsl(var(--good));
  color:hsl(var(--paper));border-radius:50%;width:17px;height:17px;display:grid;
  place-items:center;font:700 10px/1 ui-sans-serif,system-ui,sans-serif}
[data-view="list"] .meal{flex-direction:row}
[data-view="list"] .meal .shot{aspect-ratio:1;width:96px;flex:0 0 96px}
[data-view="list"] .meal .desc{display:none}
[data-view="list"] .meal .why{-webkit-line-clamp:1}
[data-view="list"] .meal .body{padding:12px 14px}
[data-view="list"] .meal h3{font-size:16.5px;padding-right:0}
[data-view="list"] .star{display:none}
/* In list view the shot is a 96px square, so 38px circles on top of it swallow
   the photograph. The badges shrink and tuck into the corner instead. */
[data-view="list"] .badges{top:4px;left:4px;gap:3px}
[data-view="list"] .badges button{width:24px;height:24px}
[data-view="list"] .badges svg{width:13px;height:13px}
[data-view="list"] .badges .bg-leaf b{width:12px;height:12px;font-size:8px}

/* Two rows, always. One line of tags that may wrap however it likes, then the
   actions on their own line pinned right. Sharing one wrapping flex row meant
   the buttons jumped left the moment the tags ran long, which is what made the
   grid look untidy at some widths and fine at others. */
.meal .foot{display:flex;flex-direction:column;gap:9px;align-items:stretch}
.foot .facts{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:22px}
.foot .btns{display:flex;gap:7px;justify-content:flex-end}
.foot .btns .btn{white-space:nowrap}
.pill.pre{background:hsl(var(--accent)/.1);color:hsl(var(--accent));border-color:transparent}
.checkcard{display:flex;align-items:center;gap:14px;text-decoration:none;color:inherit;
  background:hsl(var(--card));border:1px solid hsl(var(--line));border-radius:var(--r);
  padding:16px 17px;margin-bottom:16px}
.checkcard p{font-size:14px;color:hsl(var(--ink-soft));line-height:1.5;margin-top:7px}
.checkcard .go{flex:0 0 auto;color:hsl(var(--ink-faint));display:grid;place-items:center}
.shortrow{padding:13px 0;border-bottom:1px solid hsl(var(--line))}
.shortrow:last-child{border-bottom:0}
.shortrow .nm{font-weight:500;margin-bottom:9px}
.shortrow .sub{display:block;font-weight:400;font-size:13px;color:hsl(var(--ink-faint));
  margin-top:3px;font-variant-numeric:tabular-nums}
.shortrow .opts{display:flex;gap:7px;flex-wrap:wrap}
.shortrow.settled .nm{color:hsl(var(--ink-faint))}
.shortrow .verdict{font:700 10px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.13em;
  text-transform:uppercase;color:hsl(var(--good))}

.tag{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;
  letter-spacing:.04em;padding:4px 9px;border-radius:999px;text-transform:uppercase}
.tag.ready{background:hsl(var(--good)/.13);color:hsl(var(--good))}
.tag.short{background:hsl(var(--warn)/.15);color:hsl(var(--warn))}
.tag.live{background:hsl(var(--accent));color:#fff}
.tag.comp{background:hsl(var(--accent)/.12);color:hsl(var(--accent))}
.dot{width:5px;height:5px;border-radius:50%;background:currentColor}
.health{display:inline-flex;gap:2.5px;align-items:center}
.health i{width:5px;height:11px;border-radius:1.5px;background:hsl(var(--line));display:block}
.health i.on{background:hsl(var(--good))}

.btn{border-radius:12px;padding:12px 18px;font-size:14.5px;font-weight:600;min-height:var(--tap);
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  background:hsl(var(--ink));color:hsl(var(--paper))}
.btn:active{transform:scale(.98)}
.btn.alt{background:hsl(var(--card));color:hsl(var(--ink));border:1px solid hsl(var(--line))}
.btn.acc{background:hsl(var(--accent));color:#fff}
.btn.sm{padding:9px 14px;min-height:40px;font-size:13.5px;border-radius:10px}
.btn.wide{width:100%}
.btn:disabled{opacity:.45}

.live-wrap{background:hsl(var(--accent-soft));border:1px solid hsl(var(--accent)/.3);
  border-radius:var(--r);padding:16px;margin-bottom:22px}
.live-row{display:flex;flex-direction:column;gap:10px}
.live-row + .live-row{margin-top:12px;padding-top:12px;border-top:1px solid hsl(var(--accent)/.22)}
.live-row h3{font-size:18px;font-weight:600}
.live-row .when{font-size:12.5px;color:hsl(var(--ink-soft));line-height:1.45}
.live-row .acts{display:flex;gap:8px}
.live-row .acts .btn{flex:1}

/* product catalogue */
.prods{display:grid;gap:12px;grid-template-columns:repeat(2,1fr)}
@media(min-width:560px){.prods{grid-template-columns:repeat(auto-fill,minmax(158px,1fr))}}
.prod{position:relative;background:hsl(var(--card));border:1px solid hsl(var(--line));
  border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.prod .shot{aspect-ratio:1}
.prod .body{padding:9px 10px 11px}
.prod .nm{font-size:13.5px;font-weight:500;line-height:1.3;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.prod .qt{font-size:12px;color:hsl(var(--ink-faint));margin-top:3px}
.prod .flag{position:absolute;top:7px;left:7px;font-size:10px;font-weight:700;letter-spacing:.04em;
  padding:3px 7px;border-radius:6px;text-transform:uppercase;background:hsl(var(--bad));color:#fff}
.prod .flag.soon{background:hsl(var(--warn))}
[data-view="list"] .prods{grid-template-columns:1fr;gap:0}
[data-view="list"] .prod{flex-direction:row;align-items:center;border:0;border-radius:0;
  border-bottom:1px solid hsl(var(--line));background:none;padding:8px 0}
[data-view="list"] .prod .shot{width:44px;flex:0 0 44px;border-radius:9px}
[data-view="list"] .prod .body{padding:0 12px;display:flex;gap:12px;width:100%;align-items:center}
[data-view="list"] .prod .nm{-webkit-line-clamp:1;flex:1}
[data-view="list"] .prod .qt{margin:0}
[data-view="list"] .prod .flag{position:static;margin-left:auto}

/* calendar */
.cal{background:hsl(var(--card));border:1px solid hsl(var(--line));border-radius:var(--r);padding:14px}
.cal h3{font-size:19px;font-weight:600;margin-bottom:12px}
.cal .grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.cal .dow{font-size:10px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;
  color:hsl(var(--ink-faint));text-align:center;padding-bottom:5px}
.cal .day{aspect-ratio:1;border:1px solid hsl(var(--line));border-radius:8px;padding:4px;
  background:hsl(var(--paper));display:flex;flex-direction:column;gap:2px;overflow:hidden}
.cal .day.empty{border:0;background:none}
.cal .day .n{font-size:10.5px;color:hsl(var(--ink-faint));font-weight:700;line-height:1}
.cal .day.has{background:hsl(var(--accent-soft));border-color:hsl(var(--accent)/.35)}
.cal .day.today{outline:2px solid hsl(var(--ink));outline-offset:-1px}
.cal .day .m{font-size:9px;line-height:1.15;font-weight:500;overflow:hidden;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
@media(min-width:700px){.cal .day .m{font-size:11px}.cal .day .n{font-size:12px}}

/* history rows */
.hist{border-top:1px solid hsl(var(--line))}
/* cook-once-eat-twice pairs: two dishes read as one decision */
.pairs{margin:0 0 22px}
.pairlede{font-size:13.5px;color:hsl(var(--ink-soft));margin:2px 0 12px;line-height:1.5}
/* Bleeds to the screen edge so the next card is visibly cut off, which is what
   tells a thumb there is more. 18px matches .wrap's padding. */
.pairrow{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;
  margin:0 -18px;padding:2px 18px 6px;scrollbar-width:none}
.pairrow::-webkit-scrollbar{display:none}
.pair{flex:0 0 min(300px,82vw);scroll-snap-align:start;background:hsl(var(--card));
  border:1px solid hsl(var(--line));border-radius:var(--r);overflow:hidden}
.pairtop{display:flex;align-items:center;gap:0;position:relative}
.pairtop .shot{flex:1;aspect-ratio:4/3;border-radius:0}
.pairarrow{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:30px;height:30px;border-radius:50%;background:hsl(var(--card));
  border:1px solid hsl(var(--line));display:grid;place-items:center;
  color:hsl(var(--accent));z-index:1}
.pairbody{padding:13px 14px 14px}
.pairleg{display:flex;align-items:baseline;gap:8px;font-size:14.5px;line-height:1.35}
.pairleg + .pairleg{margin-top:5px}
.pairleg .when{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;
  color:hsl(var(--ink-faint));flex:0 0 66px}
.pairbody .note{margin:9px 0 11px}
.pairbody .btn{width:100%}

/* the automatic cleanup, and the one tap that reverses it */
.sweepcard{background:hsl(var(--card));border:1px dashed hsl(var(--line));
  border-radius:var(--r);padding:15px 16px;margin:0 0 18px;
  display:flex;flex-direction:column;gap:12px}
.sweepcard p{font-size:13.5px;color:hsl(var(--ink-soft));line-height:1.5;margin-top:3px}
.sweepcard .btn{align-self:flex-start}

.hrow2 .cost{font-size:14px;font-weight:600;color:hsl(var(--ink))}
.hrow2{display:flex;align-items:center;gap:13px;padding:12px 0;
  border-bottom:1px solid hsl(var(--line));width:100%;text-align:left;min-height:var(--tap)}
.hrow2 .shot{width:58px;flex:0 0 58px;aspect-ratio:1;border-radius:10px}
.hrow2 .nm{font-weight:600;font-size:15.5px;line-height:1.25}
.hrow2 .dt{font-size:12.5px;color:hsl(var(--ink-faint));margin-top:3px;
  display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.hrow2 .rt{margin-left:auto;flex:none;color:hsl(var(--ink-faint))}

/* wrapped */
.story{display:grid;gap:14px;grid-template-columns:1fr}
@media(min-width:620px){.story{grid-template-columns:repeat(auto-fit,minmax(290px,1fr))}}
.sc{border-radius:20px;padding:24px 22px;min-height:198px;display:flex;flex-direction:column;
  justify-content:space-between;color:#fff;position:relative;overflow:hidden}
.sc .lab{font-size:11px;letter-spacing:.16em;text-transform:uppercase;font-weight:700;opacity:.78;
  position:relative;z-index:2}
.sc .big{font-family:Fraunces,serif;font-weight:700;font-size:clamp(44px,12vw,70px);line-height:.9;
  letter-spacing:-.03em;margin:14px 0 6px;font-variation-settings:"SOFT" 0,"WONK" 1;
  position:relative;z-index:2}
.sc .mid{font-family:Fraunces,serif;font-weight:700;font-size:clamp(26px,7vw,40px);line-height:1.03;
  letter-spacing:-.02em;margin:14px 0 6px;position:relative;z-index:2}
.sc .sub{font-size:14px;line-height:1.42;opacity:.92;font-weight:500;position:relative;z-index:2}
.sc .art{position:absolute;right:-22px;bottom:-22px;width:150px;height:150px;border-radius:18px;
  overflow:hidden;opacity:.3;transform:rotate(-7deg)}
.sc .art img{width:100%;height:100%;object-fit:cover}
/* Flat, one deep colour each. These were two-stop gradients, which broke the
   house rule against them and, less obviously, blocked this site from ever
   being shared: the artifact validator refuses gradients outright, so the
   second household's page could be rendered and never served. A single ink
   carries the same separation between cards and prints better. */
.sc.a{background:#8E3517}
.sc.b{background:#16493A}
.sc.c{background:#21386B}
.sc.d{background:#6B4411}
.sc.e{background:#452154}
.sc.f{background:#152C47}
.sc.wide{grid-column:1/-1}
.rank{display:flex;align-items:center;gap:12px;padding:8px 0;position:relative;z-index:2}
.rank + .rank{border-top:1px solid rgba(255,255,255,.16)}
.rank .no{font-family:Fraunces,serif;font-size:21px;font-weight:700;width:24px;opacity:.6}
.rank .rn{font-weight:600;font-size:15px;flex:1}
.rank .rv{font-size:13px;opacity:.8;font-variant-numeric:tabular-nums}

/* generic */
.panelcard{background:hsl(var(--card));border:1px solid hsl(var(--line));border-radius:var(--r);
  padding:18px}
.stat{display:flex;flex-direction:column;gap:3px}
.stat .v{font-family:Fraunces,serif;font-size:28px;font-weight:600;letter-spacing:-.02em}
.stat .k{font-size:11.5px;color:hsl(var(--ink-faint));letter-spacing:.06em;text-transform:uppercase;
  font-weight:700}
.grid4{display:grid;gap:12px;grid-template-columns:repeat(2,1fr)}
@media(min-width:760px){.grid4{grid-template-columns:repeat(4,1fr)}}
.note{font-size:12.5px;color:hsl(var(--ink-faint));line-height:1.5}
.empty{padding:40px 20px;text-align:center;color:hsl(var(--ink-faint));font-size:14.5px}
.needline{display:flex;align-items:center;gap:10px;padding:11px 0;
  border-bottom:1px solid hsl(var(--line));font-size:14.5px}
.needline .st{margin-left:auto;font-size:12px;font-weight:700;text-transform:uppercase;
  letter-spacing:.04em;flex:none}
.check{display:flex;align-items:center;gap:12px;padding:13px 0;
  border-bottom:1px solid hsl(var(--line));width:100%;text-align:left;min-height:var(--tap)}
.check .box{width:24px;height:24px;border-radius:7px;border:1.8px solid hsl(var(--line));
  flex:none;display:grid;place-items:center}
.check[aria-pressed="true"] .box{background:hsl(var(--good));border-color:hsl(var(--good))}
.check[aria-pressed="true"] .lb{text-decoration:line-through;color:hsl(var(--ink-faint))}
.check .box svg{width:14px;height:14px;stroke:#fff;stroke-width:3;fill:none;opacity:0}
.check[aria-pressed="true"] .box svg{opacity:1}
/* A shopping line and its "change this" button share one row. The checkbox
   keeps the whole remaining width so the tap target for ticking stays huge,
   which is the thing you do a hundred times in a shop; the menu is a corner. */
.listrow{display:flex;align-items:center;gap:6px}
.listrow .check{flex:1;min-width:0;border-bottom:0}
.listrow{border-bottom:1px solid hsl(var(--line))}
.listrow:last-child{border-bottom:0}
.listrow .iconbtn{flex:none;border:0;color:hsl(var(--ink-faint))}
/* The tray. Deliberately not styled like a list row: no checkbox, buttons
   instead, so it never looks like something you can shop from. */
.sugrow{display:flex;align-items:center;gap:12px;padding:12px 0;
  border-bottom:1px solid hsl(var(--line))}
.sugrow:last-child{border-bottom:0}
.sugrow .sugacts{margin-left:auto;display:flex;gap:7px;flex:none}
.btn.ghost{background:none;color:hsl(var(--ink-soft));border:1px solid hsl(var(--line))}
@media (max-width:420px){
  .sugrow{flex-wrap:wrap}
  .sugrow .sugacts{margin-left:0;width:100%}
  .sugrow .sugacts .btn{flex:1}
}
.step{padding:14px 0;border-bottom:1px solid hsl(var(--line))}
.step .t{font-weight:600;font-size:15.5px;margin-bottom:4px}
.step .b{font-size:14px;color:hsl(var(--ink-soft));line-height:1.55}
.step .n{font-family:Fraunces,serif;font-size:12.5px;color:hsl(var(--accent));font-weight:700;
  letter-spacing:.06em}
.who{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid hsl(var(--line));
  border-radius:12px;background:hsl(var(--card));margin-bottom:9px;min-height:56px;width:100%;
  text-align:left}
.who input{width:22px;height:22px;accent-color:hsl(var(--accent));margin:0}
.avatar{width:38px;height:38px;border-radius:50%;background:hsl(var(--ink));color:hsl(var(--paper));
  display:grid;place-items:center;font-weight:700;font-size:15px;flex:none}

/* chat */
#chatbtn{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:70;
  width:56px;height:56px;border-radius:50%;background:hsl(var(--ink));color:hsl(var(--paper));
  display:grid;place-items:center;box-shadow:0 8px 26px hsl(var(--ink)/.3)}
#chatbtn svg{width:24px;height:24px;stroke:currentColor;stroke-width:1.8;fill:none}
.msgs{display:flex;flex-direction:column;gap:10px}
.msg{max-width:84%;padding:11px 14px;border-radius:16px;font-size:14.5px;line-height:1.45;
  white-space:pre-wrap;word-break:break-word}
.msg.them{align-self:flex-end;background:hsl(var(--ink));color:hsl(var(--paper));
  border-bottom-right-radius:5px}
.msg.me{align-self:flex-start;background:hsl(var(--card));border:1px solid hsl(var(--line));
  border-bottom-left-radius:5px}
.msg .ctx{display:block;font-size:11px;opacity:.6;margin-top:5px}
.composer{display:flex;gap:9px;align-items:flex-end;width:100%}
.composer textarea{flex:1;resize:none;border:1px solid hsl(var(--line));border-radius:14px;
  padding:13px 14px;background:hsl(var(--card));font-size:16px;max-height:120px;min-height:var(--tap);
  line-height:1.4}
.pill{display:inline-block;font-size:11.5px;font-weight:600;color:hsl(var(--ink-faint));
  background:hsl(var(--paper-2));border-radius:999px;padding:5px 11px;margin-bottom:10px}
.pill.big{color:hsl(var(--ink));background:hsl(var(--paper-2));font-weight:700}
.pill.season{color:hsl(var(--good));background:hsl(var(--good)/.1)}

/* the mood band: what kind of day it is, above what there is to cook */
.head.mood{padding-bottom:20px}
.head.mood .eyebrow{color:hsl(var(--ink-faint));margin-bottom:10px}
.viberow{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:16px;
  padding:13px 15px;border-radius:14px;background:hsl(var(--paper-2))}
.viberow .vibe{flex:1 1 auto;min-width:0;line-height:1.35}
.viberow .lab{display:block;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;
  font-weight:700;color:hsl(var(--ink-faint))}
.viberow b{font-size:16px;font-weight:600}
.shelves{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.shelf{display:inline-flex;align-items:center;gap:8px;padding:9px 14px;border-radius:999px;
  border:1px solid hsl(var(--line));background:hsl(var(--card));font-size:13.5px;font-weight:600;
  min-height:40px}
.shelf .ct{font-size:12px;color:hsl(var(--ink-faint));font-variant-numeric:tabular-nums}
.shelf[aria-pressed="true"]{background:hsl(var(--ink));color:hsl(var(--paper));border-color:transparent}
.shelf[aria-pressed="true"] .ct{color:hsl(var(--paper)/.7)}

/* explore: food this house does not make */
.idea{background:hsl(var(--card));border:1px solid hsl(var(--line));border-radius:var(--r);
  padding:18px;margin-bottom:14px}
.idea h3{font-size:19px;font-weight:600;line-height:1.2}
.idea .from{font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;
  color:hsl(var(--ink-faint));margin-bottom:7px}
.idea .desc{font-size:14.5px;color:hsl(var(--ink-soft));line-height:1.5;margin-top:8px}
.idea .why{font-size:13px;color:hsl(var(--ink-faint));line-height:1.5;margin-top:8px}
.idea .facts{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.idea .facts .pill{margin-bottom:0}
.idea .buy{margin-top:14px;padding-top:13px;border-top:1px solid hsl(var(--line));font-size:13.5px;
  color:hsl(var(--ink-soft));line-height:1.6}
.idea .buy b{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:hsl(var(--ink-faint));
  display:block;margin-bottom:5px}
.idea .btns{display:flex;gap:8px;margin-top:15px;flex-wrap:wrap}
.wait{display:flex;gap:9px;align-items:flex-start;margin-top:14px;padding:11px 13px;
  border-radius:12px;background:hsl(var(--paper-2));font-size:13px;line-height:1.45;
  color:hsl(var(--ink-soft))}
.wait b{color:hsl(var(--ink));font-weight:600}
.fh{font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;
  color:hsl(var(--ink-faint));margin:0 0 4px}
.setrow{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:15px 0;
  border-bottom:1px solid hsl(var(--line))}
.setrow:last-child{border-bottom:0}
.setrow .nm{font-weight:500;font-size:14.5px}
.setrow .sub{display:block;font-weight:400;font-size:12.5px;color:hsl(var(--ink-faint));
  margin-top:3px;line-height:1.45}
.stepper{display:flex;align-items:center;gap:10px;flex:0 0 auto}
.stepper b{min-width:66px;text-align:center;font-variant-numeric:tabular-nums;font-size:15px}
.stepper button{width:40px;height:40px;border-radius:11px;border:1px solid hsl(var(--line));
  background:hsl(var(--card));font-size:19px;font-weight:600;display:grid;place-items:center}

/* Standing dinner texts. The time is the thing you scan for, so it is the only
   thing set large, and a paused row is greyed rather than hidden — a schedule
   you have switched off is still a decision you made and want to see. */
.sched{display:flex;gap:16px;align-items:flex-start;padding:18px 0;
  border-bottom:1px solid hsl(var(--line))}
.sched:last-child{border-bottom:0}
.sched .when{flex:0 0 92px;font:600 21px/1.1 ui-serif,Georgia,serif;letter-spacing:-.02em;
  font-variant-numeric:tabular-nums}
/* Spelled out rather than using a --sans variable: this stylesheet has no such
   variable, and one bad token voids the whole font shorthand, which silently
   left the weekday list set in 21px serif. */
.sched .when small{display:block;font:500 11.5px/1.35 ui-sans-serif,system-ui,sans-serif;
  letter-spacing:.06em;text-transform:uppercase;color:hsl(var(--ink-faint));margin-top:6px}
.sched .body{flex:1;min-width:0}
.sched .body .t{font-weight:600;font-size:15px;line-height:1.3}
.sched .body .s{font-size:13px;color:hsl(var(--ink-faint));margin-top:4px;line-height:1.45}
.sched .btns{display:flex;gap:7px;margin-top:11px;flex-wrap:wrap}
.sched[data-on="0"]{opacity:.5}
.dayrow{display:flex;gap:6px;margin-top:10px}
.dayrow button{flex:1;min-width:0;height:44px;border-radius:11px;border:1px solid hsl(var(--line));
  background:hsl(var(--card));font-size:13px;font-weight:600;color:hsl(var(--ink))}
.dayrow button[aria-pressed="true"]{background:hsl(var(--ink));color:hsl(var(--paper));
  border-color:hsl(var(--ink))}
.timein{width:100%;min-height:var(--tap);padding:12px 14px;border-radius:12px;
  border:1px solid hsl(var(--line));background:hsl(var(--card));color:hsl(var(--ink));
  font-size:17px;font-family:inherit}
/* A labelled free-text field. 16px minimum on the input or iOS zooms the page
   the moment it takes focus and leaves the sheet scrolled sideways. */
.fld{display:block;font-size:12.5px;font-weight:600;letter-spacing:.02em;
  color:hsl(var(--ink-soft))}
.fld input{width:100%;margin-top:7px;min-height:var(--tap);padding:12px 14px;
  border-radius:12px;border:1px solid hsl(var(--line));background:hsl(var(--card));
  color:hsl(var(--ink));font-size:17px;font-family:inherit}

.toast{position:fixed;left:50%;bottom:calc(84px + env(safe-area-inset-bottom));z-index:95;
  transform:translate(-50%,20px);background:hsl(var(--ink));color:hsl(var(--paper));
  padding:13px 20px;border-radius:12px;font-size:14px;font-weight:500;opacity:0;transition:.3s;
  pointer-events:none;max-width:min(520px,92vw);text-align:center;line-height:1.4}
.toast.on{opacity:1;transform:translate(-50%,0)}
footer{margin:44px 0 96px;padding-top:18px;border-top:1px solid hsl(var(--line));
  font-size:12px;color:hsl(var(--ink-faint));line-height:1.6}
`;
