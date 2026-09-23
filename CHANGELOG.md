# Changelog

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
