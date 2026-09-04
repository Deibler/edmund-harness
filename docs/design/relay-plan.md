# Cross-session message relay

> Historical design record. Written before or while the subsystem was built and kept because it explains why the shipped design looks the way it does. Where it disagrees with the code, the code is right.

Lets a session-bot in conversation A text a contact in conversation B
without bot-A and bot-B sharing context. Each side believes it is talking
directly to the human; the harness routes the message through the
recipient's session as a synthetic inbound, so the recipient's session-bot
is the one that actually decides what to say back to its human.

This avoids a known cross-context failure mode: bot-A texts Casey, Casey's
reply lands in bot-B (Casey's session), bot-B has no context for the original
ask and looks confused.

## Tools (MCP, exposed to the model)

### `list_contacts`

No args. Returns a text payload with two sections:

- **DMs** — every existing DM session Edmund has with someone. Each entry:
  `<display name> — <phone>[, <email>] — last interaction <relative ts>`.
- **Group chats** — only groups where the **calling user** AND Edmund are
  both participants. Each entry: `<group_chat_id> · <display name or "(unnamed)">
   — participants: <name1>, <name2>, ... — last interaction <relative ts>`.

Filtering is by chat.db participant rows, not by allowlist. A group Edmund
is in but the calling user is not is excluded — privacy.

### `message_contact`

(Renamed from `send_message` — the existing `send_message` tool already
ships a mid-turn "on it" heads-up sender that targets the current session
owner. Two tools cannot share a name in the MCP registry.)

```
message_contact({
  message: string,                    // what to convey
  additional_context?: string,        // why; passed to the receiver bot
  is_group_chat: boolean,             // explicit confirmation flag
  phone_number?: string,              // present iff is_group_chat=false
  group_chat_id?: string,             // present iff is_group_chat=true
})
```

Validation, in order:

1. `is_group_chat` ⊕ presence: `is_group_chat=true` requires `group_chat_id`
   and forbids `phone_number`. `is_group_chat=false` requires `phone_number`
   and forbids `group_chat_id`. Mismatch → tool error before any routing.
2. **Outbound mode gate** (`config.outbound.mode`):
   - `"*"` — DM and group both allowed.
   - `"dm_only"` — group target rejected.
   - `"groupchat_only"` — DM target rejected.
   - absent — tool errors with "outbound relay disabled".
3. **Target observability**:
   - DM: phone normalizes to a handle that exists in chat.db (anywhere it
     has appeared as sender or recipient). If not, error
     "no message history with that number".
   - Group: `group_chat_id` exists as a `chat.guid` in chat.db, and the
     calling sender's handle is among that group's participants. If the
     sender is not a participant, error "you are not in that group chat"
     (the privacy rule from `list_contacts` enforced again at send-time).
4. **Loop guard**: relay envelopes include a `[depth=N]` token. If the
   currently-firing inbound's envelope has `depth ≥ MAX_RELAY_DEPTH (3)`,
   refuse — prevents A↔B ping-pong runaway.

On success: enqueue a one-shot cron job for the **target session** with a
synthetic `systemEvent` (see envelope below). The existing `cron/fire.ts`
pipeline picks it up under the target session's lock and runs `claude -p`
exactly as it would for any other event. The receiving bot's natural reply
flows to its own session owner via the standard outbound path.

If a DM target was observed in chat.db but has no `sessions` row yet
(e.g. Casey was only ever in a group with Jordan, never DM'd Edmund), the
relay creates the DM session record on the fly so the cron fire has
something to bind to. The Claude session UUID is left null — the receiving
turn will cold-start.

## Envelope (what the target session sees)

```
[Relay from <originator display name> · depth=<N>]

<originator display name> asked you to pass this along:
  "<message>"

Additional context they shared: <additional_context, if any>

How to respond:
- If you have something to convey to your conversation partner about this,
  reply naturally — your text will be sent to them via iMessage as usual.
- If you want to send a response back to <originator display name>, call
  message_contact targeting their phone or group; they will see your reply.
```

The receiving bot is told the message is a relay. That is intentional —
without that framing, an inbound "from Jordan" inside Casey's session
contradicts the session's normal "I am talking to Casey" model and produces
confusion. The `bots shouldn't know` rule from the spec applies to the
**sender** side only: the sender bot calls `message_contact` and believes
it is texting the contact directly.

## Files

| Path | Change |
| --- | --- |
| `src/config/config.ts` | Add `outbound: { mode: "*"\|"dm_only"\|"groupchat_only" \| undefined }` (omitted = disabled). |
| `config.example.toml` | Document the new section. |
| `src/bridge/relay.ts` | New. Target resolution + envelope build + cron-job creation + depth parse/check. Pure functions where possible for unit-testability. |
| `src/sessions/contacts.ts` | Add `allKnownContacts()` returning `[{canon, name?, handles[]}]` so list_contacts can show name+phone+email. |
| `src/imessage/participants.ts` | Add `chatsForHandle(chatDb, handle)` (groups containing this handle) and `handleExists(chatDb, handle)`. |
| `src/mcp/tools/contacts.ts` | New. `list_contacts` and `message_contact`. |
| `src/mcp/server.ts` | Register `contactsTools(ctx)`. |
| `src/main.ts` / `src/cron/fire.ts` | Existing cron-fire path is reused unchanged — the relay synthetic inbound is just a one-shot cron event. No edits needed here. |
| `tests/relay.test.ts` | Unit tests (see below). |
| `package.json` | Add `"test": "bun test"` script. |

## Tests (`bun test`)

Pure-function units only — no spawning Claude:

- `is_group_chat` XOR validation: rejects when phone+group both set,
  rejects when neither set, rejects when `is_group_chat=true` but only
  phone given, etc.
- Outbound-mode gate: each of `*` / `dm_only` / `groupchat_only` /
  `undefined` against each of dm-target / group-target.
- DM target observability: handle missing from chat.db → error;
  handle present → ok.
- Group target observability + sender membership: sender not in group →
  error; sender in group → ok.
- Envelope round-trip: build envelope at depth N, parse depth back out,
  refuse when ≥ MAX_RELAY_DEPTH.
- Phone normalization: input variants ("(555) 010-0001", "+15550100001",
  "5550100001") all collapse to the same canonical handle.

Tests use an in-memory `bun:sqlite` chat.db with a tiny schema fixture so
they don't depend on the real Messages.app database.

## Out of scope (for this PR)

- Outbound to numbers/emails not seen anywhere in chat.db
  (the previously-discussed `allow_new_numbers` / whitelist, removed per
  user's latest direction).
- Attachment relay — initial cut is text only. Adding image/audio relay
  is straightforward (fold the path into the cron's `attachImages`) but
  not part of this scope.
- Cross-session memory leak audit — relay framing intentionally exposes
  only `message` and `additional_context` to the receiver, never history.
