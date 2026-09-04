# Changelog

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
