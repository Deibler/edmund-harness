# Troubleshooting

Headings are symptoms. Each one names where to look and what it has meant
before.

## It boots but never replies

1. `[allowlist].dm` does not include the sender, or `groups` does not include
   the chat GUID. An allowlisted group also needs a mention of one of
   `[identity].names`.
2. The boot line says `NO PERSONA LOADED`. Copy `persona.example` to
   `persona`.
3. The sender is one of `[self].handles`. The daemon ignores its own account.
4. `edmund logs --session <handle>` shows the message was seen but no turn
   started. Look for a gate line that says why.

## Sends report success but never arrive

Look for `chat_mismatch`, `chat_poisoned`, `self_route` or `misdelivery` in
the log. On macOS 26, IMCore can relabel a chat with the account's own address
so a send lands in the note to self thread while reporting success. The
daemon detects this from `chat.db`, refuses further sends to that chat, and
relaunches Messages to rebuild the registry. Do not relax the guard. Check
`chat.db` for where the message actually landed before retrying anything.

## The bridge will not load

The supervisor logs that the dylib could not be loaded. In order: SIP is on
(`csrutil status`), the boot argument is missing (`nvram boot-args`), or the
dylib was not actually rebuilt. `make -C native` in the bridge repository
sometimes only re-signs the old binary; `touch native/src/*.m` first and look
for a `clang` line in the output. A rebuilt dylib loads on the next Messages
launch.

## Messages relaunches every thirty seconds

Something injected into Messages is crashing it, and the supervisor keeps
bringing it back. Look in the macOS log with `/usr/bin/log show --predicate
'process == "Messages"' --last 5m`. A diagnostic that enumerates Objective-C
classes at runtime is a known cause.

## Every other message goes to the wrong person

This was the macOS 26 recipient adjustment bug. It is fixed in the bridge by
dispatching sends through the chat registry. If you see it again after an OS
update, the same method has probably changed. The fix was found by diffing the
system log between a bridge send and a hand typed one from the same starting
state.

## Delivered receipts arrive minutes late, or inbound stops

This is Apple's push registration going stale after `imagent` churn. It is
not the harness and it is never fixed by restarting `imagent`; that makes it
worse. It clears on its own. If you restarted `imagent` by hand, stop.

## `log show` returns nothing

A shell function may be shadowing `log`. Use `/usr/bin/log`. Keep the window
short; multi hour queries hang.

## Replies stall for minutes after a long conversation

A compaction used to run before delivery and block the reply. It is now
deferred until after the send. If you see the stall, check that the deferred
path is still in place and that the session lock is being released.

## The model answered itself

A handle came through with IMCore's `e:` or `p:` type prefix and was not
normalised, so the bot's own message looked like a new sender. Session keys
strip the prefix; if you wrote a new path that computes a key, use
`sessionKeyFor` rather than building the string.

## Outbound messages look empty in a query

The text is in `attributedBody`, not `text`. Use the decoder in
`src/imessage/decode.ts`. An ad hoc parser returns empty on rich text bodies
and makes a delivered message look unsent.

## A sub-agent was killed as stuck

The reaper marks any long running agent that has not written output as stuck.
It is not media specific. Agents should write incrementally to their result
file. The agent log survives under `sandbox/<slug>/agents/<id>/`.

## Tests fail that I did not touch

Compare the failing set against the known flaky list in `CLAUDE.md`, not the
count. The baseline varies between runs with unchanged code. Run `bun test
tests/`, not bare `bun test`, or you pick up a vendored package's specs.

## A code change did not take effect

For the daemon: it is running under launchd and you edited files without
restarting. For the bridge: see above; the build may not have compiled. For
the dashboard or portal: the built assets are stale until you rebuild. For a
skill: no restart is needed, but the model has to read it; check the log for
`read_skill`.

## The dashboard says the web assets are not built

`cd dashboard/web && bun install && cd ../.. && bun run dashboard:build`. The
portal has the same shape with `dashboard/user-web` and `portal:build`, and
falls back to a server rendered page until built.

## Generation was refused

The person's wallet cannot cover it. The refusal message includes their portal
link. `edmund credits show <handle>` shows the live balance from OpenRouter and
payments from Stripe.

## The webhook never arrived

For Stripe, check the endpoint's URL matches `[dashboard].external_url` plus
`/pay/stripe` and that `keys.stripe_webhook_secret` is set. The design does not
depend on the webhook; balances are synced on every portal open and every
generation. For Twilio, `public_base_url` must match the configured webhook
URL exactly or every signature check fails.

## Local speech is very slow under launchd

`ProcessType Background` pins the daemon to efficiency cores. Run in the
foreground to confirm, then change the plist template.
