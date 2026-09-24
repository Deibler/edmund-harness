# Changelog

## 0.3.2

### Patch Changes

- 078c0e4: Run the SOUL.md size gate, and send know-how to subject notes instead of SOUL.md.
  
  The gate for SOUL.md was written on 2026-08-28 and never called by the daemon, so the file grew from 31 KB back to 43 KB of every system prompt. It now runs in the boot sweep and after every self-note. `remember_about_self` requires a section and is limited to character and facts about Edmund's life; recipes, tool quirks and mistakes go to `remember_about_subject`, which is now in the tool catalog. The output contract states once that everything in the final text ships and that `KEEP_QUIET` is the only way to send nothing.
- e2d7027: A standing dinner text asks for a written recipe page on the day's first send again. The check read "any stored receipt" as a retry, and stored receipts still hold the last day it fired, so the page was requested once (2026-08-17) while the text promised it on 17 more days.
- b07d6ed: Scheduled and proactive wake-ups that start without the session's model conversation now carry the recent thread, as inbound cold starts do. The runner's persona-edit log says what happens (the session resumes and picks up the new prompt when its worker next starts) instead of announcing a fresh start that never happened.

## 0.3.1

### Patch Changes

- 229a464: Fixes from a review of the computer-use server. A contact's screenshot now blacks out the whole Notes window when another household's note is open and its body cannot be located, instead of covering nothing. Turning computer use off, taking an app off a list or switching the check from shadow to enforce now reaches sessions that are already running: the policy and the check's mode are read again from config.toml before every action (parsed only when the file changes), grants and grant flags the policy no longer allows are taken back, and a config that cannot be read refuses the action instead of falling back to the startup list. Before this, list_granted could show no approved apps next to two live grants that still clicked. The fixed refusals now cover their other paths: any key that would enter text in a password field is refused, not only Paste, and clicking Quit Messages, the Apple menu's Log Out, Restart, Shut Down, Sleep, Lock Screen or Force Quit, Finder's Empty Trash, or the Dock's Quit is refused like the shortcut for it. Where the element under a click in Messages or the Dock cannot be read, the click is refused. The screen lock takes, refreshes, releases and clears its file under a kernel lock, so two servers that both find a dead holder's lock can no longer both end up holding the screen, and the daemon no longer deletes a lock another server took after the daemon last read it. Delete descriptions count characters rather than UTF-16 units, so twelve forward-deletes over an emoji line no longer leave out the last line break. In Notes, after Select All (or with a selection that spans the whole note), pasting, typing, deleting or cutting is refused until a click or an arrow key moves the caret, so a whole note can no longer be replaced by paste. A scheduled note-sync turn keeps its scheduler context when a household member texts during it: the daemon now records which cron job started each turn, and the check reads that record instead of comparing the job's fire time with the latest message. The turn that message starts next still gets no scheduler context.
- 5a38db9: The computer-use safety check reuses a verdict when a check's state is exactly the same as an earlier one's within 30 minutes, instead of asking again. In one 68-minute Silhouette turn, 757 of 1,355 checks repeated an earlier one exactly (3.5 of 6.8 minutes of checking), and none got a different verdict. Errors are never reused, and any change to the action, the explanation or what the person said asks again. Delete, forward-delete and Cut with focus in a never-saved document Edmund created during the session no longer refuse on the destructive answer alone; every other harm still refuses. The harness decides whose document it is: an untitled window in an app the session launched, or one its app did not have when the session could first act there. Rewording the classifier's question was tried and rejected, because it lowered the destructive score of every Silhouette Delete, including one in a saved file (0.49 to 0.28).
- 530807d: The kitchen's "Assumed to be low/out:" section now follows the same rules as the rest of the shopping list. It used to be built before any of the household's answers were read, so "I do not buy this" and "not this trip" did nothing to an assumed line, and one-off purchases landed on it. Saying "we still have it" about a low item left it low and moved it to the confirmed "running low" section, and the site's "I already have this" reported that the ledger already agreed. Ticking an assumed line on the site and pressing Finished shopping recorded a purchase: it counted as a shopping trip, used up "not this trip" skips on other items, and could turn a one-off into a staple. A tick there now means what the list says, that they still have it: the item goes back in the kitchen with no purchase and no trip, through the same path as "I already have this" and the chat verdict. Whether a run-out was assumed is now read from the write that decided the item's state, so a rename or a price backfill cannot turn a guess into a fact. The avoid list is applied where dishes are suggested or ranked (the home page, dinner texts, the tray's buying ideas, explore, photos) and no longer where a dish is only looked up, so recipes written for the house are filtered too, and confirming a cooked avoided dish records its leftovers again. Saving a written recipe that uses an avoided food warns instead of refusing, since somebody asked for it. Avoid terms forgive singular and plural ("mushroom" catches cremini mushrooms, "mushrooms" catches mushroom) without catching an attribute ("olives" never catches olive oil). Ideas seasoned with salt and pepper are cookable instead of short two, and are no longer deleted by the next morning's prune; a basic the household does track is judged by its tracked level. An undone "we made it" or "we didn't make it" no longer counts in an item's history, and the leftover sweep's undo button, its put-back tap and its two-week exemption now ignore a put-back that was itself undone.
- 7a1fedf: Kitchen sites now live at one permanent address. A new launchd service, the kitchen host (`scripts/launchd/service.sh kitchen-host install`), keeps a share server running for each household on a fixed port, routes each request to its household by the `?key=` the page already sends, and runs a named Cloudflare tunnel to it. It checks every site through its public address each minute. Quick-tunnel links died with every reboot and every few days besides, and nothing noticed: the daily pass printed "could not reach" and then "health: nothing broken", and the health check called a dead site `ok` because a URL was recorded. `kitchen_site` now publishes the page and returns the link only once the page has answered through it. A site counts as working in the health check and the onboarding checklist only on a recent check through the host, and an unreachable one counts as broken in the daily pass. Onboarding fills in a member's missing name from the contact book and treats the people step as done only when everybody who eats there has a name. `service.sh` gains a sidecar installer that renders launchd templates; the SMS tunnel's plist had been symlinked to its template, so launchd exited 78 on every start.
- 3bdad15: The computer-use Messages scope now closes four gaps a review found. Keys and typing are judged by the window that holds the keyboard focus, and are refused when Messages cannot say which window that is. Before, they were judged by the window with the sidebar, so with another conversation open in a window of its own, a key could be sent there while the safety check was told it was the requester's. Notes works the same way now, and a window title the helper clips at 80 characters still finds its window. A title another conversation in chat.db could also have no longer identifies either one: two unnamed groups with an Alex and a Sam are both "Alex & Sam". A sidebar row counts as the requester's only when that is the one way to read it, so a DM contact named "Sam" no longer matches the group row "Sam, Alex & Jordan, see you at 6". When chat.db cannot be read, no conversation is identified and Messages stays closed. In the Messages search field, only editing the search skips the conversation check. Any other chord, cmd+delete included, goes through the check. Return, Enter and the up and down arrows open a result nobody can check first, so they are refused there. A contact's screenshot now reads the sidebar again after the capture, and retakes the image, up to three times, if a row moved into a slot left clear. After that every list is blacked out whole, and if even that does not hold, Messages and Notes are left out of the image.
- 1a3a2fd: The kitchen now records which lines of a household's Apple Note Edmund wrote, and only those can be deleted. Before, a line counted as his by where it sat: a scheduled note sync was told to delete anything above the sentinel that was not on the list, and the screen check was told to allow it, so an item somebody typed between two list lines was deleted and never reached the list, and a reworded line was overwritten. Now `kitchen_shopping noteWritten:true` takes the `noteVersion` printed with the lines Edmund worked from, records those lines, and later wakes name only his own lines that have left the list. Any other line is treated as the household's and goes onto the list. The screen check allows a scheduled deletion only for lines listed under that heading. A household with no record yet starts from the old sync's `notes.json`, and with no record at all nothing above the sentinel is deleted.
  
  A confirmation now records the version Edmund was shown, so a list that changed while he was editing stays behind and is woken for again, where before the change was marked as written. The watch pass does not spend a note wake while the Mac is locked: it waits and wakes once it can. A tap on the site's Apple Notes button now gets a new wake even after the list's three attempts ran out, and it makes the note due once, so later list changes wait the usual two minutes. `canEditNotes` uses the screen server's own app matching, so an entry like "Notes.app" counts.
- 3081db1: Fix a scheduled note sync that could not remove a stale line. Key presses in Notes and Messages now go to the window that holds the focused element. With several checklist lines selected, Notes puts a small untitled window in front of the note, and every key was refused with "did not say which note is open". A Delete or forward-delete is now described to the safety check by the text it removes, read from the accessibility tree, and typing over a selection by what it replaces. The destructive question now says that deleting a line a scheduled event's list no longer has is the requested edit. The scheduled event is passed to the check whole (up to 4,000 characters instead of 800). Replayed against the refused forward-delete, the check allows it: destructive 0.29 to 0.38, down from 0.74.
- 82c3fdc: A household's note title is pinned the first time Edmund confirms the note (`kitchen_shopping noteWritten:true`). Before, a household with no `note_list` derived its title from the people's names every time, so naming somebody later pointed the kitchen and the screen scope at a note that did not exist. The note sync then refused to open the real one, and could never succeed. `service.sh` now removes an installed LaunchAgent before rendering its template. If the agent was a symlink to the template, rendering wrote through the link and emptied the tracked file.
- c67d7d9: The screen's safety check no longer hears a reminder the model scheduled as Edmund's own scheduler. Since the turn-trigger context was added, any cron job that started a turn reached the check as "Edmund's own scheduler started this turn", with carrying it out counted as requested, deletes above a note's sentinel allowed, and the on-screen-instructions question waived. `schedule_reminder` and `update_reminder` store the model's text word for word, and data-trigger fires carry the model's brief and fetched data, so a model could write itself that permission a minute ahead. Cron jobs now record whether harness code wrote their text (`harness_written`, default 0, older rows 0). Only kitchen wakes and their retries set it, and rewriting a job's text clears it. The check gets the scheduler framing only for those jobs.
- 9e20d6b: A computer-use `wait` right after an action in a batch now ends once the screen has shown the action's effect and held still for 300 ms, instead of sleeping in full. The helper remembers the screen just before the input (the same apps a capture would show, below the menu bar, at half resolution) and compares frames exactly. A wait with no visible effect, one longer than 10 seconds, or one whose watch fails still sleeps the whole time. One 68-minute turn on 2026-09-23 spent 599 s in 560 waits, 532 of them a flat second. On the live screen, a change that appears at once returns in about 0.45 s, one that starts 800 ms late is not cut short, and a still or constantly animating screen waits the full time.

## 0.3.0

### Minor Changes

- 338ad51: Add a computer-use MCP server (`src/mcp/computer-use`) that lets Edmund see and drive native Mac apps. It has the same 24 tools and parameters as Claude Code's built-in computer-use server, which only runs in interactive sessions, plus a required `explanation` of at least 100 characters on every tool.
  
  Only iMessage and SMS conversations get it, each with its own app list in the new `[computer_use]` section. The owner is recognised by handle (`[security] operator_handles`, else `[alerts] operator_handle`), never by `contact_tier`, which grants host access and would otherwise hand every contact the owner's screen. Every other DM and group gets `contact_apps`, and only while the safety check enforces. Guests, the mirror and sub-agents get nothing.
  
  Before any action runs, the harness checks it in its own code first and then asks Jev (`typesafe/jev-1.13`, through OpenRouter). Jev receives the action in words, who asked and from which conversation, their latest messages from chat.db, and the model's explanation. The action is refused if the check cannot run. In `shadow` mode verdicts are only recorded, without holding up the action; each verdict records its request attempts.
  
  Some things are always refused, without asking Jev: shortcuts that end the session, quitting Messages, and typing into password fields. Messages actions are limited to the conversation the request came from, and Notes edits to the requester's household list, which the kitchen integration supplies through `screenScope`. Contacts' screenshots show only granted apps, with every other conversation and list blacked out.
  
  One conversation drives the screen at a time: another waits up to two minutes, then is told the screen is busy. When a turn ends the daemon signals that conversation's server, which quits the apps its turn launched (by process, never Messages, never an app that was already running) and releases the screen. The feature is off by default.
- 2e655fd: The kitchen now reasons about what is really in the house instead of trusting fixed shelf-life clocks. Each item carries evidence (purchases, meals cooked or suggested with it, the last time anyone saw it, and how long it keeps where it is stored), a morning review hands the uncertain items to the household's main session for a verdict, and suspected run-outs wait for a short yes/no follow-up the day after a meal. Unanswered suspicions are assumed and listed under "Assumed to be low/out:". The shopping list only restocks items bought on two or more trips, Make requests from the site become a conversation in the tapper's own chat, and meal picks honour the household's avoid list and no longer build dinners around deli meat or other lunch food.
- 58d3e06: The kitchen no longer writes Apple Notes itself. The background sync that drove a signed-in Chrome on icloud.com to rewrite each household's note, and the invites it sent the same way, are gone. Edmund now keeps each household's shared note up to date on screen, in the Notes app, with the computer-use tools: changing only the lines that differ and leaving ticks alone. When a household's list changes and then holds still for two minutes, the watch pass wakes that household's session to do it, with the lines the note should have. It only wakes a chat that the computer-use policy gives Notes, and each list wakes at most three times. `kitchen_shopping` loses `notes`, `share` and `shareWith`, and gains `noteWritten`, which Edmund sets once the note matches.

### Patch Changes

- a0d643a: Fix contacts' screenshots showing other people's conversations. On macOS 26 a capture that includes only some apps covered just the box around their windows, stretched to fill the image, so the black-outs (placed at the windows' real positions) missed: a test capture as a contact showed every other conversation in the Messages sidebar. The capture now always covers the whole display. A live test (`EDMUND_LIVE_SCREEN=1`) compares a contact's capture with the owner's and fails if the window moves.
- 4fbbd43: `KEEP_QUIET` on the first or last line of a reply now vetoes the whole reply, so narration beside the sentinel is dropped instead of shipped. `edit_message` and `unsend_message` confirm the outcome against chat.db and report a request Messages accepted but never applied as an error instead of success.
- 2e71565: Kitchen meal ideas, explore suggestions, shopping decisions, shelf-photo reads, onboarding reads, and spoken cooking answers now run in the household's main session instead of direct OpenRouter text calls. Deterministic inventory work remains local, and generated card photography and speech synthesis remain presentation-only media calls.

## 0.2.0

### Minor Changes

- c8007e1: Install from one checkout. `imcore-bridge` now comes from its GitHub release
  tarball rather than a sibling directory, so `git clone && bun install` is the
  whole setup and the dylib is compiled during install.
- 5bad254: Add design documentation covering what is novel in the project, and lead the
  README with it rather than with the messaging transport. New pages: thesis,
  memory architecture, context economics, proactive economics, failure model,
  skill exchange, engineering notes.

### Patch Changes

- b1ae4c4: Pin imcore-bridge v0.2.3, which is the first release published by the bridge's
  own automated pipeline.

## 0.1.0

### Minor Changes

- 8f941cd: First public release: the documentation set, the `[security]` trust policy
  with safe defaults, dashboard and daemon hardening, revocable portal links,
  and a tree scrubbed of real identifiers.

### Patch Changes

- cc54099: Take the dependency updates that pass the gates: TypeScript 7, cloudflare 7
  (its snapshot response fields are optional now, so a partial render is
  reported rather than written out as an empty file), concurrently 10,
  changesets 3, hookform resolvers 5, and the GitHub Actions majors. Clear
  every high-severity advisory by pinning patched versions of six transitive
  packages. CI now typechecks and builds both front ends, which is where three
  type errors had been hiding, and the audit gate retries instead of failing
  the build when the advisory registry does not answer.
- 9cdf62c: Move the user portal to Vite 8 with the matching React plugin major. The
  plugin was declined last time because it would not build against Vite 6; it
  builds against Vite 8, so the two move together.
- 28adac8: Move the operator dashboard to Vite 8 with the matching React plugin, and
  take zod 4 there (it is a dependency the app's own source never imports).

Notable changes, newest first. Dates are absolute.

## Unreleased

- Scrubbed the tree of real identifiers: phone numbers, the bot's Apple ID,
  the home coordinates and address, the Pi credentials and the operator's
  name now come from `.env`, `[owner].name` or synthetic fixtures. A
  personal newsletter playbook and a scraped camera dataset left the tree.
- A `[security]` config section holding the trust decisions: model host
  access (sandboxed by default), a contact tier for allowlisted people who
  are not the operator, and explicit flags before an empty allowlist admits
  everyone. Existing deployments write their previous choices into the
  section to keep behaviour.
- Dashboard hardening: loopback bind by default, login throttling, Strict
  cookies with Secure over TLS, an origin check on mutations, body limits
  before authentication, no exception text in responses, real path checks
  on served files, security headers, longer PINs.
- Structural masking of every credential shaped config value in the
  dashboard API, and of credential shaped tool arguments in the daemon log.
- The SSRF guard now checks every redirect hop, and the data trigger probe
  goes through it.
- Trading: the risk check refuses model supplied account numbers unless a
  code level broker fetches them or the operator opts in; the trading
  dashboard escapes everything it renders.
- Portal links can be revoked per conversation, and the erase action needs a
  server checked confirmation.
- Background job lookups are scoped to the session that started them.
- Private umask and a permission sweep of data, persona, sandbox and config
  at boot.

- Prepared the repository for public release: rewrote the README and the
  documentation set, added CONTRIBUTING and SECURITY, moved deployment
  specific documents and campaign briefs out of the tracked tree, and replaced
  real identifiers in the example config and tests with placeholders.

## 2026-09-02

- Per person generation credits: each DM gets a provisioned OpenRouter key
  whose limit tracks Stripe payments. No local ledger.
- The per person portal rebuilt as a React application.
- An SMS channel over Twilio on the shared pipeline, off by default.

## 2026-08-28

- Root cause and fix for sends misrouting on macOS 26: dispatch through the
  chat registry rather than the adjusting send method.
- Operating principles layer: a consolidation pass that turns observations
  into rules.
- Domain notes, archiving of the global self file with recall indexing,
  tapback attribution in history, Apple Maps cards for addresses.

## Earlier

The design records in `docs/design/` describe each subsystem as it was
planned, and the git history describes it as it was built.
