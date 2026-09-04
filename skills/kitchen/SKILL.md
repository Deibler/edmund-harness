---
name: kitchen
description: Per-household kitchen ledgers, meal sites, written recipes, shelf checks and standing dinner texts. Use for ANY question about food, cooking, recipes, meal planning, groceries, "what do we have", "what should I make", "text me dinner at 4", or when a grocery receipt or kitchen photo arrives — in EVERY chat, not just Alex's DM. Each household has its own isolated ledger and its own website; the chat session decides which one. Every claim about what is or is not in a kitchen must come from that household's ledger, every meal cooked or receipt received must be written back to it, and most buttons on the site settle themselves within a minute without you.
---

# The kitchen ledger

There is one source of truth for what is in a kitchen: an append-only event log
at `data/kitchen/tenants/<household>/events.jsonl`. Nothing else counts. Not a
photo from three days ago, not a memory note, not a plausible guess about what a
normal kitchen contains.

## The tools are the whole interface

Since 2026-08-16 the ledger has a real integration with typed tools. **Reach for
those first** — they validate before writing, resolve the household from the
chat session, and give you the derived features for free:

| want | tool |
|---|---|
| whose kitchen, what is expiring, what ran out | `kitchen_status` |
| inventory, or "do we have X" | `kitchen_list` |
| groceries arrived / a meal got cooked / a correction | `kitchen_record` |
| retract a bad write | `kitchen_undo` |
| check a recipe against real stock before writing it | `kitchen_plan` |
| they cooked it (or did not) | `kitchen_plan_resolve` |
| read a recipe already written out | `kitchen_recipe_get` |
| save one you just wrote | `kitchen_recipe_save` |
| everything written for this house | `kitchen_cookbook` |
| reconcile against the actual shelves, incl. photos | `kitchen_check` |
| "text us dinner at 4 every day" | `kitchen_schedule` |
| taps on the site that are waiting for a person | `kitchen_requests` |
| answer a question asked ON the site | `kitchen_chat` |
| a favourite or a note that came from the site | `kitchen_mark` |
| recap, calories, spend, cooking rhythm | `kitchen_insights` |
| shopping list priced across stores | `kitchen_deals` |
| load prices you just fetched | `kitchen_prices_import` |
| households, members, budget, diet, stores | `kitchen_accounts` |
| **why is this not working** | `kitchen_accounts action:"check"` |
| render that household's own website | `kitchen_site` |

There is no second way in. A Python CLI implemented the same ledger until
2026-08-17 and was deleted: every rule existed twice and the two could drift.
`kitchen_insights view:"log"` is how you read the raw event log now.

### The one thing to internalise before touching any of it

This kitchen has three ways of doing work and they are not interchangeable:

1. **Arithmetic over the ledger**, which the tools do. Instant, always right.
2. **A launchd pass every minute** (`scripts/watch.ts`), which settles every
   button on the website that does not need a person, refreshes the weather, and
   fires the standing dinner texts. Nobody waits on you for any of it.
3. **You**, for the things that are actually writing: a recipe, a variant, an
   answer to a question.

Most of what looks like work here is already category 1 or 2. Doing it by hand
duplicates it — and the failure mode is not a wasted turn, it is a person's
dinner consumed twice or the same recipe texted to them twice. Before acting on
anything that came off the website, read *What settles itself* below.

**Why this exists.** On 2026-08-09 I made four separate false claims in one
evening about things Alex "did not have" — cooking oil, a spice range, frozen
vegetables, an onion — every one of them inferred from the absence of an item in
a photo. A photo is a sample, not an audit. The ledger is the audit, and when the
ledger does not know something the honest answer is "not tracked", never "you do
not have it".

## One ledger per household

A **household** is one kitchen's worth of food and the people who share it. It
is the unit of isolation, because it is the thing being modelled: Alex and
Sam share a fridge so they share a ledger, Jordan buys his own food so he has
his own.

You never pass a household id in normal use. Every tool resolves the chat
session you are running in through the member list in
`data/kitchen/tenants.json`. Each household's events live in their own
file, so there is no query that spans two of them and nothing to remember to
scope.

The `account` argument **disambiguates among kitchens this session belongs to.
It is not a way to reach into someone else's.** Naming a household you are not a
member of is refused. If you genuinely need to cross that line — a migration, an
operator debugging session — set `KITCHEN_ADMIN=1` explicitly, and mean it.

    kitchen_status                        # which household this session resolves to
    kitchen_accounts action:"list"        # every household, members, event counts

**Isolation is the point.** Before 2026-08-16 there was one shared log and
Jordan's food was marked only by having "Jordan's" typed into item names. A
convention is not a boundary — it is one typo from a shared shelf, and it made
"what do we need from the store" mix three people's groceries together. Do not
reintroduce it by prefixing item names with a person. The household boundary
carries that now.

**Within a household, every chat still shares.** Alex's DM, Sam's DM and
their group all resolve to `broderick`. If Sam bakes in her thread, that flour
comes off the same shelf Alex's dinner plan reads from. When a meal is planned
in one chat and cooked in another, the `why` field is where you say which meal it
was, so the log stays readable later.

## When a session has no household

Every tool refuses and says who is asking. **This is correct behaviour, not a
bug to route around.** There is deliberately no default household — quietly
reading Alex's fridge for someone who lives in another state is worse than
failing. There is also no override for this short of `KITCHEN_ADMIN=1`.

Two recoveries, and which one is right is a question for the human, not a guess:

    kitchen_accounts action:"join"   account:"<id>"   # they share an existing kitchen
    kitchen_onboard  action:"check"                   # they might want their own

Anyone can have a ledger. A principal belongs to at most one household; every
write path refuses a second.

## Onboarding somebody who does not have a kitchen yet

Most people arrive at this sideways. They ask what to make with chicken, then a
week later what goes with rice, and every one of those answers comes out of
nothing because there is no ledger behind it. The second or third time is the
moment to offer, and the offer is the point of this section: **do not set
anything up for somebody who has not said yes.** A household that exists with
nothing on its shelves is worse than none at all, because now every reply is
hedged against a ledger that knows nothing and they have learned this does not
work.

    kitchen_onboard action:"check"     # should I offer? what is missing? never throws
    kitchen_onboard action:"start"     # provisions the whole thing, only after a yes
    kitchen_onboard action:"stock"     # their photos -> proposed items
    kitchen_onboard action:"accept"    # the confirmed ones, as one undoable batch

**Ask for two things and nothing else: who eats there, and photographs.** Those
are the only two facts no amount of cleverness recovers. When they eat, what
they spend, how often they cook, what they like, how many people to cook for —
every one of those is a fold over the log the moment there is a log, and asking
up front trades a stranger's patience for an answer worse than the one the
system would have worked out by itself. The optional arguments on `start` are
for catching what somebody volunteers three messages later, never a form to walk
them through. This is the same rule as everywhere else here: nothing may require
a setup step to work.

The offer, roughly, in your own words: you have been asking me what to cook and
I can keep answering from nothing, or I can track what is actually in your
kitchen and answer from that — what is genuinely cookable tonight, what is about
to turn, what you are spending. Setup is two photos and one question.

Then, in order: `start` with an id and their name, ask for a photo of the fridge
and one of a cupboard, `stock` those, show them the list and drop whatever is
wrong before `accept`, then `kitchen_site` and share the link with
`instant-share` and record the url. `check` after each step tells you what is
still missing; it derives that from the actual ledger rather than a stored flag,
so it cannot tell you something is done when it is not.

## The two hard rules

1. **Read before you claim.** Before recommending a meal, writing a recipe page,
   answering "do we have X", or building a shopping list, call `kitchen_status`
   (or `kitchen_list` for one item). Never answer from conversation memory.
2. **Write after it changes.** A receipt arrives, food gets cooked, something
   spoils, a photo shows something new: log it in the same turn. An unlogged
   change silently rots the ledger for every future turn.

## Reading the raw log

`kitchen_insights view:"log"` prints the ledger newest first, with the batch id,
the operation, the item, the quantity and the reason. Retracted batches are
shown and marked rather than hidden, because the usual reason to open a log is
to find out what was taken back. `limit` defaults to 25.

That is the only raw view, and it is read-only on purpose. Everything that
writes goes through `kitchen_record` (add, use, cook, set, toss, a whole
receipt) or `kitchen_undo` (retract a batch), both of which validate the shape
before anything touches an append-only file.

`kitchen_record` takes a whole meal as one batch, which is what makes `undo` a
single honest operation: a wrong guess about portions in a six-ingredient dinner
is one retraction rather than six.

## Writing a recipe (the required loop)

A recipe is not prose composed and then checked afterwards. It is built from the
ledger, and it is not finished until somebody has confirmed the food got made.
None of these steps is optional and the order matters.

**0. Look for it first.** `kitchen_recipe_get`. A recipe written once is kept
forever, and rewriting one spends a model call on an answer already sitting on
disk — and produces a second, slightly different version of the same dish.

**1. Read the shelves.** `kitchen_status`, then `kitchen_list` for anything
specific. The meal is chosen from what is actually there and what has a clock on
it, never from what would be nice.

**2. Plan it against the ledger, before writing a single line.**

```
kitchen_plan meal:"baked tortellini" lines:[{item:"tortellini",qty:1}, ...] when:"Monday dinner"
```

`kitchen_plan` resolves every ingredient, refuses on anything the kitchen does
not have or does not have enough of, and hands back a plan id. That refusal is
the whole point: it is what stops "add a cup of flour" being written for a house
with no flour. If something really is missing, change the recipe or say it is a
shopping item. Do not force it unless a human has confirmed the thing exists and
you are correcting the ledger.

**3. Write it with `kitchen_recipe_save`**, from the plan's numbers, so the page
and the ledger say the same thing. Then `kitchen_site` to render it. The page
carries its own "We made it" button, which the launchd drain settles — no
trigger, no reminder, no plan id to thread through a template.

**4. Ask, once, later.** Sending a recipe is not evidence anybody cooked it.
`schedule_reminder` a couple of hours after the meal, and check
`kitchen_status` first so you never ask about something already confirmed:

> Confirm the "baked tortellini" plan (id 5797a4). Ask whether it got made.
> Yes: `kitchen_plan_resolve` made. No: resolve it as not made, consume nothing.
> Made with changes: confirm, then correct the changed items.

Ask in one line and act on the answer. An open plan more than a day old means
nobody asked. The site shows open plans on the home page so an unanswered one is
visible rather than quietly rotting.

`templates/made_button.html` still exists for one-off pages served outside the
site. Inside the site it is redundant; use the recipe page.

## Receipts

When a receipt photo arrives, transcribe it properly and completely.

- Rotate it upright first (`sips -r 90 copy.jpeg`) and read the full-resolution
  file, not the thumbnail. Giant receipts print the list price, then discounts,
  then `PRICE YOU PAY` — the last one is what the item actually cost.
- **Check your transcription against `TOTAL NUMBER OF ITEMS SOLD` at the bottom.**
  Multi-buys (`4 @ 0.60`) count as four. If your count does not match, you missed
  a line, and a missed line becomes an invisible hole in the ledger.
- **`price` is what the LINE cost, never a per-unit rate.** A receipt prices the
  package while `qty` counts the stocking unit, so a $1.46 dozen logged as
  `qty 12` still has `price 1.46`, and grapes at $1.29/lb weighing 2.17 lb have
  `price 2.80`. Never divide a package price by what is inside it. On 2026-08-16
  a $1.29/lb rate and a `p * qty` in `insights.spend` turned a real $49.81 Aldi trip
  into $88.99 on the site. Line totals must sum to the printed total, which is
  the only way a transcription can be checked at all. Unit prices for comparing
  stores are a separate thing and live in the price book
  (`kitchen_prices_import`, which takes the size explicitly).
- Expand the abbreviations, keep the raw receipt token in `why` so the line can
  be audited later, and say so in `why` when a name is a guess.
- Set `expires` only where the clock genuinely matters (meat, deli, dairy,
  mushrooms, greens, bread) and mark estimated dates as estimated.
- Build a JSON array and load it in one batch with
  `kitchen_record` with `source: "receipt:<store>-<date>"`.

## Lookups are strict on purpose

`kitchen_list` with a `query` answers yes only when something in the ledger is
actually called that — its name, its id, or an alias. A loose hit is reported as
a loose hit:

```
kitchen_list query:"egg"
not tracked — nothing is called "egg". The ledger does have "Wide egg noodles",
which is not the same thing.
```

Anything that mutates the ledger (`use`, `cook`, `plan`, `toss`) refuses loose
matches outright rather than picking the single near hit, because silently
decrementing egg noodles when someone said eggs corrupts the file in a way nobody
would ever notice. When a shorthand you use often keeps missing, the fix is
`kitchen_record` with `aliases` on the real item, not a fuzzier matcher.

And read the wording: **"not tracked" is not "you do not have it."** It means
nobody has ever logged it. Ask, then log the answer.

## The shopping list

Use `kitchen_shopping`, not `kitchen_status`, whenever the question is what to
BUY. They answer different questions and conflating them is what made the list
unusable the first time: "out of X" is a fact about the kitchen, "buy X" is a
decision, and only some facts become decisions.

Three groups, and a line only ever gets on the list by belonging to one:

- **For a meal you planned.** An open plan's gaps. Leaves on its own when the
  meal is cooked or called off.
- **Out of something you keep.** Ran out or a shelf check said low, AND the
  household has confirmed it is worth rebuying.
- **You added these.** Somebody typed it. Never second-guessed, never dropped
  for being redundant.

Everything else is a **suggestion** and lives in a tray that is visibly not the
list. Two things land there:

- Something ran out that has never been confirmed as worth rebuying. Ask once,
  record the answer with `answer:{item, as:"always"|"never"}`, and it is never
  asked again. This is the whole reason the list stays clean: the system does
  not guess whether the imitation crab legs bought once for one sushi bake
  should come back forever, it asks at the moment the answer is obvious.
- Something that would open up dinners. Capped at six and re-decided every time,
  because "buy this and three meals open up" is a fresh call each trip, not a
  standing preference.

**Meat and seafood never auto-add.** Which protein this week is the purchase
people most want to make themselves, so it is always suggested. If somebody says
they always want chicken thighs in the freezer, record it with `as:"always"` and
that item starts listing itself.

Three ways to take something off, and they are genuinely different:

| They said | Do | Because |
|---|---|---|
| "I already have that" | `kitchen_record` an `add`, or the site's restock | The ledger is wrong. Fix the ledger. |
| "not this trip" | `answer:{as:"skip"}` | About today. Expires at the next receipt. |
| "we do not buy that" | `answer:{as:"never"}` | About the household. Permanent. |

Collapsing these into one delete teaches the wrong lesson two times out of three.

**A list nobody ticked still settles.** People shop from their own list and
never open the page. So a receipt logged through `kitchen_record` clears written
lines it satisfied and expires skips, and ticking things off on the site logs
them back onto the shelves with no quantity (presence is what a tick knows;
quantity waits for the receipt). Never leave a list showing things that came
home two days ago.

**Apple Notes.** The household's note is kept equal to the list on its own. The
watch pass checks every ten seconds whether the generated block has changed —
that check is a pure fold and opens nothing — and only when it has does it drive
a browser and rewrite the note. `kitchen_shopping notes:true` forces the same
sync now; you rarely need it.

**The lines are real tappable checkboxes**, so the note can be shopped from
rather than read. Ticks belong to whoever made them: every sync reads the note
first and puts each tick back exactly where it was, and NOTHING here concludes
from a tick that the food is now owned. A tick means "in the cart"; the receipt
is what says what was bought. `settleAfterPurchase` is still what clears them.

**Sharing.** `kitchen_shopping share:true` invites everyone in the household, in
the same browser session that writes the note. Add `shareWith:["…"]` for anybody
outside it; each has to be an Apple Account or the invite will not stick. The
FIRST share of a household is always explicit — writing into a note in this
account's own iCloud has no outward effect, but sending somebody an invite does,
so it is never done on a schedule. After that, members are kept in step
automatically.

Content and sharing both go through icloud.com, because nothing local can do
either job. AppleScript cannot invite (the sdef's `shared` is read only,
`NSSharingService` does nothing for Notes, and the share sheet is hosted by
ShareSheetUI, which exposes no accessibility children) and it silently strips
every checklist markup, so a note written that way can never be ticked. Both
measured, not assumed. A link is not a substitute for an invite either, because
access is gated on the invite list rather than on the link.

So `src/icloud.ts` drives that page over the DevTools protocol against a Chrome
profile at `data/kitchen/chrome-profile` that stays signed in. If that session
lapses the tool says so and asks for a human to sign in; there is no password in
the repo and there must never be one.

**The note body is a canvas.** There is no DOM to read or set — the editor
paints text — so the only ways in are the keyboard and the clipboard. Apple's
own clipboard flavour carries paragraph styling as JSON in `data-tt`, checklists
and their `todo.done` included, so one copy reads the whole note with its ticks
and one paste rewrites it. `src/notedoc.ts` owns that format and is pure, which
is why the parts that can lose somebody's list are unit tested.

Three rules in that path exist because breaking them did real damage:

- **The page must believe it has focus.** The canvas editor ignores every key
  and paste when `document.hasFocus()` is false, which is always true of a
  background tab. `Emulation.setFocusEmulationEnabled` fixes it without taking
  focus from whoever is using the Mac.
- **A failed read must never look like an empty note.** A click that misses the
  editor leaves focus on the page body, where select-all selects the whole app
  and copy returns the sidebar. That happened, and the app's own chrome was
  parsed as a line of somebody's shopping. `readBody` now proves the caret is in
  the editor, checks the result carries Apple's styling, and returns null
  otherwise; a null read never writes.
- **Never write through both transports.** AppleScript used to be the fallback.
  The local Notes app is a REPLICA that lags iCloud by minutes, so writing
  through it while the browser owned the note meant two replicas diverged and
  iCloud kept both — the note came back holding the list twice, once as
  checkboxes and once as dashes. A failed sync now leaves the note alone and
  says so.

`note_url` and `note_link` are recorded on the account, and every later run
navigates straight to the note instead of searching for its title. That is not
an optimisation. The note list is virtualised and recycles its DOM nodes, so
off-screen leftovers keep stale titles and a click on one selects a different
note — which is exactly how a run once read a throwaway note's participants as
this household's. Title search now only accepts rows the app marks `on-screen`
and then waits for the row to actually become selected. `note_link` is also the
thing to text somebody: it opens the note directly for anyone already invited.

**Who is already on the note is remembered by handle, not by label.** iCloud
shows the handle you invited until the person accepts and their contact name
afterwards, so "Alex Example" cannot be compared to "+15550100001" — without
`invitedHandles` in `notes.json` the sync re-invites everybody who ever accepted,
every time the list changes.

## Quantities

Count what is countable, and refuse to invent the rest. An item can carry
`--qty 4 --unit ct`, or it can carry `--level full|low|out` with no number at
all. Spices, oils, flour, condiments belong in the second group. "Roughly
0.7 jars of paprika" is a lie with a decimal point on it.

## The site

One site per household, one call: `kitchen_site`. It writes the hub, a page for
every written recipe, the shelf-check page and the chat threads the hub polls,
all into the household's artifact directory. There is no separate inventory
page, no separate meal hub, and no per-recipe artifact any more.

Panels: **Home** (what to cook, ordered by the day), **Kitchen** (what is on the
shelves), **Explore** (food this house does not make), **History**, **Shopping**,
**Schedule** (standing texts), **Recap**.

Three rules that have each cost something:

- **Re-render into the SAME artifact directory** to update a live link. Minting
  a new tunnel invalidates the link people already have.
- **A rendered page belongs to exactly one household.** Never point two at one
  directory, or you publish someone else's fridge behind a link they hold.
- **Rendered is not served.** A perfectly correct site in a directory no server
  has ever served looks identical, from every log line, to a working one. That
  is what happened to Jordan's household for a week. `kitchen_accounts
  action:"check"` is the thing that says so out loud; run it whenever somebody
  reports that something "is not working".

Once a site is served, record the URL (`kitchen_site url:...`) and arm a trigger
on its `/callbacks` endpoint, or nothing anyone presses will ever reach a person.
See *Requests waiting on you*.

## What settles itself, and what waits for you

`src/drain.ts` splits every tap on the site by whether the answer needs
judgement. The launchd pass runs it every minute.

**Settled without anybody** — confirming or calling off a meal, "we made it" from
a recipe page, starring, notes, ticking the shopping list, undoing an automatic
cleanup, every swipe of a shelf check, correcting the ledger from a card, saving
preferences and the vibe, generating a set of explore ideas, putting a dish's
shopping on the list, answering a question asked out loud mid-recipe, filing an
uploaded photo, and creating or pausing a standing text.

**Left for you** — writing a recipe (`make`), building a variant around what the
house has (`variant`), writing an explore idea out properly (`idearecipe`), and
questions asked in the page's chat (`chat`).

Two consequences worth stating plainly:

- **Never hand-apply something in the first list.** It has already been done or
  is about to be, within the minute. Re-applying a `plan` confirmation consumes
  a dinner's ingredients twice.
- **Every button that spends a model call says so on screen** and tells the
  person where the answer will appear: "I will text you when it is ready" for
  anything you write, "this lands on the page itself" for anything the site
  settles. If you add a button, add that line. Alex asked for it explicitly on
  2026-08-16.

## Standing dinner texts

`src/schedules.ts`, surfaced as the **Schedule** panel and `kitchen_schedule`.
"Text Sam and me at four every day and tell us what we are having."

The whole design follows from one property: the text has to ARRIVE. So the pick
is arithmetic — the same ranking the home page runs, over what the shelves can
actually cook — and the launchd pass sends it. No model is in the delivery path.
A model is still wanted for the good part: if the chosen dish has never been
written out, firing also drops the exact request a "Make this" tap produces into
the callback queue, which wakes you, and the written page follows the text.

```
kitchen_schedule action:"set" at:"16:00" days:[1,2,3,4,5] to:[...] meal:"dinner"
kitchen_schedule action:"preview"     # exactly what would be sent right now, sends nothing
kitchen_schedule action:"list" | "pause" | "resume" | "remove"
```

Times are 24-hour `HH:MM` local; days are 0=Sunday..6=Saturday and an empty list
means every day; omit `to` for everyone who eats there. **A schedule can only
text members of its own household** — that is enforced in `normalize`, on every
write path, because `to` arrives from a public endpoint and ends in a message to
a real phone.

Four behaviours to know before explaining it to anyone:

1. **Once a day, inside a 75-minute grace window.** The pass runs every minute;
   without a hard "already fired today" check it would send seventy-five dinners.
2. **A missed window is skipped, never fired late.** A Mac asleep at four and
   awake at nine stays quiet. A text at nine about a four o'clock dinner is
   worse than no text.
3. **Firing consumes nothing and opens no plan.** Being told what to cook is not
   evidence anybody cooked it. The food comes off the shelves when a human
   presses "We made it".
4. **It never promises a page it cannot deliver.** The written recipe reaches
   you through the site's callback log, which nothing polls unless the site is
   served, so a household with no public URL is simply not told one is coming.

When somebody asks for this in a chat, set it and say in one line that it is
live and needs nothing else from them.

## Requests waiting on you

A tap that needs writing sits in the artifact's `_callbacks.jsonl` until served.
Two things have to be true for it to reach you, and both are checkable:

1. The household's site is served and its URL is recorded on the account.
2. A trigger is armed on `<tunnel>/callbacks?key=<key>&cb=<callback_token>`,
   where `callback_token` is the second secret in the artifact's `artifact.json`
   and is deliberately not in the page. Dedupe in `state` on
   `ts|kind|recipe|client_ts`; fire only on the kinds in the "left for you" list
   above, or you will wake for every shelf swipe.

On firing: `kitchen_requests` to read them, `kitchen_recipe_get` BEFORE writing
anything (a recipe written once is kept forever), then `kitchen_recipe_save`,
then `kitchen_site` to re-render, then text whoever is in `users`. Mark served
with `kitchen_requests handled:[...]` **only after it has actually gone out** —
a request served twice is the same recipe texted to a person twice.

Answer `chat` requests with `kitchen_chat`, which publishes to a file the page
polls. That is a reply on the website, not a text message; do not send both.

## When something is not working

`kitchen_accounts action:"check"` — every household when you do not name one.
It reports three levels and the distinction is the point:

- **BROKEN** — something claims to work and does not. A site with no URL, a
  schedule texting somebody who moved out, a written recipe with no page on
  disk, a principal in two households.
- **absent** — a real, valid state that costs a feature. No coordinates so no
  weather, an empty shopping list, no standing texts. **Never describe these as
  errors.**
- **ok** — checked and true.

Everything in this integration degrades quietly on purpose, which is right for
whoever is reading the page and wrong for whoever set it up. This is the one
place the quiet is made loud. The daily pass prints BROKEN lines too.

## The recipe page: what "easy to follow" means here

Set by Alex on 2026-08-16, after the first version shipped as one long scroll.
The rule under all of it: **a person cooking should never have to think about
anything except the food.** Every deviation from that is a bug, not a preference.

Owned by `integrations/kitchen/src/recipepage.ts`, written to
`<artifact>/recipe/<id>.html` by `writeSite`.

0. **Ruled, not decorated. NO LEFT ACCENT BARS.** Alex has rejected coloured
   left-border accents on this project twice, 2026-08-09 and 2026-08-16. Use a
   hairline rule and a small-caps label to carry structure; that reads typeset,
   a coloured bar reads as a framework component dropped on the page. Colour is
   reserved for things that are live right now: a running timer, the progress
   bar, the mic, the step you are on. Figures are tabular.

0b. **A step is never a paragraph.** Title, one sentence on why, then `parts`:
   an ordered list of single actions carrying ALL the detail, then `watch`: how
   you know it is done. Same words as the old paragraph, one action per line, so
   a glance back at the phone lands somewhere. Detail is never cut to make it
   short; it is spread out.

1. **One step per screen, by default.** Next advances, Back reverses, the
   position lives in the URL hash so a phone that locked mid-recipe reopens on
   the step it was on. Anything that makes somebody find their place again is
   the thing that loses them.

1b. **But both ways exist.** Sam asked on 2026-08-16 for the whole method as
   one list, and she is right: stepping is the cooking posture, and it is the
   wrong shape for reading a recipe through, deciding whether to make it, or
   cooking from a laptop you are not going to keep tapping. The View button in
   the header offers both; the choice is a cookie, so it follows the person
   across every recipe on their own device. In list mode the step navigation and
   the per-step cameras go away, because there is nothing left to navigate and
   nine identical camera buttons down a page is clutter. The microphone stays.

2. **Every step lists its own ingredients**, with the amount for THAT step, and
   live stock beside each. The shopping amount and the in-the-pan amount are
   different numbers; a page with only the first makes people do the division at
   the stove.

   **Fill `uses` on every step. This is not optional.** The page can infer which
   ingredients a step names, but it cannot invent an amount, so it falls back to
   the whole-dish amount — and that is written for a shopping list, not a pan.
   Saving the Old Bay shrimp bowls with no `uses` anywhere put "2 teaspoons on
   the shrimp, plus a pinch for the corn" on the step that blisters the corn,
   which is both wrong for the step and long enough to break the row. The step
   that blisters the corn wants "a pinch". `kitchen_recipe_save` tells you how
   many steps came back without their own `uses`; if that number is not zero,
   you are not finished.

3. **Every step is exhaustive.** No step may assume knowledge. How big to cut,
   what the pan should look and sound like, how to know it is done, which pan.
   Times are cues plus a timer, never times alone.

4. **Technique visuals are real, never generated.** Real photographs from
   Wikimedia Commons with credit and licence rendered on the panel, real chefs on
   video, plus a written reference. Alex rejected drawn SVGs outright on
   2026-08-13. `src/techniques.ts` holds the table; `scripts/fetch_techniques.ts`
   downloads the images into the artifact so nothing hotlinks. **Verify any video
   id against `youtube.com/oembed` before adding it** — a dead link that looks
   plausible is worse than no link.

5. **Timers on the step, running across steps.** Deadline-based, so a sleeping
   phone comes back with the time actually elapsed.

6. **The button is a microphone, not a chat box.** Speech in is the browser's own
   recogniser; speech out is generated in my voice (`src/voice.ts`) with the
   browser's synthesiser as the fallback. Questions mid-recipe arrive when hands
   are wet. Typing stays as a fallback for browsers that will not listen.

7. **No two-cook mode.** Retired 2026-08-16. It made every step ask "is this
   mine" before "what do I do", which is a question about the interface.

8. **Every button that invokes a model gets a confirm sheet.** Make, variant,
   add to list: name the action, say exactly what will happen, and let it be
   dismissed without firing. A "tap again to confirm" label on the button itself
   is not enough, because it still looks like a button and people tap through
   it. Deterministic buttons (logging a meal, undoing a cleanup, ticking the
   list) stay one tap on purpose: reversing a guess must never cost more effort
   than the guess did.

**Photographs of the real thing beat generated ones.** The last card of every
recipe, and every step, has a camera. A picture of the actual plate replaces the
generated hero everywhere on the site; the generated one is MOVED to
`img/meals-generated/` rather than overwritten, because generated is recoverable
and "the night we cooked it" is not. Uploads go to the share server's `/upload`
endpoint as raw bytes, land in `img/upload/`, and the drain decides where they
belong.

## The shelf check

The ledger drifts. That is the steady state, not a bug: people finish the milk,
greens turn, half a packet goes out during a clean-up nobody narrates. So there
has to be a way to LOOK, and `kitchen_check` is it. Three ways in, one pass:

| they did this | call |
|---|---|
| sent photos of a fridge, cabinet, drawer | `action:"photos"`, `files:[...]`, `by` |
| said "the counts are off" / asked to check | `action:"start"`, `by` |
| answered some of your questions | `action:"answer"` |
| finished | `action:"apply"` |

**Nothing reaches the ledger until `apply`**, and a photo NEVER applies itself. A
photograph is evidence, not testimony: half a fridge is behind the milk and a
closed drawer is not an empty drawer. The read comes back as PROPOSALS to
confirm. This is the same rule as [[the absence rule]] above and the one I have
broken before.

**Always pass `by`.** Three people share the household kitchen. "The ledger says
four onions" and "Jordan counted four onions on Sunday" are different facts and
only the second is worth keeping. Every verdict is stamped with its principal
and the kitchen page says who last looked.

**A confirmation is a write, not a no-op.** Swiping right re-stamps the item's
`updated`, which is exactly what the decay engine reads as "a human saw this".
Without it a check would leave the kitchen looking staler than before.

The deck is scored, not sorted by age (`scoreShelf` in `reconcile.ts`):

- **Hazard** = days idle over how long that thing actually lasts in THIS house,
  learned from the log where there are two or more completed spans, category
  default otherwise. Past 1.0 it is more likely gone than not.
- **Debt** = days since a human actually LOOKED (a `src:"reconcile"` event, not
  `updated`, which moves for receipts and meals too). Uncapped, so even a jar of
  paprika eventually surfaces.
- **Value** = being wrong about chicken costs a dinner, being wrong about
  oregano costs nothing.

Anything confirmed in the last 6 days is excluded outright, so a finished pass
genuinely clears. 24 a pass, of which a quarter is reserved for whatever has
gone longest without being looked at, which is what makes the whole kitchen get
covered rather than the fridge being checked weekly forever. Same order drives
`<artifact>/check.html`.

## Compound meals, the two-night rule

1. **A pair is exactly two meals deep.** The leftovers of a dish that was itself
   made from leftovers are days old by the time they exist. `compoundPairs`
   refuses any pair whose parent has its own `from`.

2. **Second-night dishes do not appear in the meal grid.** They are not a dinner
   anyone can choose; they are what a different dinner becomes. They live on
   their parent's card, behind the recycle badge, and the parent's card says
   "Then tomorrow: X". The exception is when the leftover is genuinely in the
   fridge, at which point it IS tonight's dinner and shows normally.

3. **Confirming the first meal writes its `yields` into the ledger** as real
   leftover containers, so the second night becomes cookable from actual stock
   rather than from a promise. The decay engine retires them after four days,
   which is what stops them piling up.

4. **Either half can be declined**, from the same sheet, reversibly: "not doing
   the second one" after cooking the first, or "just make this one" / "buy for
   this one instead" when you want the second without the first. A pairing is a
   suggestion, not a contract. Skips expire after fourteen days.

## The day, and why the page changes

Set by Alex on 2026-08-16: the home page must "feel alive and changing and
growing and experiencing the seasons with you, it should never get boring or
feel like the same vibe week after week." A correct list that never changes is
a list people stop opening, and by then being correct has bought nothing.

`integrations/kitchen/src/mood.ts` reads the day before anything is ranked.
Four signals, in descending order of how sure it can be:

1. **The calendar is arithmetic.** Month, weekday, weekend, the nearest holiday
   inside its own lead window, whether football is on. Thanksgiving is a rule
   (fourth Thursday), Easter is the computus, the Super Bowl is the second
   Sunday in February. None of it can be wrong and none of it needs a network.
2. **The weather is fetched and cached** (NWS, from the household's `place`
   coordinates; refreshed by the drain, stale after 12 hours). **Its absence is
   a first-class state.** With no reading the page says nothing about weather.
   Never invent a seasonal average.
3. **A pinned vibe beats both.** Somebody saying "this week we are meal
   prepping" knows something the calendar does not.
4. **The ledger decides what is cookable,** which happens downstream.

**The mood RANKS and never FILTERS.** A mood that hides food is a mood that gets
switched off the first time it hides the thing you wanted. Cookability outranks
every mood term, so at its most opinionated it reorders dinners you could
already have made.

Recipe fields that feed it, all optional, all on `Recipe`:

| field | what it is |
|---|---|
| `effort` | `quick` / `weeknight` / `project` / `allday`. How much of your day it wants, which is NOT the clock: a braise you walk away from is a weeknight, a risotto you stand over is not. Falls back to minutes. |
| `method` | `crockpot`, `oven`, `grill`, `nocook`… `crockpot` is the one that changes the day. |
| `feeds_days` | Days one batch keeps FEEDING you. Not the same as keeping: a tray of cookies lasts four days and is not four dinners, which is why `feedsAllWeek` is gated on the dish being a real meal. |
| `season` | Months 1-12, or absent. Stated per dish, never derived from ingredients: strawberries are a June crop and a year-round supermarket item. |
| `occasions` | `weekend`, `sunday`, `gameday`, `holiday`, `cookout`, `cozy`, `hotday`, `party`. Empty is the right answer for most weeknight dinners. |
| `spend` | 1 cheap, 2 ordinary, 3 blowout. Ranked against the household's mode. |
| `cuisine` | One word. Used to measure distance from the usual. |

Household preferences live on the account (`prefs.vibe`, `prefs.mode`,
`prefs.per_meal`, `prefs.avoid_methods`, plus `budget`) and every one of them is
an OVERRIDE of something the day would otherwise decide. Nothing may require an
answer; the page has to be complete for somebody who never opens settings.

## Explore: food this house does not make

`explore.ts`. The deliberate exception to the ledger anchor: dishes generated
for DISTANCE from the household's own catalog, so a kitchen that only ever
proposes what it already knows stops being the endpoint. Nothing here is checked
against stock, because checking it against stock is exactly what drags it back
to the same eight dinners.

The honesty rule moves rather than bends. These are labelled as ideas you would
have to shop for, never as things you can make, and nothing here can write to
the ledger. Two hard rules learned the first time it ran: everything the house
owns goes into the prompt (not just pantry staples, or it tells you to buy the
chicken in your own fridge), and anything on the shopping line that matches a
live item is moved to "already in the house" deterministically afterwards,
because asking nicely is not a guarantee.

## Households that are one person

Jordan's is. Everything works, but a few things behave differently and it is
worth knowing which, because a bug here is invisible from the two-person side:

- The site skips the "who should get this" picker entirely and signs that person
  in automatically. A single-person household never has to pick a profile.
- `eaterCount` counts messageable people, never group chats. A household whose
  only member is a group chat has nobody to text and reports as BROKEN.
- Per-person figures (calories, spend) are divided by that count, so binding a
  group chat to a household used to quietly divide everything by three.
- The household title falls back to the account name when nobody is named.
- Explore repeats itself more, because distance is measured from a small
  catalog. Give it a theme rather than "surprise me".
- A standing text with no recipients means "everybody", which for one person is
  that person.

## Talking about it

Report what the ledger says, not a vibe. "You have four yellow onions and five
bulbs of garlic" beats "you should have onions". When something genuinely is not
tracked, say it is not tracked and offer to add it, rather than converting silence
into a negative claim.

Same rule for the machinery. "The site is rendered but has never been served" is
a real answer; "it should be working" is not. If somebody says a button did
nothing, run `kitchen_accounts action:"check"` before theorising.

House style, since these end up in front of people: no emoji anywhere in any of
it, no em-dashes in copy, and anything inferred rather than measured is labelled
inline rather than in a footnote nobody reads.
