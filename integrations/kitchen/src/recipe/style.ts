/**
 * The recipe page's stylesheet.
 *
 * Moved out of `recipepage.ts` on 2026-08-17 by copying text, unedited. It is
 * 290 lines and it was sitting between the page's type definitions and the
 * function that renders it, which is why neither could be found.
 *
 * Most rules here exist to keep one step readable at arm's length on a phone
 * with wet hands, and the comment beside a rule is the only record of which
 * failure it is preventing.
 */

export const CSS = `
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{
  --bg:32 24% 97%; --card:0 0% 100%; --ink:24 12% 12%; --ink-soft:24 8% 38%;
  --ink-faint:24 6% 55%; --line:28 14% 88%; --accent:14 72% 47%;
  --good:142 52% 34%; --warn:38 88% 42%; --bad:0 68% 48%; --tap:48px;
  --nav:calc(74px + env(safe-area-inset-bottom));
}
@media (prefers-color-scheme:dark){:root{
  --bg:24 10% 8%; --card:24 10% 12%; --ink:32 20% 94%; --ink-soft:30 8% 72%;
  --ink-faint:28 6% 55%; --line:24 8% 22%; --accent:14 82% 60%;
}}
html{-webkit-text-size-adjust:100%}
body{background:hsl(var(--bg));color:hsl(var(--ink));
  font:400 16px/1.55 ui-serif,Georgia,"Iowan Old Style",serif;padding-bottom:var(--nav)}
.wrap{max-width:720px;margin:0 auto;padding:0 18px}

header{position:sticky;top:0;z-index:40;background:hsl(var(--bg)/.95);
  backdrop-filter:saturate(180%) blur(14px);border-bottom:1px solid hsl(var(--line))}
header .row{display:flex;align-items:center;gap:10px;min-height:54px}
a.back,button.jump{display:inline-flex;align-items:center;gap:6px;color:hsl(var(--ink-soft));
  text-decoration:none;background:none;border:0;cursor:pointer;
  font:600 13px/1 ui-sans-serif,system-ui,sans-serif;min-height:var(--tap);padding:0 2px}
button.jump{margin-left:0}
/* Where you are, in the part of the page that does not scroll away. The step
   number was only on the card, so the moment you scrolled into a long
   instruction you lost your place in the recipe. */
.where{margin-left:auto;font:700 12px/1 ui-sans-serif,system-ui,sans-serif;
  letter-spacing:.1em;text-transform:uppercase;color:hsl(var(--ink));
  font-variant-numeric:tabular-nums;white-space:nowrap}
.prog{height:3px;background:hsl(var(--line));position:relative}
.prog i{position:absolute;left:0;top:0;bottom:0;background:hsl(var(--accent));
  width:0;transition:width .3s ease}

/* Exactly one card is in the document at a time. The others are display:none
   rather than scrolled past, so a stray flick cannot land you in step 9. */
.view{display:none;padding-top:22px}
.view.on{display:block}

/* THE OTHER WAY TO READ A RECIPE.
 *
 * One-step-at-a-time is the right default while you are actually cooking, and
 * the wrong shape for reading the thing through first, checking whether you
 * want to make it, or cooking from a laptop propped open on the counter. Sam
 * asked for the long version, so both exist and the choice is remembered per
 * person on their own device.
 *
 * Every card shows at once, ruled apart, and the step navigation goes away
 * because there is nothing left to navigate. The microphone stays: asking out
 * loud is worth as much scrolling as it is stepping. */
body.flow .view{display:block;padding-top:34px;scroll-margin-top:72px}
body.flow .view + .view{border-top:1px solid hsl(var(--line));margin-top:34px}
body.flow nav.step .prev, body.flow nav.step .next{display:none}
body.flow nav.step{background:none;border:0;box-shadow:none;pointer-events:none}
body.flow nav.step .in{justify-content:flex-end}
body.flow nav.step .mic{pointer-events:auto;background:hsl(var(--ink));color:hsl(var(--bg));
  border:0;box-shadow:0 6px 22px hsl(var(--ink)/.28)}
body.flow .prog{visibility:hidden}
/* The camera on every step is a cooking control. Reading straight through, it
   is nine identical buttons down the page. */
body.flow .shoot{display:none}
.vopt{display:flex;gap:8px;margin-bottom:14px}
.vopt button{flex:1;min-height:var(--tap);border-radius:12px;border:1px solid hsl(var(--line));
  background:hsl(var(--card));color:hsl(var(--ink));
  font:600 13.5px/1.3 ui-sans-serif,system-ui,sans-serif;
  padding:10px 12px;cursor:pointer}
.vopt button[aria-pressed="true"]{background:hsl(var(--ink));color:hsl(var(--bg));
  border-color:hsl(var(--ink))}

.hero{border-radius:18px;overflow:hidden;background:hsl(var(--card));
  border:1px solid hsl(var(--line));aspect-ratio:4/3}
.hero img{width:100%;height:100%;object-fit:cover;display:block;opacity:0;transition:opacity .4s}
.hero img.ready{opacity:1}
h1{font:600 31px/1.15 ui-serif,Georgia,serif;letter-spacing:-.02em;margin:20px 0 8px}
.lede{color:hsl(var(--ink-soft));font-size:17px}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 4px}
.chip{font:600 12px/1 ui-sans-serif,system-ui,sans-serif;padding:9px 12px;border-radius:999px;
  border:1px solid hsl(var(--line));background:hsl(var(--card));color:hsl(var(--ink-soft));
  white-space:nowrap}
.chip.made{border-color:hsl(var(--good)/.4);color:hsl(var(--good))}
.chip b{font-variant-numeric:tabular-nums;color:hsl(var(--ink));font-weight:700}
h2{font:600 13px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.16em;
  text-transform:uppercase;color:hsl(var(--ink-faint));margin:32px 0 12px}
.note{color:hsl(var(--ink-faint));font-size:14px;font-family:ui-sans-serif,system-ui,sans-serif}

.card{background:hsl(var(--card));border:1px solid hsl(var(--line));border-radius:16px;padding:4px 16px}
/* A grid, not a flex row. As flex items all three sized to their own content,
   so an amount like "the whole package, about 6 thighs" took two thirds of the
   row on a phone, the name column collapsed to one word per line, and the stock
   badge landed on top of it. Same failure the step lists had, same fix: bound
   the amount, give the name a floor of zero so it is the one that flexes, and
   when the amount is long enough that bounding it would still crush the name,
   drop it to its own row instead. */
/* One shape for every row: ingredient and stock on the first line, the amount
   underneath at full width.

   These were three flex items sizing to their own content, so an amount like
   "the whole package, about 6 thighs" took two thirds of a phone row, the name
   collapsed to one word per line, and the stock badge landed on top of it. The
   first fix bounded the amount and stacked only the long ones, which worked but
   left the list alternating between two layouts and turned on a character count
   somebody would have to re-tune the first time an amount got wordier. Giving
   every row the same shape costs one line on the short ones and removes both
   problems: nothing competes for width, so nothing can be crushed, and there is
   no threshold to get wrong. Name first because this list is read to find an
   ingredient; the amount is what you read once you have found it. */
.ing{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;
  column-gap:12px;row-gap:3px;padding:13px 0;border-bottom:1px solid hsl(var(--line))}
.ing:last-child{border-bottom:0}
.ing .nm{grid-row:1;grid-column:1;min-width:0}
.ing .st{grid-row:1;grid-column:2;justify-self:end;white-space:nowrap;
  font:700 10px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase}
.ing .amt{grid-row:2;grid-column:1/-1;overflow-wrap:anywhere;
  font:600 14px/1.4 ui-sans-serif,system-ui,sans-serif;color:hsl(var(--ink-soft));
  font-variant-numeric:tabular-nums}
.ing .amt:empty{display:none}
/* A variant is a link with a name and a reason, not an ingredient: no amount,
   no stock. It shared the class and would have inherited the amount column. */
.vrow{display:flex;align-items:baseline;gap:12px;padding:13px 0;
  border-bottom:1px solid hsl(var(--line))}
.vrow:last-child{border-bottom:0}
.vrow .nm{flex:1;min-width:0}
details.full{margin:14px 0 0;border:1px solid hsl(var(--line));border-radius:14px;
  background:hsl(var(--card));padding:0 16px}
details.full > summary{list-style:none;cursor:pointer;padding:15px 0;min-height:var(--tap);
  font:600 14px/1.3 ui-sans-serif,system-ui,sans-serif;display:flex;align-items:center;gap:8px}
details.full > summary::-webkit-details-marker{display:none}
details.full > summary::after{content:"";margin-left:auto;width:8px;height:8px;
  border-right:2px solid hsl(var(--ink-faint));border-bottom:2px solid hsl(var(--ink-faint));
  transform:rotate(45deg);transition:transform .2s}
details.full[open] > summary::after{transform:rotate(-135deg)}

/* The step number is orientation, not an alarm. Ink, not accent. */
.eyebrow{font:700 11px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.17em;
  text-transform:uppercase;color:hsl(var(--ink));display:flex;gap:10px;align-items:center;
  padding-bottom:11px;border-bottom:1px solid hsl(var(--ink)/.85)}
.eyebrow .of{color:hsl(var(--ink-faint))}
.view h3{font:600 28px/1.18 ui-serif,Georgia,serif;margin:15px 0 0;letter-spacing:-.015em}
.body{color:hsl(var(--ink));font-size:18px;line-height:1.6;margin-top:15px}

/* THE STEP CARD, printed rather than decorated.
 *
 * Ruled sections, tabular figures, no coloured accent bars. Alex rejected
 * left accent bars on this project once already, in 2026-08-09, and a green bar
 * beside "done when" is exactly the thing he rejected: it reads as a framework
 * component dropped onto a page rather than as something typeset. A rule and a
 * small-caps label carry the same structure and look like a recipe.
 *
 * What this step puts in the pan sits above the instruction, because you reach
 * for it before you read. The amount here is the portion for THIS step. */
.uses{margin:16px 0 0;border-top:1px solid hsl(var(--ink)/.85)}
/* A grid, not a flex row. The amount used to be flex:0 0 auto, so it took its
   natural width and refused to give any of it back: a long one ("2 teaspoons on
   the shrimp, plus a pinch for the corn") ate the whole line, squeezed the
   ingredient name to one word per line, and pushed the HAVE badge off the right
   edge on top of it. Named columns with an explicit 1fr for the name means the
   name and the stock state always have their space no matter what the amount
   says. */
.uses .u{display:grid;grid-template-columns:auto minmax(0,1fr) auto;
  align-items:baseline;column-gap:12px;row-gap:2px;padding:10px 0;
  border-bottom:1px solid hsl(var(--line));font:400 16px/1.4 ui-sans-serif,system-ui,sans-serif}
.uses .u .q{font-weight:700;font-variant-numeric:tabular-nums;color:hsl(var(--ink));
  min-width:88px;max-width:11em;overflow-wrap:anywhere}
.uses .u .n{color:hsl(var(--ink-soft));min-width:0;overflow-wrap:anywhere}
.uses .u .s{font:700 9.5px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.11em;
  text-transform:uppercase;white-space:nowrap;color:hsl(var(--ink-faint));justify-self:end}
/* A sentence-length amount is a sentence: it gets its own line under the name
   rather than a column eleven characters wide that wraps into a ragged tower. */
.uses .u.long{grid-template-columns:minmax(0,1fr) auto}
.uses .u.long .n{grid-row:1;grid-column:1}
.uses .u.long .s{grid-row:1;grid-column:2}
.uses .u.long .q{grid-row:2;grid-column:1/-1;max-width:none;font-size:15px}

/* One action per line, numbered in the margin as a plain figure. A filled
   circle per line put twenty grey dots down the side of a short recipe. */
ol.parts{margin:20px 0 0;padding:0;list-style:none;counter-reset:p}
ol.parts li{counter-increment:p;position:relative;padding:0 0 0 30px;margin-bottom:14px;
  font:400 17px/1.5 ui-sans-serif,system-ui,sans-serif;color:hsl(var(--ink))}
ol.parts li:last-child{margin-bottom:0}
ol.parts li::before{content:counter(p) ".";position:absolute;left:0;top:2px;
  font:600 14px/1.5 ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums;
  color:hsl(var(--ink-faint))}
.watch{margin-top:22px;padding-top:13px;border-top:1px solid hsl(var(--line))}
.watch b{display:block;font:700 10.5px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.15em;
  text-transform:uppercase;color:hsl(var(--ink-faint));margin-bottom:7px}
.watch span{font:400 16.5px/1.5 ui-sans-serif,system-ui,sans-serif;color:hsl(var(--ink))}
.lede-why{color:hsl(var(--ink-soft));font:400 16.5px/1.5 ui-serif,Georgia,serif;
  font-style:italic;margin-top:11px}

.tech{margin-top:16px;border:1px solid hsl(var(--line));border-radius:14px;overflow:hidden;
  background:hsl(var(--card))}
.tech img{width:100%;display:block;aspect-ratio:16/10;object-fit:cover;
  background:hsl(var(--line));opacity:0;transition:opacity .35s}
.tech img.ready{opacity:1}
.tech .tb{padding:13px 15px 14px;font-family:ui-sans-serif,system-ui,sans-serif}
.tech .tt{font:700 10.5px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.15em;
  text-transform:uppercase;color:hsl(var(--ink-faint))}
.tech .tw{font-size:15px;color:hsl(var(--ink));margin-top:8px;line-height:1.45}
.tech .ts{font-size:14px;color:hsl(var(--ink-soft));margin-top:6px;line-height:1.45}
.tech .tl{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.tech .tl a{display:inline-flex;align-items:center;gap:6px;text-decoration:none;
  border:1px solid hsl(var(--line));border-radius:10px;padding:9px 12px;min-height:42px;
  font:600 13px/1 ui-sans-serif,system-ui,sans-serif;color:hsl(var(--ink))}
.tech .cr{font-size:11px;color:hsl(var(--ink-faint));margin-top:10px;line-height:1.45}
.tech .cr a{color:inherit}

.timer{display:inline-flex;align-items:center;gap:10px;margin-top:18px;
  border:1.5px solid hsl(var(--accent));background:hsl(var(--accent)/.07);border-radius:13px;
  padding:13px 18px;min-height:var(--tap);color:hsl(var(--accent));cursor:pointer;
  font:600 16px/1 ui-sans-serif,system-ui,sans-serif}
.timer .t{font-variant-numeric:tabular-nums}
.timer[data-done="1"]{border-color:hsl(var(--good));background:hsl(var(--good)/.1);color:hsl(var(--good))}

/* The camera. A label rather than a button because it wraps a file input, which
   is what opens the camera directly on a phone. */
.shoot{display:inline-flex;align-items:center;justify-content:center;gap:9px;margin-top:16px;
  border:1px dashed hsl(var(--line));border-radius:13px;padding:13px 17px;min-height:var(--tap);
  color:hsl(var(--ink-soft));cursor:pointer;width:100%;
  font:600 15px/1 ui-sans-serif,system-ui,sans-serif}
.shoot svg{width:19px;height:19px}
.shoot input{display:none}
.shoot[data-busy="1"]{opacity:.6}
.mine{margin-top:16px;border-radius:14px;overflow:hidden;border:1px solid hsl(var(--line))}
.mine img{width:100%;display:block;aspect-ratio:4/3;object-fit:cover}
.mine .cap{padding:9px 13px;font:600 11px/1 ui-sans-serif,system-ui,sans-serif;
  letter-spacing:.13em;text-transform:uppercase;color:hsl(var(--ink-faint))}

.acts{display:flex;gap:10px;margin:26px 0 8px;flex-wrap:wrap}
.btn{flex:1;min-width:150px;min-height:var(--tap);border:0;border-radius:12px;
  background:hsl(var(--ink));color:hsl(var(--bg));cursor:pointer;
  font:600 15px/1 ui-sans-serif,system-ui,sans-serif;padding:14px 16px}
.btn.alt{background:transparent;color:hsl(var(--ink));border:1px solid hsl(var(--line))}
.btn:disabled{opacity:.55}

/* Running timers sit above the navigation, readable from across the kitchen. */
.runs{position:fixed;left:0;right:0;bottom:var(--nav);z-index:55;padding:0 18px 8px;
  display:none;pointer-events:none}
.runs.on{display:block}
.runs .in{max-width:720px;margin:0 auto;display:flex;gap:8px;overflow-x:auto}
.run{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:9px 13px;border-radius:10px;
  background:hsl(var(--accent));color:hsl(var(--bg));
  font:700 13px/1 ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums}
.run.done{background:hsl(var(--good))}

nav.step{position:fixed;left:0;right:0;bottom:0;z-index:60;background:hsl(var(--card)/.98);
  backdrop-filter:blur(14px);border-top:1px solid hsl(var(--line));
  padding:10px 18px calc(10px + env(safe-area-inset-bottom))}
nav.step .in{max-width:720px;margin:0 auto;display:flex;gap:10px;align-items:center}
nav.step button{min-height:var(--tap);border-radius:12px;cursor:pointer;
  font:600 15px/1 ui-sans-serif,system-ui,sans-serif;padding:14px 18px;border:0}
nav.step .prev{background:transparent;color:hsl(var(--ink));border:1px solid hsl(var(--line));
  flex:0 0 auto;min-width:92px}
nav.step .next{background:hsl(var(--ink));color:hsl(var(--bg));flex:1}
nav.step .mic{flex:0 0 auto;width:var(--tap);padding:0;display:grid;place-items:center;
  background:hsl(var(--accent));color:hsl(var(--bg))}
nav.step .mic[data-on="1"]{animation:pulse 1.1s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
nav.step .mic svg{width:22px;height:22px}

/* Heights are dvh, not vh.
   On iOS, vh means the viewport with the URL bar HIDDEN, so a sheet anchored to
   the bottom at 92vh extends past the top of what you can actually see and its
   title and close button end up behind the browser chrome. dvh tracks the real
   visible height. vh stays as the first declaration for anything that does not
   know dvh, since being slightly too tall beats collapsing to nothing. */
.panel{position:fixed;left:0;right:0;top:57px;z-index:70;
  max-height:calc(100vh - 190px);max-height:calc(100dvh - 190px);
  overflow-y:auto;background:hsl(var(--bg));border-bottom:1px solid hsl(var(--line));
  box-shadow:0 14px 30px hsl(var(--ink)/.14)}
.panel .wrap{padding-bottom:14px}
.phead{font:700 10.5px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.16em;
  text-transform:uppercase;color:hsl(var(--ink-faint));padding:16px 0 4px}

.sheet{position:fixed;inset:0;z-index:90;display:none}
.sheet.on{display:block}
.sheet .bg{position:absolute;inset:0;background:hsl(var(--ink)/.42)}
.sheet .pane{position:absolute;left:0;right:0;bottom:0;max-height:86vh;max-height:84dvh;
  overflow-y:auto;overscroll-behavior:contain;
  background:hsl(var(--bg));border-radius:20px 20px 0 0;
  padding:8px 18px calc(20px + env(safe-area-inset-bottom))}
.sheet .grab{width:38px;height:4px;border-radius:2px;background:hsl(var(--line));margin:6px auto 12px}
.sheet h4{font:600 19px/1.25 ui-serif,Georgia,serif;margin:4px 0 12px}
.jrow{display:flex;gap:12px;align-items:baseline;width:100%;text-align:left;background:none;
  border:0;border-bottom:1px solid hsl(var(--line));padding:14px 0;cursor:pointer;
  color:hsl(var(--ink));font:400 16px/1.35 ui-sans-serif,system-ui,sans-serif;min-height:var(--tap)}
.jrow[aria-current="true"]{color:hsl(var(--accent));font-weight:700}
.jrow .jn{font:700 12px/1.4 ui-sans-serif,system-ui,sans-serif;color:hsl(var(--ink-faint));
  min-width:26px;font-variant-numeric:tabular-nums}
.jrow[aria-current="true"] .jn{color:hsl(var(--accent))}
.jrow .tick{margin-left:auto;font:700 9.5px/1 ui-sans-serif,system-ui,sans-serif;
  letter-spacing:.13em;text-transform:uppercase;color:hsl(var(--ink-faint))}

.vdock{position:fixed;left:0;right:0;bottom:var(--nav);z-index:58;background:hsl(var(--bg));
  border-top:1px solid hsl(var(--line));box-shadow:0 -12px 28px hsl(var(--ink)/.12);
  max-height:52vh;max-height:48dvh;overflow-y:auto;overscroll-behavior:contain;padding-bottom:14px}
.vtop{display:flex;align-items:center;gap:10px;padding:11px 0 4px}
.vlabel{font:700 10.5px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.15em;
  text-transform:uppercase;color:hsl(var(--accent))}
.vx{margin-left:auto;width:38px;height:38px;border:0;background:none;cursor:pointer;
  color:hsl(var(--ink-soft));display:grid;place-items:center}
/* The words appear as they are spoken. Watching the transcript build is how you
   know it heard you, and without it the wait reads as nothing happening. */
.vq{font:400 17px/1.45 ui-sans-serif,system-ui,sans-serif;color:hsl(var(--ink));min-height:1px}
.vq:empty{display:none}
.va{font:400 17px/1.55 ui-serif,Georgia,serif;color:hsl(var(--ink));margin-top:10px;
  padding-top:10px;border-top:1px solid hsl(var(--line))}
.va:empty{display:none;border:0;padding:0;margin:0}
.vtype{display:flex;gap:8px;margin-top:12px}
.vtype input{flex:1;min-width:0;border:1px solid hsl(var(--line));border-radius:12px;
  padding:13px 14px;background:hsl(var(--card));color:hsl(var(--ink));font-size:16px;
  min-height:var(--tap)}
footer{margin:36px 0 10px;padding-top:18px;border-top:1px solid hsl(var(--line));
  color:hsl(var(--ink-faint));font:400 12.5px/1.6 ui-sans-serif,system-ui,sans-serif}
`;

/**
 * Words that describe an ingredient rather than name it.
 *
 * Used when matching a step's prose back to the ingredient list: matching on
 * these would attach half the pantry to every step that says "chopped".
 */
