# edmund-harness dashboard

Local, LAN-reachable, PIN-gated web UI for the iMessage assistant daemon.

## Layout

- `server/` — Bun + Hono HTTP server. Reads the harness's existing SQLite stores
  (`data/state.db`, `data/cron.db`, `data/agents.db`) and `data/daemon.log`.
  Writes config changes back through the same ConfigSchema the daemon uses.
- `web/` — React + Vite SPA. TanStack Query for server state, React Router for
  routing, Tailwind for styles, Radix primitives for dialogs/tabs/toasts.

## First-run

```
bun run dashboard:set-pin 1234
bun run dashboard:dev          # dev: Vite HMR + bun --watch server
# or
bun run dashboard:prod         # prod: vite build + serve from server
```

Then point a browser at `http://<this-mac>:4747`.

## Config

Everything is in `[dashboard]` in the repo's `config.toml`:

```toml
[dashboard]
port = 4747
bind = "0.0.0.0"      # "127.0.0.1" to disable LAN
pin_hash = "…"         # set via dashboard:set-pin
session_days = 30
```
