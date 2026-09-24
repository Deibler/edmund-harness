---
name: kitchen
description: Per-household kitchen ledgers, meal sites, written recipes, shelf checks and standing dinner texts. Use for ANY question about food, cooking, recipes, meal planning, groceries, "what do we have", "what should I make", "text me dinner at 4", or when a grocery receipt or kitchen photo arrives — in EVERY chat, not just Alex's DM. Each household has its own isolated ledger and its own website; the chat session decides which one. Every claim about what is or is not in a kitchen must come from that household's ledger, every meal cooked or receipt received must be written back to it, and most buttons on the site settle themselves within a minute without you.
---

# The kitchen

Each household's kitchen is an append-only event log at
`data/kitchen/tenants/<household>/events.jsonl`. It is the only source of truth
for what is in a kitchen. A photo from three days ago, a memory note or a guess
about what a normal kitchen holds does not count.

The typed `kitchen_*` tools are the only way in. They validate before writing,
resolve the household from the chat session, and derive everything else (spend,
calories, the site, the list) from the log.

Work happens in three places, and they are not interchangeable:

1. **Arithmetic over the ledger**, done by the tools. Instant and always right.
2. **The watch pass** (`scripts/watch.ts`, every minute under launchd). It
   settles every site button that does not need a person, refreshes the
   weather, sends standing dinner texts, sends meal follow-ups, and wakes you
   for everything else.
3. **You**, for judgement: a recipe, a variant, an answer to a question, the
   morning inventory review, the follow-up after a meal. It arrives as a
   one-shot event in the main session of the person it concerns. There is no
   kitchen sub-agent and no second model.

Most of what looks like work is already 1 or 2. Doing it by hand duplicates it,
and the cost is a dinner consumed twice or a recipe texted twice.

## The hard rules

1. **Read before you claim.** Before recommending a meal, writing a recipe,
   answering "do we have X" or building a list, call `kitchen_status` (or
   `kitchen_list` for one item). Never answer from conversation memory.
2. **Write after it changes.** A receipt, a cooked meal, something spoiled, a
   photo showing something new: log it in the same turn.
3. **"Not tracked" is not "you do not have it."** It means nobody logged it.
   Ask, then log the answer. A photo is a sample, not an audit: never conclude
   an item is absent because it is not in a picture.
4. **Never hand-apply what the site settles itself** (see *What settles
   itself*). Re-applying a meal confirmation consumes its ingredients twice.
5. **Never delegate kitchen judgement.** Your main session carries the
   household's taste, history and context; that is why the work comes to it.
6. **Never force a plan** unless a human has confirmed the item exists and you
   are correcting the ledger.

## Knowing what is really in the kitchen

Households send receipts and little else. Nobody logs finishing the onions,
freezing the chicken or binning the grapes, so the ledger drifts from the real
kitchen within a week. Keeping the picture true is your job, done by reasoning,
not by asking people to maintain an inventory.

**Evidence, not clocks.** `kitchen_inventory action:"review"` lists what the
kitchen is unsure of, each with its evidence: when it was bought, meals cooked
or suggested with it since, when anyone last saw it, and how long it usually
keeps where it is stored. Reason as a person would: "the onions were bought
three weeks ago and two dinners since used them, so they are used up, going
soft, or they bought more." Raw meat past its fridge life was most likely
frozen or cooked, not left to rot.

**Four verdicts.** `kitchen_inventory action:"assess" verdicts:[{item, verdict,
reason}]` with `here`, `frozen`, `low` or `gone`, and a reason in a few plain
words.

- **Reasoned** (`told` omitted): `here` changes nothing, `frozen` is written,
  and `low` and `gone` are held as suspicions for the next follow-up. Nothing
  leaves a shelf on an inference alone.
- **Told** (`told:true`, a person said so): written at once, whatever it is,
  and any suspicion about the item is dropped. `here` clears an out or a low,
  assumed or not, so the item leaves the list.

**Silence settles it.** A suspicion raised in a follow-up and unanswered for two
days, or never raised within four (no meal was sent), is assumed: the item is
marked out or low in one undoable batch. It then goes through the same rules as
any run-out (see *The shopping list*), and a staple is listed on the list and
the note under **Assumed to be low/out:**. On the site, ticking one there (or
"I already have this") means they still have it: it goes back in the kitchen,
and it is not a shopping trip. A suspicion is withdrawn automatically if the
item is bought or seen again.

**The morning review** is a daily event in the household's `wake` session
listing the items worth a look. Assess them and reply `KEEP_QUIET`. Items past
any reasonable doubt are held as suspicions even if you never answer. An item
shown once is not shown again for three days.

**`expires` is the printed date only.** Never estimate one when recording
groceries. A guessed date reads as a fact to everything downstream; shelf life
is the kitchen's job.

**Before a dish depends on something unsure, ask.** `kitchen_status` lists what
might be gone or low. One short line ("Do you still have the mushrooms?") beats
a recipe built on food that is not there.

## What makes a good meal here

Meals come out of the inventory, so most bad suggestions are bad inventory. The
rest come from ignoring these:

- **A dinner has a real main**: chicken, pork, beef, fish, eggs, beans, pasta.
  Deli meat, sliced cheese, bread, chips and snacks are lunch food. They may
  appear in a dinner but never anchor one; the code refuses to rank or save a
  dinner whose main ingredient is lunch food.
- **Vary the shape, not just the name.** Seared protein, starch, vegetable and
  butter-garlic sauce five nights running is one dinner. Check what was cooked
  recently (the ideas brief lists it) and change the method, cuisine or starch.
- **The avoid list is a hard filter.** Anything in `diet.avoid` is never
  offered, on any path: the home page, dinner texts, ideas, explore, and what
  the tray says is worth buying. Record a new dislike as soon as somebody says
  one: `kitchen_accounts action:"settings" avoid:[...]` with the full list,
  since it replaces the old one. Terms match whole words and forgive number:
  "mushroom" also catches cremini mushrooms and mushroom soup, "mushrooms"
  catches mushroom, and "olives" never catches olive oil. A recipe written with
  an avoided food is saved with a warning and never suggested; looking a dish up
  or confirming it was cooked ignores the list.
- **A "no" is information.** When somebody turns a dish down, note it in the
  person file and do not offer it again soon.
- **Ask about unsure food, never assume it.**

## Tools

| want | tool |
|---|---|
| whose kitchen, what is on a clock, what ran out, what might be gone | `kitchen_status` |
| inventory, or "do we have X" (strict) | `kitchen_list` |
| what is really there: evidence and verdicts | `kitchen_inventory` |
| groceries arrived, a meal was cooked, a correction | `kitchen_record` |
| retract a bad write (`batch`, or omit for the latest) | `kitchen_undo` |
| check a meal against stock before writing it | `kitchen_plan` |
| they cooked it, or did not | `kitchen_plan_resolve` |
| a recipe already written out | `kitchen_recipe_get` |
| save one you just wrote | `kitchen_recipe_save` |
| everything written for this house | `kitchen_cookbook` |
| what to buy; list answers; the note is up to date | `kitchen_shopping` |
| reconcile against the shelves, including photos | `kitchen_check` |
| "text us dinner at 4 every day" | `kitchen_schedule` |
| site taps waiting for a person | `kitchen_requests` |
| answer a question asked on the site | `kitchen_chat` |
| answer a question asked aloud mid-recipe | `kitchen_voice` |
| a favourite or a note from the site | `kitchen_mark` |
| the household's own meal ideas | `kitchen_ideas` |
| dishes this house does not make | `kitchen_explore` |
| recap, calories, spend, rhythm, raw log | `kitchen_insights` |
| the list priced across stores | `kitchen_deals` |
| load prices you fetched | `kitchen_prices_import` |
| households, members, budget, diet, stores | `kitchen_accounts` |
| **why is this not working** | `kitchen_accounts action:"check"` |
| set up a kitchen for someone new | `kitchen_onboard` |
| render the household's website | `kitchen_site` |

## Households

A **household** is one kitchen's food and the people who share it, and it is
the unit of isolation: Alex and Sam share a fridge so they share a ledger;
Jordan buys his own food so he has his own. Every chat of a member (their DMs
and their group) resolves to the same household, so food cooked in one thread
comes off the shelf another thread reads. Say which meal it was in `why` when a
meal is planned in one chat and cooked in another.

You never pass a household id in normal use; tools resolve the session through
`data/kitchen/tenants.json`. The `account` argument only disambiguates among
kitchens this session belongs to. Naming one it does not belong to is refused.
Crossing that line (a migration, operator debugging) needs `KITCHEN_ADMIN=1`,
set explicitly. Never mark ownership by prefixing item names with a person; the
household boundary does that.

    kitchen_status                        # which household this session resolves to
    kitchen_accounts action:"list"        # every household, members, event counts

**No household.** Every tool refuses and says who is asking. That is correct:
there is no default household. Which recovery is right is a question for the
person, not a guess:

    kitchen_accounts action:"join"   account:"<id>"   # they share an existing kitchen
    kitchen_onboard  action:"check"                   # they might want their own

A principal belongs to at most one household; every write path refuses a
second.

### Onboarding

Offer a kitchen the second or third time somebody asks what to cook from
nothing. **Set nothing up until they say yes**; an empty household is worse
than none.

    kitchen_onboard action:"check"     # should I offer? what is missing? never throws
    kitchen_onboard action:"start"     # provisions everything, only after a yes
    kitchen_onboard action:"stock"     # their photos -> proposed items
    kitchen_onboard action:"accept"    # the confirmed ones, as one undoable batch

Ask for two things only: who eats there, and photographs. Everything else
(meal times, spend, tastes, headcount) is derived from the log once it exists.
The optional `start` arguments are for what somebody volunteers later, never a
form. Order: `start` with an id and their name, ask for one fridge photo and
one cupboard photo, `stock` them, show the list and drop what is wrong,
`accept`, then `kitchen_site`, which publishes their page at its permanent
address and returns the link once the page has answered there: send that link.
Names come from the contact book when the phone already knows them; ask only
for the ones it does not. `check` after each step says what is still missing,
from what actually answers rather than what is recorded.

## Writing to the ledger

Everything that writes goes through `kitchen_record` (add, use, set, toss, a
whole receipt or a whole dinner) or `kitchen_undo`. One call is one batch, so a
wrong six-ingredient dinner is one retraction. `kitchen_insights view:"log"`
reads the raw log, newest first, with retracted batches marked (`limit`
defaults to 25).

**Quantities.** Count what is countable (`qty` and `unit`). For things nobody
counts (spices, oils, flour, condiments) use `level` (`full`, `low`, `out`)
instead, never an invented number.

**Lookups are strict.** `kitchen_list query:"egg"` answers yes only for an item
actually called that (name, id or alias); "Wide egg noodles" is reported as a
near miss, not a yes. Every mutation (`use`, `plan`, `toss`) refuses loose
matches. When a shorthand keeps missing, add it as an alias on the real item
with `kitchen_record`; never loosen the match.

### Receipts

Transcribe every receipt completely.

- Rotate it upright (`sips -r 90 copy.jpeg`) and read the full-resolution file.
  On receipts that print list price, discounts and then `PRICE YOU PAY`, the
  last is what the item cost.
- **Check your count against `TOTAL NUMBER OF ITEMS SOLD`.** Multi-buys
  (`4 @ 0.60`) count as four. A mismatch means a missed line.
- **`price` is what the line cost, never a per-unit rate.** A $1.46 dozen logged
  as `qty 12` has `price 1.46`; grapes at $1.29/lb weighing 2.17 lb have
  `price 2.80`. Line totals must sum to the printed total. Unit prices for
  comparing stores belong in the price book (`kitchen_prices_import`, which
  takes the size explicitly).
- Expand abbreviations, keep the raw receipt token in `why`, and say so when a
  name is a guess.
- `expires` only when a date is printed on the package.
- Load it all in one `kitchen_record` call with
  `source:"receipt:<store>-<date>"` (`trip:<store>-<date>` for a shop with no
  receipt). Only those sources count as a shopping trip.

## Writing a recipe

A recipe is built from the ledger and is not finished until somebody confirms
it was made. The order matters.

0. **Look first.** `kitchen_recipe_get`. A written recipe is kept forever;
   rewriting it makes a second, slightly different version of the same dish.
1. **Read the shelves.** `kitchen_status`, then `kitchen_list` for anything
   specific. Choose a dinner these people would want, from what is probably in
   the house. If it depends on something unsure, ask first.
2. **Plan it against the ledger** before writing a line:

   ```
   kitchen_plan meal:"baked tortellini" uses:[{item:"tortellini", qty:1}, ...] when:"Monday dinner"
   ```

   It resolves every ingredient, refuses anything missing or short, and returns
   a plan id. If something is missing, change the recipe or make it a shopping
   item. `force` only when a human confirmed the item exists.
3. **Write it** with `kitchen_recipe_save` from the plan's numbers, then
   `kitchen_site` to render. The page's "We made it" button is settled by the
   watch pass.
4. **The follow-up is automatic.** The plan remembers which chat it was made
   in; the next afternoon the watch pass wakes that chat. Send one short text
   they can answer in a word or two:

   > Did you end up making the chicken parm? Also, I think you might be low on
   > rice and limes. Want me to add them, or anything else?

   No paragraphs, no explaining how you know. Act on the reply:
   `kitchen_plan_resolve` made or not, `kitchen_shopping add` for a yes,
   `kitchen_inventory action:"assess" told:true` for "still have it" or "we're
   out". Anything they do not mention is assumed in two days. Never schedule
   your own reminder for this; it would be a second follow-up for one meal.

`templates/made_button.html` exists only for one-off pages served outside the
site.

### The recipe page

Owned by `src/recipepage.ts`, written to `<artifact>/recipe/<id>.html`. The
rule under all of it: a person cooking should never have to think about
anything except the food.

- **Ruled, not decorated. No coloured left accent bars**; the household has
  rejected them. A hairline rule and a small-caps label carry structure. Colour
  is only for what is live: a running timer, the progress bar, the mic, the
  current step. Figures are tabular.
- **A step is never a paragraph.** Title, one sentence on why, then `parts` (one
  action per line, all the detail) and `watch` (how you know it is done).
- **Every step lists its own ingredients** with the amount for that step. **Fill
  `uses` on every step.** Without it the page falls back to the whole-dish
  shopping amount, which is wrong in the pan. `kitchen_recipe_save` reports how
  many steps lack `uses`; if it is not zero, you are not finished.
- **Every step is exhaustive.** Cut size, what the pan should look and sound
  like, how to tell it is done, which pan. Times are cues plus a timer, never
  times alone.
- One step per screen by default, position in the URL hash; a View button offers
  the whole method as one list (a per-device cookie). List mode drops step
  navigation and per-step cameras and keeps the mic.
- **Technique visuals are real**: Wikimedia Commons photos with credit and
  licence, real chefs on video, plus written reference. Never drawn or
  generated. `src/techniques.ts` holds the table; `scripts/fetch_techniques.ts`
  downloads images so nothing hotlinks. **Verify any video id against
  `youtube.com/oembed` before adding it.**
- Timers are deadline-based and run across steps.
- **The button is a microphone**, not a chat box: browser speech in, Edmund's
  generated voice out (`src/voice.ts`), browser synthesis as fallback, typing
  as a last resort.
- No two-cook mode.
- **Every button that invokes a model gets a confirm sheet** naming the action
  and what will happen, dismissable without firing. Deterministic buttons (log a
  meal, undo a cleanup, tick the list) stay one tap.
- **Real photos beat generated ones.** A photo of the actual plate replaces the
  generated hero everywhere; the generated one is moved to
  `img/meals-generated/`, never overwritten. Uploads land in `img/upload/` via
  the share server's `/upload` endpoint.

### Compound meals

- **A pair is exactly two meals deep.** `compoundPairs` refuses a parent that has
  its own `from`.
- **Second-night dishes stay off the grid.** They live on the parent's card
  ("Then tomorrow: X") unless the leftover is really in the fridge, when it
  shows as tonight's dinner.
- **Confirming the first meal writes its `yields`** as real leftover containers.
  Leftovers untouched for four days are retired automatically.
- **Either half can be declined**, reversibly, from the same sheet. Skips expire
  after fourteen days.

## The shopping list

Use `kitchen_shopping`, not `kitchen_status`, for what to BUY. "Out of X" is a
fact; "buy X" is a decision.

A line reaches the list only through one of these groups:

- **For a meal you planned**: an open plan's gaps. They leave when the meal is
  cooked or called off.
- **Out of something you keep**: ran out or marked low, and the house keeps it
  (bought on two or more separate trips, or marked `always`).
- **Assumed to be low/out:**: the same, for run-outs nobody confirmed
  (unanswered suspicions), kept apart and worded as a guess. Every answer below
  applies to them too, and a one-off is dropped as usual.
- **You added these**: somebody typed it. Never second-guessed or dropped.

The list must never become everything ever bought. Everything else is a
**suggestion** in a tray that is visibly not the list:

- A run-out that was bought once and cooked with, or a kept protein. It is
  offered in the next meal follow-up ("want me to add it?"), at most once a
  fortnight, and only if it ran out in the last three weeks. Something bought
  once and never cooked with is dropped without asking.
- Something this house has bought before that would open up dinners. Capped at
  six and re-decided every trip. Never snacks.

**Proteins are offered, never listed**, even when kept: which meat to buy is a
fresh choice each week. Record a lasting preference with
`answer:{item, as:"always"}` and that item lists itself.

Three ways to take something off, and they differ:

| They said | Do | Because |
|---|---|---|
| "I already have that" | `kitchen_inventory action:"assess" told:true` `here`, or the site's "I already have this" | The ledger is wrong. |
| "not this trip" | `answer:{item, as:"skip"}` | About today; ends at the next trip. |
| "we do not buy that" | `answer:{item, as:"never"}` | About the household; permanent. |

`answer` resolves the item against the list, the tray and the ledger and
refuses anything it cannot place. `add:[{name, amount, cat, item, why}]` writes
lines; pass `key` when the add answers a site tap.

**A list nobody ticked still settles.** A receipt logged through
`kitchen_record` clears written lines it satisfied and ends skips. Ticks on the
site log items back onto the shelves with no quantity (a tick knows presence,
the receipt knows amounts). A tick under **Assumed to be low/out:** means "we
still have it": the item comes back, but it is no purchase and no trip.

### Apple Notes

Each household's list also lives in a shared Apple Note, the one people shop
from on their phones. **Only you write it, on screen, with the computer tools**
in the Notes app on this Mac. No tool and no background job touches a note.

- **When.** After you change a household's list in a turn, bring its note up
  to date in the same turn if you can, then `kitchen_shopping noteWritten:true`
  with its `noteVersion`. If you don't, the watch pass wakes that household's
  session once the list has held still for two minutes, with the lines the
  note should have, and you do it then, quietly. The site's Apple Notes button
  asks for that wake at once, even when the list's own wakes have run out. A
  chat with no screen tools for Notes is never woken (while computer use only
  shadows, that is every chat but the owner's), and nobody is woken while the
  Mac is locked; those notes wait and are woken for once they can be done.
- **Which note.** The one named in `note_list` (set once with
  `kitchen_shopping noteTitle`), else "<household> list". The first
  `noteWritten:true` pins that title, so naming somebody later never renames
  the list. Open it from the note list by that title. The screen tools refuse
  another household's list; never open one.
- **What it says.** Above the line "Add anything below this line and I will
  move it onto the list above.": the title as the first line, then each group
  as a heading followed by its lines as checklist items, exactly as
  `kitchen_shopping` prints them when the note is behind. Below that line is
  the household's own. Never rewrite it, but anything new there is an item
  somebody wants: put it on the list with `kitchen_shopping add` (`by` whoever
  wrote it, when you can tell), then delete it from below the line.
- **Delete only your own lines.** The wake and `kitchen_shopping` name the
  lines you wrote last time that have since left the list; those are the only
  lines above the sentinel you may delete, and the screen check refuses any
  other. A line up there you were not given is the household's, even one
  typed between your lines or one of yours they reworded: put it on the list
  with `kitchen_shopping add`, name exactly as written, and leave it where it
  is. When nothing records which lines are yours yet, delete none of them.
- **Change only the lines that differ.** Delete your lines that left the list,
  add new ones as unticked checklist lines (Format > Checklist), and leave the
  rest alone. Never select all and paste the list: a phone that has edited
  the note can bring deleted lines back, so a whole-note paste leaves stacked
  copies of the list on somebody's phone.
- **Ticks are theirs.** A ticked line means "in the cart". Leave it ticked
  while it stays on the list. A tick never means the food is owned; the
  receipt decides that.
- **Check before you say so.** Take a screenshot after editing, and call
  `noteWritten:true noteVersion:"<v>"` only once the note reads right, with
  the version printed next to the lines you worked from. That records those
  lines as yours. Without a version nothing is recorded. If the list changed
  while you worked, the note stays behind and you are woken for the rest. If
  Notes will not cooperate, leave it: the note stays marked as behind.
- **Sharing.** To put somebody on the note, use Share > Collaborate in Notes,
  which sends the invite through Messages. The screen tools only act in the
  conversation you are in, so you can invite the person you are talking to
  and nobody else from there. The first share of a household is always
  something a person asked for, because an invite reaches another person.
- **Trust iCloud.** An edit made in Notes on this Mac reaches phones on its
  own. Do not go and check icloud.com.

## The site

One site per household, one call: `kitchen_site`. It writes the hub, a page per
written recipe, the shelf-check page and the chat threads into the household's
artifact directory. Panels: **Home**, **Kitchen**, **Explore**, **History**,
**Shopping**, **Schedule**, **Recap**.

- **Every site has one permanent address**, served by the kitchen host.
  `kitchen_site` publishes to it and returns the link only once the page has
  answered through it. Send only that link, never one from anywhere else.
- **A site still on an old temporary link** (a `trycloudflare.com` address)
  keeps it until `kitchen_site host:true` moves it. That link dies whenever its
  tunnel restarts, and moving changes it, so send the new one.
- **One directory, one household.** Never point two at one directory.
- **Rendered is not served.** `kitchen_accounts action:"check"` reports a site
  broken when the host cannot reach it through its public address; run it
  whenever something "is not working". Taps only reach the kitchen from a
  served site.

### What settles itself

`src/drain.ts` sorts every tap by whether it needs judgement; the watch pass
runs it every minute.

**Settled without anybody**: confirming or calling off a meal, "We made it",
favourites, notes, ticking the list, undoing an automatic cleanup, confirmed
shelf-check swipes, ledger corrections from a card, preferences and the vibe,
filed photo uploads, creating or pausing a standing text. Never apply these by
hand.

**Left for you, in the main session of the person it concerns**, as a one-shot
event naming the tool that answers it:

- **Conversations** (your reply is a text to the person who tapped): writing a
  recipe (`make`), a variant around what the house has (`variant`), a dinner
  when nothing fits (`compose`), writing an explore idea out (`idearecipe`). If
  the dish depends on something unsure, ask one short question first.
- **Site answers** (the answer lands on the page; end with `KEEP_QUIET`): chat
  on the page (`kitchen_chat`), a question asked aloud (`kitchen_voice`), the
  explore shelf (`kitchen_explore`), what a dish needs from the store
  (`kitchen_shopping add`).
- **The morning review** (silent, `KEEP_QUIET`): `kitchen_inventory
  action:"assess"`.
- **The meal follow-up** (a short text): see *Writing a recipe*, step 4.

Every button that spends a model call says so on screen and says where the
answer will appear ("I will text you when it is ready" or "this lands on the
page itself"). Add that line to any new button.

### Requests waiting on you

A tap that needs a person sits in the artifact's `_callbacks.jsonl` until
served; the watch pass wakes the right session at most three times, twenty
minutes apart. `kitchen_requests` lists what is waiting.

For a Make-style request: `kitchen_recipe_get` first, then `kitchen_plan`,
`kitchen_recipe_save`, `kitchen_site`, then text the person. Mark it served with
`kitchen_requests handled:[...]` **only after it has gone out**; serving twice
texts the same recipe twice. `kitchen_chat` replies on the website, not by
text; never both.

### The day, and why the home page changes

The home page must never feel like the same week twice. `src/mood.ts` reads the
day before anything is ranked:

1. **The calendar** (month, weekday, holidays in their lead window, football) is
   arithmetic and needs no network.
2. **The weather** comes from NWS for the household's `place`, cached, stale
   after 12 hours. **No reading means the page says nothing about weather.**
   Never invent a seasonal average.
3. **A pinned vibe** beats both.
4. **The ledger** decides what is cookable, downstream.

**The mood ranks and never filters.** Cookability outranks every mood term.

Optional recipe fields that feed it: `effort` (`quick`, `weeknight`, `project`,
`allday`; how much of the day it wants, not the clock), `method` (`crockpot`,
`oven`, `grill`, `nocook`, ...), `feeds_days` (days one batch keeps feeding,
only for real meals), `season` (months, stated per dish, never derived),
`occasions` (`weekend`, `sunday`, `gameday`, `holiday`, `cookout`, `cozy`,
`hotday`, `party`; usually empty), `spend` (1-3), `cuisine` (one word).
Household preferences (`prefs.vibe`, `prefs.mode`, `prefs.per_meal`,
`prefs.avoid_methods`, `budget`) are overrides only. Nothing may require an
answer.

### Meal ideas and explore

`kitchen_ideas action:"brief"` gives the ingredient slugs with the kitchen's
confidence in each, lunch food listed separately, what was cooked recently and
the names to avoid repeating; write the dishes for these people, then
`action:"save"`. Saving rejects unknown ingredients, avoided food and dinners
anchored on lunch food. Salt, pepper, oil, flour, sugar and water need no
tracking: untracked, they count as in the kitchen; tracked, the ledger decides
(salt marked out makes a dish short). Running out of one never retires an idea.

`kitchen_explore` is the deliberate exception to the ledger anchor: dishes
chosen for distance from what the house cooks, labelled as ideas to shop for,
never as cookable, and never written to the ledger. Everything the house owns
goes into the brief, anything on a dish's buy list that matches a live item
is moved to "already in the house" on save, and a dish that uses anything on
the avoid list is dropped.

### One-person households

Everything works, with these differences: the site signs the one person in
without a profile picker; `eaterCount` counts messageable people, never group
chats, so a household whose only member is a group has nobody to text and is
BROKEN; per-person figures divide by that count; the title falls back to the
account name; explore repeats more, so give it a theme; a standing text with no
recipients goes to that person.

## Standing dinner texts

`kitchen_schedule`, shown as the **Schedule** panel. The text has to arrive, so
the pick is arithmetic (the home page's ranking over what the shelves can cook)
and the watch pass sends it; no model is in the delivery path. If the chosen
dish was never written out, firing also queues the same request a Make tap
would, and the written page follows the text.

```
kitchen_schedule action:"set" at:"16:00" days:[1,2,3,4,5] to:[...] meal:"dinner"
kitchen_schedule action:"preview"     # exactly what would be sent now; sends nothing
kitchen_schedule action:"list" | "pause" | "resume" | "remove"
```

Times are 24-hour local; days are 0=Sunday..6=Saturday, empty means every day;
omit `to` for everyone who eats there. **A schedule can only text members of its
own household**, enforced on every write path.

- The pick skips dinners anchored on lunch food, anything on the avoid list,
  and any dish the same schedule suggested in the last week.
- **Once a day**, inside a 75-minute grace window.
- **A missed window is skipped, never sent late.**
- **Firing consumes nothing and opens no plan.** Food leaves the shelves only
  when a person says it was made.
- **It never promises a page it cannot deliver**: a household with no served site
  is not told a page is coming.

When somebody asks for one, set it and say in one line that it is live.

## The shelf check

`kitchen_check` is how the kitchen looks at the real shelves.

| they did this | call |
|---|---|
| sent photos of a fridge, cabinet, drawer | `action:"photos"` with `files`, `where`, `by`; read them against the checklist, then `action:"propose"` with `seen:[{item, verdict, qty, because}]` |
| said the counts are off, or asked to check | `action:"start"` with `by` |
| answered some of your questions | `action:"answer"` with `answers:[{item, verdict, qty}]` |
| finished | `action:"apply"` |
| where is the open pass | `action:"status"` |

Verdicts are `have`, `gone` or `amount`.

- **Nothing reaches the ledger until `apply`**, and a photo never applies itself.
  Half a fridge is behind the milk and a closed drawer is not an empty drawer;
  photo reads are proposals to confirm.
- **Always pass `by`.** "Jordan counted four onions on Sunday" is worth more
  than "the ledger says four"; every verdict is stamped with who looked.
- **A confirmation is a write.** It records that a person saw the item, which is
  evidence the inventory reasoning uses.
- The deck is scored (`scoreShelf` in `reconcile.ts`): **hazard** (days idle over
  how long the item lasts in this house), **debt** (days since a person looked;
  uncapped, so even paprika surfaces) and **value** (being wrong about chicken
  costs a dinner, about oregano nothing). Anything confirmed in the last six
  days is excluded. 24 items a pass, a quarter reserved for the longest unseen.
  The same order drives `<artifact>/check.html`.

## When something is not working

`kitchen_accounts action:"check"` (every household when none is named) reports
three levels, and the distinction is the point:

- **BROKEN**: something claims to work and does not. A site with no URL, a
  schedule texting someone who moved out, a written recipe with no page, a
  principal in two households.
- **absent**: a valid state that costs a feature (no coordinates so no weather,
  an empty list, no standing texts). **Never describe these as errors.**
- **ok**: checked and true.

The daily pass prints BROKEN lines too. When somebody says a button did nothing,
run the check before theorising.

## Talking about it

Report what the ledger says. "You have four yellow onions and five bulbs of
garlic" beats "you should have onions". When something is not tracked, say so
and offer to add it. The same goes for the machinery: "the site is rendered but
has never been served" is an answer; "it should be working" is not.

House style for anything people see: no emoji, no em-dashes in copy, and
anything inferred rather than measured is labelled inline.
