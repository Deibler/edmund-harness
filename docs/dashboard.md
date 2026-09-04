# The dashboard

A separate process that serves two things: a PIN gated operator UI, and the
per person portal described in [user-portal.md](user-portal.md).

## Running it

```bash
cd dashboard/web && bun install && cd ../..
bun run dashboard:build
edmund dashboard --pin 1234
edmund start --dashboard
```

It listens on `[dashboard].port` (4747) bound to `[dashboard].bind`, which is
this Mac only by default; `0.0.0.0` makes it reachable from your LAN. Login
attempts are throttled per client, the cookie is SameSite Strict, mutating
requests must come from the dashboard's own origin, and request bodies are
capped before they are read. A second
loopback listener on `[dashboard].public_port` (4749) serves only the portal,
payment and annotation routes and answers 404 to everything else; that is the
one a tunnel should point at.

## Auth

The PIN is hashed with argon2 into `[dashboard].pin_hash`. A successful login
sets an HMAC signed cookie whose secret is generated into
`data/dashboard.secret` on first run. Every `/api/*` route except login checks
it. The portal and payment routes use signed tokens instead and never see the
PIN.

## Pages

| Page | What it shows or does |
|---|---|
| Overview | Spend rollups, recent turns, activity |
| Sessions | Every conversation, detail, reset |
| Credits | Every conversation's live balance and payments, wallet versus house toggle, grant, sync, pause |
| Cron | Scheduled and one-shot jobs, create and delete |
| Agents, Bg jobs | Sub-agents and background tool jobs, with logs and results |
| Brown nose | Proactive state per session: queued fires, hours, enable, disable, invoke |
| Recall | Index stats, reindex |
| People | Maintainer state |
| Annotate | Image annotation links and revocation |
| Media | Generated and received media by session |
| Logs | Live tail over server sent events |
| Orchestrator | Model per subsystem, named orchestrators, persona file editor |
| Recovery | Stuck sessions, sweep, per session reset |
| Alerts | Operator alerts, mute and unmute |
| Skills | Installed skills, approve, disable, delete |
| Daemon | launchd control, debug toggle, worker pool state and flush |
| Settings | Every config section, validated on save, secrets masked |
| Contacts | The `[[contacts]]` table |
| Models | Model picker from the OpenRouter catalog |

Settings writes go through a validator, back up `config.toml` with a
timestamp, and rename atomically. The writer drops inline TOML comments,
which is the one reason to keep a hand edited copy.

## How it talks to the daemon

Both processes open the same SQLite files. For actions, the dashboard drops a
sentinel file in `data/` (`pool-flush.kick`, `people-maintainer.kick`,
`recall-reindex.kick`, `recovery-sweep.kick`) and the daemon acts within a few
seconds. Daemon control shells out to the same `service.sh` the CLI uses.
Worker pool state comes from `data/pool-stats.json`, rewritten every five
seconds.

## Exposing it

The full dashboard should stay on your LAN. `scripts/dashboard-tunnel.sh up`
opens a temporary Cloudflare tunnel to it for remote use and expires it. The
portal is designed to be public and has its own named tunnel setup in
`scripts/setup-portal-tunnel.sh`.

## Development

`bun run dashboard:dev` runs the server with reload and Vite on 5173.
`bun run portal:dev` runs Vite on 5174 proxying to the portal listener. Neither
front end is part of the root install; each has its own `package.json` and
lockfile.
