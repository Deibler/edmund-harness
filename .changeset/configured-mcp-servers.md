---
"edmund-harness": patch
---

MCP servers can be added to the assistant's workers from config, and the sky camera now uses one.

- **`[mcp_servers.<name>]` in `config.toml`.** Workers run with `--strict-mcp-config`, so a server added with `claude mcp add` never reached them.
  - A configured server supports `http`, `sse` or `stdio`, and headers for a bearer token.
  - It goes to operator sessions by default. Add `tiers = ["operator", "contact"]` to reach contacts too.
  - Guests never get one, and names the harness uses itself are refused.
  - The Claude and Codex runners choose the loadout through one function.
  - The generated `data/mcp*.json` files are now mode 0600, since they can hold tokens.
- **The `skycam` skill uses the openskycam MCP.** The sky camera's recordings now live on openskycam (SkyVision). The rewritten skill covers:
  - a photo of now from the newest recording, one to three minutes behind;
  - photos of past moments, footage, detections, and workflow runs.

  It downloads a frame and sends the file rather than pasting a signed link. The old `skystream` skill and the `snap.sh` / `sky.sh` scripts are removed.
