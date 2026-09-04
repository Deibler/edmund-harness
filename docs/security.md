# Security and privacy

A model with tools, reading a private message store, sending as you. This page
is what that means and what the project does about it.

## Threat model

**Who can talk to it.** Anyone on `[allowlist].dm`, anyone in an allowlisted
group who mentions it, and, if guest access is on, anyone who includes a
campaign key or shares a registered group with it. An empty allowlist admits
nobody unless `[security].open_dm_allowlist` says otherwise. That section is
the single most important part of the config.

**What they can make it do.** Inbound messages are untrusted input to a model
that has tools. The model can send messages to other people, read the
conversation's history, write memory, generate media that costs money, run
scripts in its sandbox, fetch URLs and schedule its own future wakeups. Prompt
injection through a message is a real attack, and the mitigations below are
structural rather than instructional wherever possible.

**What it can reach on the Mac.** That depends on `[security].model_host_access`.
Under `sandboxed`, the default, the worker has no shell and no file tools at
all: Claude Code's Bash, Read, Write, Edit, Glob and Grep are disallowed at
spawn, Codex keeps its own sandbox, the worker's environment is an allowlist
rather than the daemon's, and model authored scripts do not run. What the
model can do is exactly the MCP tool list. Under `full`, the worker runs as
your user with bypass permissions and a working directory inside `sandbox/`;
a hook constrains its file writes to that sandbox and the data directory, and
the MCP server refuses paths under `~/.ssh`, the keychains, `state.db` and
`config.toml`. That is a guard, not a jail: the hook reads the shell command
text, and another interpreter or a symlink can get around it. `full` is the
choice of an operator who wants the model to have the run of the machine and
accepts what that means.

## Trust levels

| Tier | Who | Gets |
|---|---|---|
| Operator | `[security].operator_handles`, or `[alerts].operator_handle`; also the mirror, trading and sub-agent surfaces | Every tool |
| Contact | Any other allowlisted handle, and every group, under `contact_tier = "contact"` | Everything that stays inside this conversation. Not: messaging other people or errands, the contact list, cross chat or per person recall scope, writes to `SOUL.md` or domain notes, `memory_search` over every person file, publishing or installing skills |
| Guest | Campaign key or vouched | The conversational surface only |

The reductions are in what is registered, not in a prompt instruction, and a
test pins each set. `contact_tier = "operator"` restores the old behaviour
where every allowlisted contact was the operator.

## Structural mitigations

- **Guests get fewer tools, not a stricter prompt.** A guest session registers
  no memory, history, filesystem, scheduling, agent, skill or integration
  tools and uses a separate MCP config. The reduction cannot be argued away.
- **Consent is enforced where the value is used.** SMS consent is checked in
  the deliverer, so a cron job or a proactive turn cannot text an opted out
  number no matter what the model decides. Skill consent withholds the skill
  body rather than asking the model to please ask first.
- **Money has limits in code.** Generation goes through a per person wallet
  that refuses when the balance cannot cover it. The trading integration's
  position and order limits live in its risk module, not in the persona.
- **Sends are verified against the store.** A send that lands in the wrong
  chat is detected from `chat.db` and treated as a failure, and the bridge
  refuses to send when the resolved chat is not the addressed one.
- **Relays are depth capped.** A message to another person can trigger a turn
  in their session, which can relay again, at most three deep.
- **Outbound fetches are SSRF guarded.** `web_fetch` refuses private and link
  local addresses.
- **The dashboard is PIN gated** with an HMAC signed, SameSite Strict cookie
  that carries `Secure` over TLS. It listens on this Mac only by default,
  throttles login attempts, refuses cross origin mutations, limits request
  bodies before reading them, serves files by real path so a symlink cannot
  escape the sandbox, and never returns exception text to a client.
- **Portal links are per conversation and revocable.** The link is a signed
  token; `edmund portal revoke <handle>` invalidates every link issued so far
  for that person and the next message carries a new one. Erasing a
  conversation from the portal requires typing a word that the server checks.
- **The public listener** serves only the portal, payment and annotation
  routes and answers 404 to everything else.
- **Files are private to your account.** Both processes set a private umask
  and tighten `data/`, `persona/`, `sandbox/`, `config.toml` and `.env` at
  boot.

## Privacy design

- **Recall is per conversation by default, and crossing it is an operator
  capability.** Auto-recall searches this chat's history and, in groups, the
  sender's messages in shared chats. The `semantic_search` tool accepts a
  `global` or `person:` scope, and for a contact tier session those scopes do
  not resolve. The assistant does not answer one person with what another
  told it unless the operator asks it to.
- **Person files are per person.** A DM sees its own file. Groups see the group
  file. Guests see nothing.
- **The persona directory is gitignored** because it fills with real people's
  details. So are `data/`, `sandbox/`, `config.toml` and `.env`.
- **Published skills and announcements are scanned** for names, handles,
  emails and addresses before they leave the conversation that wrote them.
- **Logs redact** values whose key looks like a secret and truncate long
  values.

## What leaves the machine

| Path | Where it goes | When |
|---|---|---|
| Conversation turns | Anthropic or OpenAI, through the CLI you are logged into | Every turn |
| Media generation, transcription, video understanding | OpenRouter, or the provider you configure | When a tool is called or a voice memo arrives |
| Web search | Brave | When the model searches |
| Web fetch | The URL the model chose | When the model fetches |
| Payments | Stripe | When a person tops up credits |
| SMS | Twilio | If the SMS channel is enabled |
| Portal and share pages | Cloudflare tunnel | If you enable a tunnel |
| Embeddings for recall | Nowhere, by default | The default provider runs locally |

Nothing is sent to the project's author. There is no telemetry.

## Secrets

`config.toml` holds API keys and is gitignored. `.env` holds machine local
values and is gitignored. `config.example.toml` is tracked and must contain
only placeholders; check its diff before every push. The dashboard's config
writer backs the file up before each change and masks secrets on read.

Never commit `persona/`, `data/`, `sandbox/`, `campaigns/*.md` other than the
example, or anything under `docs/private/`.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md) at the repository root.
