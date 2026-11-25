---
"edmund-harness": minor
---

Logs move to `logs/` at the top of the checkout, and the data folder is grouped. **Upgrading needs one command, with the services stopped.**

- **`logs/`** holds every log and nothing else: `daemon.log` and `dashboard.log`, the channels, earlier days, `services/` for what launchd and the tunnel scripts capture, and the archive (`[paths] logs_dir`). Nothing in `data/` is a log.
- **`data/`** has no loose files: databases in `db/`, files rewritten at every start in `run/` (generated MCP configs, sockets, status files, tunnel addresses), tokens and certificates in `secrets/`, small durable files in `state/`, and one folder for each feature that keeps files. A deployment's folder went from 116 entries at the top to under twenty.
- **To upgrade:** stop every service (`edmund stop`, and the kitchen host if it runs), then `edmund data migrate` to see the moves and `edmund data migrate --apply` to make them, then `scripts/launchd/service.sh install` for each agent so launchd writes its captures to `logs/services/`. The migration is renames on one disk, overwrites nothing, stops before moving anything if a database is open, and can be run again.
- The daemon, the dashboard and the public router refuse to start on a folder still in the old layout, and say so: opening the databases where they now belong would start from empty ones beside the real ones.
- Config values that name a file under the data folder (`index_db`, `installed_db`, `consent_db`) stay as they are and are found in their group folder.
