# Per-user generation credits — design plan

> Historical design record. Written before or while the subsystem was built and kept because it explains why the shipped design looks the way it does. Where it disagrees with the code, the code is right.

**Status:** live 2026-09-02 — Stripe Checkout; DMs only (groups stay on the
house key); no starter credit; per-person override editable from the
dashboard and CLI. Revised the same day to **no local ledger**: OpenRouter
and Stripe are read live on every page view and generation, the key's limit
is synced up to what Stripe says was paid, and the webhook is only a trigger.
The `credit_payments` table and apply/claim machinery described below were
built and then removed. Current truth: docs/generation-credits.md
**Author:** the operator, with Claude Code, 2026-09-02

## Problem

Every image, video, and audio clip Edmund generates is billed to one OpenRouter
key that the operator funds. The operator cannot keep funding everyone's generations. Each
person who talks to Edmund should carry their own generation credit, under
The operator's OpenRouter account, and when it runs low Edmund should send them a
link where they add more themselves.

### Measured before designing (2026-09-02)

Live numbers, not recalled:

| measurement | value |
|---|---|
| lifetime spend on the harness's OpenRouter key | (measured; kept in the operator's private notes) |
| OpenRouter account credit remaining | (measured; kept in the operator's private notes) |
| completed generation jobs, last 30 days | 139 images, 9 videos, 1 audio |
| distinct sessions generating, last 30 days | 10 |
| heaviest single DM, last 30 days | 75 images |
| all 9 videos came from | one DM |

Two things follow. Spend is tens of dollars a month, not thousands, so the
top-up mechanism must have low fixed friction (a $0.30 card fee on a $2
top-up is 15%). And usage is concentrated: two DMs account for ~70% of
images and one DM for every video, which is exactly the shape per-user
wallets are for.

## Concept: one OpenRouter key per wallet, funded through the operator

OpenRouter credits are **account-wide**. There is no way for a third party to
put money on one specific key. What OpenRouter does offer is the Provisioning
API: the operator's account can mint any number of API keys, each with its own
**spending `limit` in USD**, and read each key's `usage` and
`limit_remaining` at any time. A key that hits its limit gets `402` on every
call until the limit is raised.

So a "wallet" is a provisioned key whose `limit` equals what that person has
paid in (plus any starter grant). Topping up means: the person pays the operator,
and the harness raises that key's `limit` by the credited amount. OpenRouter
enforces the ceiling and keeps the ledger; the harness never estimates what a
generation cost. That matches two standing principles in this repo — *record,
never estimate* (spend ledger) and *verify against the system of record*.

The operator's account still has to hold enough credit to cover the sum of
everyone's remaining balances. Payments land in Stripe, not OpenRouter, so
that liability is explicit and is monitored (see Operator alert below).

### Why not a local ledger against the single house key?

Because enforcement would depend on our own accounting being right, and video
costs are only known after the fact. A per-key limit is enforced by OpenRouter
even when our numbers drift. It is also the only design where the user's
balance is a number OpenRouter reports rather than one we computed.

### The zero-liability alternative, named and set aside

OpenRouter supports OAuth PKCE: a person signs in to **their own** OpenRouter
account and hands the app a key that bills them directly. The operator would be out
of the money loop entirely — no Stripe, no held balances, no fees. The cost is
onboarding: every friend needs an OpenRouter account with a card on file, and
it does not match "all under my account". Set aside for that reason, but it
is the right answer if the friend group ever becomes strangers.

## Who pays for what

| session | key used | why |
|---|---|---|
| DM (`imessage:dm:<handle>`) | that person's wallet | the requested scope |
| DM from `alerts.operator_handle` | house key | the operator, always |
| DM whose wallet the operator has switched to `house` | house key | the per-person override (below) |
| SMS DM (`sms:dm:<handle>`) | that person's wallet (same handle → same wallet as their iMessage DM) | one person, one balance |
| group (`imessage:group:<guid>`, `sms:group:<sid>`) | house key | the operator's call 2026-09-02: groups stay frictionless. A shared group wallet is the same code path if that changes; the sender handle is not available inside tool processes today, so per-person attribution in groups would need a second change |
| `agent:<id>` (spawned worker) | its parent's wallet, via `AgentStore.get(id).parentSessionKey` | the person who asked pays; a worker is not a payer |
| `mirror:*`, `orch:*`, cron-only, trading | house key | the operator's own surfaces |

Only **generation** is charged: `generate_image`, `generate_video`,
`generate_audio`. Inbound transcription, `analyze_video`, and the
`list_*_models` lookups stay on the house key — they are cheap and the
conversation does not work without them.

## Required behavior

### Wallet store (new: `src/credits/store.ts`, tables in state.db)

Follows the GuestStore pattern (second store class owning its own tables on
the shared state.db, which the tool path denylist already protects).

```
credit_wallets   session_key PK, billing_mode (wallet | house), key_hash, api_key,
                 created_at_ms, starter_usd, paid_total_usd, credited_total_usd,
                 last_seen_usage_usd, last_seen_remaining_usd, last_seen_at_ms
credit_payments  id PK (stripe event id or manual:<id>), session_key, source
                 (stripe | manual), paid_cents, credited_usd,
                 status (applied | pending_apply | failed), attempts,
                 created_at_ms, applied_at_ms, error, note
```

The plaintext per-user key has to be readable by the MCP subprocess and the
detached bg-runner, both of which already read `config.toml` with the house
key in it. Same posture, same file class. `last_seen_*` columns are for the
portal and dashboard only — never for decisions.

### Per-person override and editing (dashboard Credits page + `edmund credits`)

`billing_mode` is the one place a person's treatment lives. Default `wallet`.
The operator can flip any DM to `house` (they generate on the global key exactly as
everyone does today) and back. The row exists even before a key is minted, so
an override can be set for someone who has never generated. No config list
duplicates this — one fact, one write path.

The same two surfaces also edit the wallet itself:
- **grant** `$X` — a manual credit (a gift, a refund made good, a friend). It
  is a `credit_payments` row with `source = manual`, applied by the same
  PATCH path as a Stripe payment, so the ledger and the key limit cannot
  disagree about how the balance got there.
- **show** — live `usage` / `limit_remaining` read from OpenRouter, plus the
  payment history.
- **disable / enable** — the key's `disabled` flag on OpenRouter, for the
  case where someone should stop generating without losing their balance.

Dashboard: a PIN-gated `/credits` page (list, per-row mode toggle, grant,
disable) backed by `/api/credits`. CLI: `edmund credits list | show <handle>
| mode <handle> wallet|house | grant <handle> <usd> [--note] | disable
<handle> | enable <handle>`. Both call the same store + provisioning client;
neither talks to OpenRouter on its own.

### Wallet resolution (new: `src/credits/resolve.ts`)

`resolveBillingSession(sessionKey, dataDir)` → `{ kind: "house" } |
{ kind: "wallet", sessionKey }`. Pure, tested, and the **only** place the
table above is encoded. Both the inline tool handler and the bg-runner call
it, so the two cannot disagree (a guard taken on one path is not a guard).

`walletKeyFor(billingSession)`:
1. Row exists with `billing_mode = house` → house key.
2. Row exists with a minted key → return its `api_key`.
3. No key yet → `POST /api/v1/keys` with `name = "edmund:<sessionKey>"`,
   `limit = starter_usd` (0 by default: the first generation refuses and
   sends the link), no `limit_reset`. Persist the plaintext key (it is
   returned exactly once) and the hash.
4. Provisioning API unreachable → throw. **Fail closed** — the generation is
   refused with a "credits system unavailable, try again shortly" result and
   an operator alert. Silently falling back to the house key is the exact
   outcome this feature exists to stop.

### Charging (change: `src/background/registry.ts` exec* functions, `src/mcp/tools/generation.ts`)

Replace the three `ctx.config.keys.openrouter` reads in `execGenImage`,
`execGenVideo`, `execGenAudio` with one `keyForGeneration(ctx)` that goes
through the resolver. `list_*_models` keep the house key.

Before a **video**: read `GET /api/v1/key` with the wallet key (returns that
key's own `limit_remaining`; no provisioning key needed) and compare with
`duration × per-second price` from the model listing. Refuse up front if
short — a video that dies at OpenRouter's 402 halfway through has already
burned the render time. Images and audio: refuse only when remaining ≤ 0.

After every charged generation, append a credits block to the summary the
model sees (inline result or wake-up envelope):

```
Credits: this generation cost $0.05. $0.63 of the user's generation credit remains.
LOW — below $1.00. Tell the user in one line and include their top-up link:
https://<portal>/u/<key>/<token>#credits
```

The `LOW` lines appear only under `low_watermark_usd`. On `402` from
OpenRouter, or a pre-flight refusal:

```
The user's generation credit is used up ($0.00 left). Do not retry.
Tell them plainly and send this link so they can add credit: <url>
```

This is the model-driven half of the feature: the tool cannot generate, but
the model always replies, in Edmund's voice, with the link. Nothing here
suppresses a reply.

### Top-up page (change: portal — new "Credits" tab)

`dashboard/server/views/portalPage.ts` gains a tab (DMs only; a group or a
DM switched to `house` does not get one, since there is nothing to pay
for). It shows: remaining credit (read live from OpenRouter via the wallet key, not
from our columns), total added, total spent, and three preset buttons from
`[credits].presets_usd` plus a custom amount with `min_topup_usd` as floor.
Viewing the tab creates the wallet if none exists yet, so a payment always has
somewhere to land.

Each button POSTs to `/u/:key/:token/credits/checkout` with the amount. The
route creates a Stripe Checkout Session (plain `fetch` to
`POST https://api.stripe.com/v1/checkout/sessions`, no SDK):
`mode=payment`, one INLINE-priced line item (`price_data` with the chosen
`unit_amount` and `product_data[name]` — nothing to create in Stripe's
catalog), `client_reference_id = b64url(sessionKey)` (alphanumerics, `-`,
`_` only — the existing portal encoding already fits),
`metadata[session_key]`, `success_url = <portal>?paid=1#credits`,
`cancel_url = <portal>#credits`. The page follows the returned session URL.

The page needs the portal's existing token auth and nothing more: the link is
already the credential for exactly one chat.

### Webhook (new: `dashboard/server/routes/pay.ts`, mounted on the **public** listener at `/pay/stripe`)

- Read the **raw body bytes** first; any parsing before verification breaks
  the signature.
- Verify `Stripe-Signature`: split on `,`, take `t=` and every `v1=`,
  compute HMAC-SHA256 over `"<t>.<raw body>"` with
  `keys.stripe_webhook_secret`, compare each `v1` constant-time, reject if
  `|now − t| > 300s`. Unset secret ⇒ every request rejected (fail closed, as
  `src/sms/signature.ts` does).
- Dedup on `event.id` (`credit_payments` PK). Stripe redelivers for three
  days on non-2xx and does not order events.
- On `checkout.session.completed` with `payment_status = "paid"`:
  `credited = round(amount_total / 100 × credit_ratio, 2)`; insert the
  payment row as `pending_apply`; **return 200 immediately**; then
  `PATCH /api/v1/keys/{hash}` with `limit = current_limit + credited`
  (current limit read back from `GET /api/v1/keys/{hash}` at apply time, not
  from our column — derive from the keyed source). Mark `applied`.
- Apply failures leave the row `pending_apply`; a 5-minute sweep in the
  dashboard retries with backoff; after 3 failures an operator alert fires.
  Money taken with no credit granted is the one outcome that must never be
  quiet.
- After a successful apply, enqueue a once-cron system event into the
  session: `[CREDITS] The user just added $9.00 of generation credit (paid
  $10.00); balance is now $9.63. If they were waiting on a generation, do it
  now. Otherwise one line of thanks at most — or nothing if the conversation
  has moved on.` The model decides whether to speak.
- `charge.refunded` in v1: log + operator alert only. The operator lowers the limit
  by hand. Automating this needs a floor at current usage and is not worth
  the surface area until a refund actually happens.

### Stable public URL (operational, no code)

Stripe needs a permanent HTTPS webhook URL. The portal's quick tunnel rotates
on every restart; the SMS named tunnel `edmund-sms` does not. Add a second
public hostname to that tunnel's cloud-managed ingress (Cloudflare Zero Trust
→ Networks → Tunnels → edmund-sms → Public hostnames):
`edmund.example.com → http://127.0.0.1:4749`. Set
`[dashboard].external_url` to it. Side effect worth having on its own: every
portal link Edmund has ever sent becomes permanent instead of dying at the
next tunnel restart.

### Operator alert (change: daily tick in `src/main.ts`, via the existing `alerts`)

Once a day: `GET /api/v1/credits` (account `total_credits − total_usage`)
versus `Σ limit_remaining` across wallets. If the account cannot cover what
users have already paid for, alert the operator with both numbers. This is the
"check outside yourself" guard: our books can be perfect while the account
that actually pays is empty, and the person who gets the 402 would be one who
paid.

### Config (document in `config.example.toml`)

```toml
# Per-user generation credits. Each DM gets its own provisioned OpenRouter
# key with a spending limit; people top it up through their portal link.
# Groups, the operator, and anyone switched to "house" on the dashboard
# Credits page keep using the global key. Inert until enabled.
[credits]
enabled = false
starter_usd = 0               # free credit on first use; 0 = the first request refuses and sends the link
low_watermark_usd = 1.00      # below this, generations carry a top-up nudge
credit_ratio = 0.90           # generation credit granted per $1 paid (see Money)
min_topup_usd = 5
max_topup_usd = 200
presets_usd = [5, 10, 20]
product_name = "Edmund generation credit"   # the checkout line item; no Stripe catalog setup

[keys]
openrouter_provisioning = ""  # openrouter.ai/settings/provisioning-keys — mints/edits keys, cannot run models
stripe_secret = ""            # sk_live_… / sk_test_…
stripe_webhook_secret = ""    # whsec_… from the endpoint's settings
```

## Money

Two fees sit between a $10 top-up and usable credit:

| step | amount |
|---|---|
| paid by user | $10.00 |
| after Stripe (2.9% + $0.30) | $9.41 |
| OpenRouter credit that $9.41 buys (5.5% purchase fee) | $8.92 |

Ratio ≈ 0.89, so `credit_ratio = 0.90` means the operator absorbs about a cent on
the dollar. At $5 the fixed $0.30 makes the true ratio 0.87; at $20 it is
0.90. `min_topup_usd = 5` keeps the fee share under 10%. If the operator would
rather have this exactly neutral, set 0.87.

## Failure modes designed for

- **Provisioning API down at first generation** → refused, alert. Not the
  house key.
- **Payment before any generation** → the Credits tab creates the wallet on
  view; the webhook also creates it if the row is missing.
- **Webhook redelivered** → `event.id` primary key; second delivery is a 200
  no-op.
- **PATCH fails after payment** → `pending_apply`, retried, alerted.
- **Our `limit` column drifts from OpenRouter** → we never decide from it.
  Remaining balance is always read from OpenRouter; the column is display.
- **Account credit exhausted while users hold balances** → daily alert.
- **Someone forges a webhook** → signature required; unset secret rejects
  everything.
- **Someone tampers a portal link** → existing HMAC; the Credits routes reuse
  `auth()` unchanged.

## Tests — each written so it can fail, and checked both ways

- Signature: valid passes; wrong secret, altered body, `t` outside 300s,
  missing `v1` all reject; empty configured secret rejects a valid signature.
- Idempotency: the same event id twice applies once.
- Ratio: `amount_total` in cents → credited USD at 0.90 and 0.87, rounding
  to cents, min top-up enforced at checkout creation.
- Resolver table: owner DM → house; other DM → wallet(self); DM with
  `billing_mode = house` → house; group → house; `agent:` → whatever its
  parent resolves to; `mirror:` → house; SMS DM shares the iMessage wallet
  for the same normalized handle.
- Override: flipping a wallet to `house` and back changes which key the
  next generation uses (assert on the request header), and a manual grant
  lands as a PATCH of `limit` plus one `credit_payments` row.
- Charging: with a stubbed `fetch`, a `402` produces a result containing the
  portal URL and no retry; a balance under the watermark produces the `LOW`
  block and one above it does not; a video whose estimate exceeds
  `limit_remaining` is refused before any `/videos` call.
- Fail closed: provisioning `fetch` throwing yields a refusal, not a house-key
  call (assert the house key never appears in any request header).

## Rollout

1. Land with `enabled = false`. Nothing changes for anyone.
2. The operator: create a Provisioning key; add the tunnel hostname; set
   `external_url`; register the webhook at
   `https://edmund.example.com/pay/stripe` for
   `checkout.session.completed` and `charge.refunded`. (No Stripe catalog
   work — checkout prices the line item inline.)
3. Stripe **test mode** first: `stripe listen --forward-to
   127.0.0.1:4749/pay/stripe`, pay with a test card from the portal, confirm
   the key's `limit` moved on OpenRouter (the system of record), not just
   that our row says `applied`.
4. Enable. Before the first friend hits it, flip anyone who should keep the
   global key to `house` on the Credits page. Watch the first week's
   `credit_payments` and the daily alert. The heavy users identified above
   will hit the refusal on their next generation and get the link.

## Decisions (made by the operator, 2026-09-02)

1. **Payment rail: Stripe Checkout.** Alternatives considered and set aside:
   a static Payment Link (no per-user presets), manual Venmo/Zelle plus a
   dashboard button (zero fees, but the operator acts on every top-up), and OAuth
   PKCE against each person's own OpenRouter account (zero liability, heavy
   onboarding).
2. **Groups stay on the house key.** DMs only.
3. **Starter grant: $0.** Pay first.
4. **Per-person override.** Any DM can be switched to the global key and
   back from the dashboard or CLI; individual wallets are editable there too.
5. **Credit ratio: 0.90** as proposed (the operator absorbs about 1%).

## Out of scope for v1

- Per-person attribution inside groups (needs the sender handle plumbed into
  the tool process; the `EDMUND_SENDER_HANDLE` env var is read in two places
  and set in none).
- Automatic refund handling.
- Charging inbound transcription or video understanding.
- Subscriptions, auto-top-up, or any recurring billing.
