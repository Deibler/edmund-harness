# Getting started

This is the long version of the install. It assumes a Mac you control, signed
into Messages with the account the assistant will use, and that you have read
[private-api.md](private-api.md) and decided the SIP tradeoff is acceptable.

## 1. Decide which account sends

The assistant sends as whatever account Messages.app is signed into on this
Mac. Most people give it its own Apple ID and its own phone number or email,
so that its messages are not confused with theirs and so that the `[self]`
handles are unambiguous. Running it on your personal account works, but every
message you send from that Mac will look to the daemon like the assistant
speaking.

## 2. Prerequisites

| Requirement | Why | Check |
|---|---|---|
| macOS on Apple Silicon | Only configuration that has been run. Tested on macOS 26. | `sw_vers` |
| Bun 1.2 or newer | Runtime for the daemon, CLI and dashboard | `bun --version` |
| Claude Code or Codex CLI, logged in | The chat brain. Install every provider you configure. Codex 0.147.0 or newer. | `claude --version`, `codex --version` |
| Xcode Command Line Tools | Builds the bridge dylib | `xcode-select -p` |
| Full Disk Access | Reading `chat.db` | System Settings, Privacy and Security |
| SIP off and `amfi_get_out_of_my_way=0x1` | Loading the bridge into Messages.app | `csrutil status`, `nvram boot-args` |
| `ffmpeg` (optional) | Voice memos, video probing and transcoding | `ffmpeg -version` |
| `python3` (optional) | Some skills and the mirror speech sidecar | `python3 --version` |
| `cloudflared` (optional) | Portal, SMS and share tunnels | `cloudflared --version` |

Binaries are found on `PATH`, then in `~/.nvm/versions/node/*/bin`,
`/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`. A few scripts still
hardcode `/opt/homebrew/bin`; if you are not on Homebrew, expect to fix those.

## 3. Build the bridge

```bash
git clone https://github.com/Deibler/imcore-bridge.git
cd imcore-bridge
npm ci
npm run build          # make -C native, then tsc
cd ..
```

The bridge repository's README covers the recovery mode steps for SIP and the
boot argument, and its own verification commands. Two things to know from
experience: `make -C native` sometimes only re-signs an old dylib, so run
`touch native/src/*.m` first and confirm you see a `clang` line; and a rebuilt
dylib takes effect on the next launch of Messages.app, not immediately.

## 4. Install the harness

```bash
git clone https://github.com/Deibler/edmund-harness.git
cd edmund-harness
bun install
cp config.example.toml config.toml
cp -r persona.example persona
```

`package.json` points at `../imcore-bridge` by relative path, so the two
checkouts must be siblings until the bridge is published as a package.

Do not skip the persona copy. `persona/` is gitignored because a real one
fills up with details about real people, and without it the daemon boots and
replies with no identity, no venue rules and no memory. It will not error.

## 5. Configure

Open `config.toml`. Everything has a default except these:

```toml
[self]
handles = ["+15551234567", "you@icloud.com"]

[allowlist]
dm = ["+15557654321", "friend@icloud.com"]
groups = []

[identity]
names = ["claude"]

[owner]
name = ""            # your first name, used as "an AI that <name> built"

[claude]
model = "claude-opus-4-8[1m]"

[security]
model_host_access = "sandboxed"   # "full" lets the model use a shell and your files
contact_tier = "contact"          # "operator" makes every allowlisted contact the operator
open_dm_allowlist = false         # true admits everyone when [allowlist].dm is empty
```

- `[security]` is the trust policy. The defaults keep the model to its own
  tools and keep contacts inside their own conversation. Loosen a line when
  you know why. [security.md](security.md) explains each one.
- `[self].handles` are the addresses of the account the assistant sends from.
  Anything from them is ignored so it never answers itself.
- `[allowlist].dm` is who may DM it. An empty list admits nobody unless
  `[security].open_dm_allowlist` is on. `groups` takes chat GUIDs; the
  dashboard's Sessions page shows them once messages have arrived.
- `[identity].names` are how it is addressed in groups. `IDENTITY.md` should
  use one of them.
- `[claude].model` selects the provider by name. `gpt-*`, `o*` and `codex-*`
  go to Codex CLI; everything else goes to Claude Code. The section is called
  `[claude]` for historical reasons and applies to both.

Then edit `persona/IDENTITY.md`. Keep it to a page; it is read on every turn.

The rest of `config.toml` is documented inline and in
[configuration.md](configuration.md). Leave it alone for the first run.

## 6. First run

```bash
bun run dev
```

Watch for the boot banner. The line you want contains
`[loadout] persona=3/3`. If it contains `NO PERSONA LOADED`, step 4 was
skipped. If it warns `claude CLI not found`, fix your PATH.

On first run macOS will prompt for Full Disk Access for the terminal. Grant it
and start again. The daemon then reads the current end of `chat.db` and waits.

Send a message from an allowlisted number. In the log you should see the
watcher pick it up, a session key of the form `imessage:dm:+1555...`, a turn
start, a model call, and a send followed by a verification line. The reply
should arrive in Messages. On the first send macOS asks for Automation
permission for Messages.app.

If nothing happens, run `edmund logs --session +1555...` with the sender's
number and read from the bottom.

## 7. Run it as a service

```bash
./bin/edmund install     # symlink onto PATH
edmund start             # user LaunchAgent, starts at login, restarts on crash
edmund status
edmund logs --follow
```

Because launchd runs `bun` directly, Full Disk Access must also be granted to
`bun` itself, not just to your terminal. The first launchd start will prompt
for it.

The service is a user agent, not a system daemon. It starts when you log in,
it runs as you, and it stops when you log out unless you configure the Mac to
stay logged in.

## 8. Optional pieces

- **Dashboard**: `cd dashboard/web && bun install && cd ../.. && bun run
  dashboard:build`, set a PIN with `edmund dashboard --pin 1234`, then
  `edmund start --dashboard`. It listens on this Mac only; set
  `[dashboard].bind = "0.0.0.0"` to reach it from your LAN. See
  [dashboard.md](dashboard.md).
- **User portal**: `cd dashboard/user-web && bun install`, then
  `bun run portal:build` and `edmund restart --dashboard`. Links reach people
  through `get_portal_link` and at the bottom of proactive messages.
- **Proactive outreach**: set `[brown_nose].enabled = true` and read
  [proactive.md](proactive.md) first.
- **Media generation**: put an OpenRouter key in `[keys].openrouter`. For
  per person billing, see [generation-credits.md](generation-credits.md).
- **SMS**: [sms-channel.md](sms-channel.md).
- **Integrations**: edit `integrations/integrations-config.yaml`. Most of the
  shipped ones need hardware or services you do not have; turn them off or
  delete them.

## 9. Back it up

Everything that matters and is not in git: `config.toml`, `.env`, `persona/`,
`data/`, `sandbox/`. Copy them somewhere. `git revert` cannot undo a change to
any of them.
