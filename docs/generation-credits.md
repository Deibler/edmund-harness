# Generation credits — design + activation runbook

Built 2026-09-02. Code is wired and tested; the feature is INERT until
`[credits].enabled = true` — until then every generation runs on
`keys.openrouter` exactly as before. Design rationale and the measured
numbers behind it: docs/design/generation-credits-plan.md.

## What it is

Images, videos and audio Edmund generates are billed to OpenRouter. Each
DM now gets its own OpenRouter key, minted under the operator's account with a
spending `limit` equal to what that person has paid in. When the balance
is gone the generation tool refuses, tells the model why, and hands it the
person's portal link; the Credits tab there takes a card payment (Stripe
Checkout) and the webhook raises that key's limit. OpenRouter enforces the
ceiling and keeps the ledger — nothing here estimates a cost.

| who                                        | pays with        |
|--------------------------------------------|------------------|
| a DM (iMessage or SMS, same handle → same wallet) | their own wallet |
| the operator (`alerts.operator_handle`)     | global key, unless flipped to "own wallet" on the Credits page to test |
| a DM switched to "global key" on the dashboard | global key    |
| groups, mirror, orchestrators, trading      | global key       |
| a spawned agent                             | whatever its parent pays with |

Only `generate_image` / `generate_video` / `generate_audio` are charged.
Inbound transcription, `analyze_video` and the `list_*_models` lookups stay
on the global key.

## Architecture — no local ledger

OpenRouter and Stripe are the systems of record and are read live every
time a page opens or Edmund is about to generate. Nothing about money is
bookkept in state.db (decided 2026-09-02 after the first live top-up sat at
Stripe unseen because its webhook never arrived).

- `src/credits/resolve.ts`   — the ONE place "who pays" is decided (pure, injected lookups)
- `src/credits/store.ts`     — only what neither provider can tell us: session → minted key
                               (+ hash), the per-person `billing_mode` override, and
                               `credit_events` (paywall REFUSALS only — our act, which
                               neither provider saw; nothing is written about a
                               generation that went through)
- `src/credits/analytics.ts` — OpenRouter's record of what a key did:
                               `POST /analytics/query` filtered by the key's hash with the
                               `generation_id` dimension (one row per generation, hour
                               granularity, 30-day windows) and `GET /generation?id=` for
                               the exact time and cost. Verified live 2026-09-02
- `src/credits/openrouter-keys.ts` — Management API (create/get/patch) + `GET /key`, `GET /credits`
- `src/credits/ledger.ts`    — Stripe: PaymentIntents searched by `metadata.session_key`,
                               subtotal (pre-tax) from the Checkout Session, receipt/invoice links
- `src/credits/sync.ts`      — the one reconciliation: `target = starter + Σ credited (Stripe)`;
                               if target > the key's limit → PATCH. Never lowers. Operator gifts
                               are direct raises of the limit (`grantDirect`)
- `src/credits/activity.ts`  — the statement: OpenRouter's generations (analytics.ts),
                               Stripe's payments, our refusals, sorted, with the balance
                               after each line worked BACK from OpenRouter's current
                               `limit_remaining`. Nothing stored; hand-added credit shows
                               as an opening line dated at the key
- `src/credits/billing.ts`   — `beginCharge()`: resolve → mint → **sync** → pre-flight → refuse
                               or generate; all model-facing refusal text lives here
- `src/credits/liability.ts` + `maintenance.ts` — the daemon's daily account-cover alert
- `dashboard/server/routes/pay.ts` — `POST /pay/stripe`: signature check, then a TRIGGER only —
                               retrieve the session from Stripe, sync, wake the chat
- `dashboard/server/services/portalCredits.ts` — the portal's Credits data (all live)
- `dashboard/server/services/creditsOverview.ts` + `routes/credits.ts` — operator page, live per row
- `cli/commands/credits.ts`  — `edmund credits list | show | mode | grant | sync | pause | resume | liability`

## Money

Stripe keeps 2.9% + $0.30; OpenRouter charges 5.5% to buy credit. $10 paid
≈ $8.92 of generation. `credit_ratio = 0.90` → the operator absorbs about 1¢ on
the dollar; 0.87 is neutral. `min_topup_usd = 5` keeps the fixed fee under
10%.

## Activation — state as of 2026-09-02

Everything is on, in LIVE mode:

| piece | state |
|---|---|
| OpenRouter management key (they renamed "provisioning" → "management") | in `keys.openrouter_provisioning`; verified it lists the account's 5 keys |
| Stripe product `Edmund generation credit` | live `prod_xxxxxxxxxxxxxx` (created via Stripe MCP); `[credits].stripe_product_id`. Tax code `txcd_10105001` (AI as a Service, personal use) — the account is on Stripe **Managed Payments**, which refuses any line item whose product has no eligible tax code; the first live checkout failed exactly that way on 2026-09-02. `[credits].stripe_tax_code` covers the inline-product path too. |
| Stripe webhook endpoint | live `we_xxxxxxxxxxxxxxxxxxxxxxxx` (CLI-created; the MCP-created one was deleted after signature mismatches) → `https://edmund.example.com/pay/stripe`, events `checkout.session.completed` + `charge.refunded`; secret in `keys.stripe_webhook_secret`. A trigger only — see Architecture |
| Stable hostname | `edmund.example.com` added to the `<named-tunnel>` named tunnel's ingress (→ `localhost:4749`) + proxied CNAME, via the Cloudflare API; the SMS rule untouched and re-verified |
| `[dashboard].external_url` | `https://edmund.example.com` — every portal link is now permanent |
| Stripe keys | `sk_live_` / `pk_live_` in config.toml |
| `[credits].enabled` | **true** since 2026-09-02 ~15:10 UTC |

Verified live: `robots.txt` answers through the tunnel; a webhook POST with a
valid live-secret signature is accepted (an unpaid session is correctly not
recorded), a forged signature and a 15-minute-old replay are both 400; a
CLI grant to a throwaway handle minted a real key with the management key,
PATCHed its limit to $0.50, and OpenRouter reported that limit back — then
the key and rows were deleted.

Remaining, in order:

1. **There is no test mode any more.** `stripe trigger` only works with test
   keys, so the first real top-up is the end-to-end test. The operator's own DM is
   on the global key by default, but the Credits page lets him flip his own
   row to "own wallet (test as a user)": ask Edmund for an image → refusal +
   link → Credits tab → Add $5 → pay. Then `edmund credits show <handle>`
   must read `limit 4.50` live from OpenRouter, and the chat gets the
   "[CREDITS] … added $4.50" wake-up. Flip back to "global key" afterwards.
2. **Pre-flight the people**: on the dashboard Credits page (or `edmund
   credits mode <handle> house`) switch anyone who should stay on the global
   key BEFORE enabling. The two heaviest DMs will hit the refusal on their
   next generation.
3. Done: `[credits].enabled = true`, daemon and dashboard restarted. Watch
   `edmund credits list` and `edmund credits liability` for the first week.
4. When the quick portal tunnel (`run-portal-tunnel.sh`) is no longer
   wanted, unload it — `external_url` takes precedence over it already.

## Day to day

- Portal (user side) Credits tab, all read live on open: balance from
  OpenRouter; **Transactions** from Stripe with a Receipt link and an
  Invoice PDF download per payment; **Activity**: a statement table (date and
  time, activity + model, cost, balance after) of every generation from
  OpenRouter's analytics for that key, every payment, and every refusal,
  with filters and a CSV export. Fetched separately from `/data`
  (`GET …/credits/activity`, ~1.5 s) so the page renders first. A time shown
  as "about 4 PM" is OpenRouter's hour bucket — the exact record is read for
  the newest 40 generations only.
- Dashboard → Activity → Credits: every known conversation, live per row
  (remaining/spent from OpenRouter, paid/credited from Stripe, "gift" =
  limit above payments), paywall hits, receipts; mode toggle, Grant (direct
  raise), Sync (make the limit catch up now), Pause/Resume.
- `edmund credits list | show <handle> | mode <handle> wallet|house | grant
  <handle> <usd> | sync <handle> | pause <handle> | resume <handle> |
  liability`.
- Logs: `[credits] …` in daemon.log, `[pay] …` / `[credits] …` in
  dashboard.log. A rejected webhook logs its reason (`mismatch`, `stale`,
  `no-header`) — never the body or the secret.

## The 2026-09-02 incident, for the record

The operator's first live top-up: Stripe marked the session paid; the
`checkout.session.completed` delivery never produced a 2xx (the event still
showed `pending_webhooks`). Two resends reached the dashboard and were
rejected as signature mismatches; later resends did not arrive at all. The
webhook endpoint created through the Stripe MCP was replaced by one created
with the Stripe CLI (secret known for certain), Cloudflare was told to skip
challenges on the webhook path, and — the actual fix — the design stopped
depending on webhooks: the payment was picked up by reading Stripe directly
and the limit raised to $4.50 on the next sweep. That read-on-open model is
now the only model.

## Known loose ends

- **Refunds are manual.** `charge.refunded` is logged; the operator lowers the
  wallet's limit by hand (floor at its usage). Automate once one happens.
- **Webhook deliveries are still not confirmed end to end** (see incident);
  the system no longer needs them, but the "[CREDITS] added…" wake-up only
  fires when one lands. Check `pending_webhooks` on a recent event with
  `stripe events list --type checkout.session.completed`.
- **The applied wake-up targets the iMessage DM session.** An SMS-only
  person shares the wallet but their conversation lives under `sms:dm:`; the
  wake-up would fire into an iMessage session that may not exist. Fine for
  the iMessage friend group; fix if an SMS user ever pays.
- **Per-person attribution in groups** would need the sender handle plumbed
  into the tool process (`EDMUND_SENDER_HANDLE` is read in two places and
  set in none). Groups stay on the global key by decision.
- **`stripe_publishable`** is accepted in config but unused: hosted Checkout
  needs only the secret key.
