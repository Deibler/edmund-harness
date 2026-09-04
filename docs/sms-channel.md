# SMS channel (Twilio) — design + activation runbook

Built 2026-08-30. Code is fully wired and tested; the channel is INERT until
`[sms].enabled = true` — no port binds, no deliverer registers, no money.

## What it is

Edmund's second identity: a real phone number, +1 (555) 010-0000, for people
without iMessage — including green-bubble group texts. Routing is decided by
the room, so nothing existing changes:

| room                        | Edmund's address        | path            |
|-----------------------------|-------------------------|-----------------|
| DM over iMessage            | bot@example.com | chat.db (as today) |
| group, all iMessage         | bot@example.com | chat.db (as today) |
| DM over SMS                 | (555) 010-0000          | Twilio Messages |
| group with any SMS member   | (555) 010-0000          | Twilio Conversations (group MMS) |

A message physically arrives on exactly one transport; the arrival path IS
the router. To keep an all-iMessage group blue, people must add Edmund by his
EMAIL — adding the phone number makes any group green by SMS's nature.

## Architecture (mirror pattern, second use)

- `src/sms/session.ts`   — `sms:dm:<handle>` / `sms:group:<CHsid>` namespaces
- `src/sms/segment.ts`   — GSM-7/UCS-2 cost model + URL-safe chunking
- `src/sms/signature.ts` — X-Twilio-Signature validation (fail closed)
- `src/sms/store.ts`     — transcript (chat.db knows nothing), consent,
                           group rosters, webhook idempotency; in state.db
- `src/sms/client.ts`    — Messages + Conversations REST, typed errors
- `src/sms/channel.ts`   — admission gate, keywords, deliverer, enqueue
- `src/sms/server.ts`    — loopback webhook listener (:4790)
- `src/sms/twilio-config.ts` — idempotent Twilio webhook config (applies
                           public_base_url at boot; would also self-heal a
                           rotating quick tunnel if the named one ever went)
- Seams: `deliverReply` sms branch; `Deps.sms` history/roster providers;
  `isGroupSession`/`chatIdFromKey` know sms keys; envelope `[SMS · …]`
  header + channel-reality note; typing suppressed.

## Safety posture

- **Admission**: strangers are ignored by default. Empty allowlist admits
  only numbers the contact book can name; `allow_unknown_senders = true` is
  the deliberate override. (SMS sessions live OUTSIDE the guest-tier
  machinery — this gate is the door.)
- **Consent**: STOP/START tracked locally per person and enforced in OUR
  send path (Twilio's Advanced Opt-Out is their copy, not a guard on ours).
  A 21610 send error records the opt-out. Group "Stop" is conversation, not
  a carrier opt-out.
- **Webhooks**: signature-validated against the CURRENT tunnel URL; no
  token or URL ⇒ every request rejected. Retries dedup on MessageSid.
- **Cost**: replies normalized to GSM-7, chunked to ≤3 segments × ≤3 parts;
  beyond that truncated rather than flooding. Full URLs only (shorteners
  are carrier-filtered).

## Activation (when the A2P campaign is APPROVED)

1. `.env` — replace with the clean shape (all four):
   `TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
   `TWILIO_API_KEY_SID=SK…` `TWILIO_API_KEY_SECRET=…`
   `TWILIO_AUTH_TOKEN=…` ← the REAL auth token (Console → Account → API
   keys & tokens). Without it every inbound webhook is rejected (by design).
2. Tunnel: ALREADY STANDING (done 2026-08-31). Named tunnel `edmund-sms`
   (<tunnel-uuid>) runs under
   com.edmund-harness.sms-tunnel; https://sms.example.com maps to
   127.0.0.1:4790, verified end-to-end (200 with a listener, 502 without,
   catch-all 404). Token: data/sms-tunnel-token (600). Expect 502 until the
   daemon starts its listener; 530/1033 would mean the tunnel itself is down.
3. `config.toml` → `[sms] enabled = true`.
4. Restart the daemon. Boot log should show `[sms] webhook listener on
   127.0.0.1:4790` and, within a minute, `twilio webhooks pointed at tunnel`.
5. Prove the round trip from a real non-iPhone: text the number, watch the
   reply, and verify the transcript rows in state.db (`sms_messages`).
   Sample size one proves plumbing, not the channel — keep watching.

## Known limitations (deliberate)

- MMS media inbound is acknowledged in-transcript but not fetched.
- No delivery-receipt persistence yet (failures are logged from /sms/status).
- Same person on iMessage AND SMS = two separate sessions by design.
- Sole-prop campaign: ≤1 msg/sec, one number, T-Mobile daily caps.
