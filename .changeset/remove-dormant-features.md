---
"edmund-harness": minor
---

Remove five features that were installed and not in use: the trading integration, named orchestrators, image annotation links, calendar feeds and the direct Gemini video client.

- **Trading** is gone: the integration, its dashboard service and launch agent, its skill and persona template, the `trading:` session routing, its MCP loadout and its `--trading` CLI target. Uninstall the launch agent before upgrading (`scripts/launchd/service.sh trading uninstall`), because the script no longer knows it afterwards.
- **Named orchestrators** are gone: `[[orchestrators]]`, the `orch:` session routing, per-orchestrator persona overrides and history visibility, and the dashboard's create, edit and delete for them. There is one persona. The dashboard's Orchestrator page still edits its names, model and persona files.
- **Image annotation links** (`request_image_annotation`, the `/a` pages and the dashboard's Annotate tab) and **calendar feeds** (`connect_calendar`, `calendar_upcoming`, `disconnect_calendar`) are gone.
- **Video analysis** goes through OpenRouter only. `keys.gemini` is still exported to the model's shell as `EDMUND_GEMINI_KEY`.
- Rows a deployment already has under `trading:` or `orch:` keys stay in state.db and are never acted on: the store does not list them, a retired key does not resolve to the handle inside it, and it owns no message. `tests/retired-sessions.test.ts` holds that.
- The system prompt built for every remaining kind of session is byte for byte what it was. A config file that still has `[trading]` or `orchestrators` loads as before; both are ignored.
