# Integrations

An integration is an optional package under `integrations/` that adds a
capability: a broker, a display, a radar application, a household ledger. The
core is complete without any of them. This page covers the model; the
authoritative reference for the manifest and the loader is
[`integrations/README.md`](../integrations/README.md).

## The rule

Core never imports `integrations/<name>/` directly. It asks a registry, which
finds manifests and imports modules by computed path the first time something
needs them. `bun run typecheck` passes with any subset of the integration
directories deleted, including all of them, and that is the contract: deleting
a directory removes the integration entirely.

A broken integration degrades the surface but never breaks a turn. A malformed
manifest is skipped, a failing import contributes nothing, a tool factory that
throws loses only its own tools, and a runtime that fails to start is logged
while the daemon boots anyway.

## What a package can contribute

- **Tools** the model can call, from a factory exported by `tools.ts`. They are
  filtered by the manifest's access rules per session, and guests never see
  them.
- **A runtime** in the daemon, from `index.ts`, with a handle to wake a session
  through the shared one-shot cron path. There is no private route into a
  session.
- **Prompt instructions**: a markdown file for the system prompt, or a short
  envelope note.
- **Skill ownership**: skills listed in the manifest are hidden when the
  integration is off.
- **A config section** in `config.toml`, validated by the package's own
  `config.ts`. Core keeps the section opaque.

A channel integration, one the assistant talks through rather than merely a
tool surface, additionally receives the turn pipeline and delivery hooks. The
smart mirror is the only one.

## Access control

Declared in the manifest, evaluated per session, deny beats allow. A package
can restrict itself to its own session namespace (this is how the trading
tools stay inside `trading:` sessions without an `if` at every call site),
deny specific namespaces, allow specific namespaces, or allow only certain
senders.

## Enabling per machine

Three layers, highest precedence first: `integrations/integrations-config.yaml`
(which packages run here, with optional access tightening), the manifest's
own `enabled` flag, and `[<config_key>].enabled` in `config.toml`. Plus the
global `[integrations]` switch.

## What ships

| Package | What it adds | Needs | Notes |
|---|---|---|---|
| `kitchen` | Per household inventory, meal plans that refuse missing ingredients, grocery deals, a site per household, iCloud Notes sharing. Twenty one tools. | Ledger files, OpenRouter, Chrome for the Notes bridge | Generic in shape, written for particular households |
| `mirror` | A voice and display channel on a Raspberry Pi smart mirror: wake word, speech to text, spoken replies, typed on-glass components. | The Pi bridge, a local speech sidecar | The only channel integration; its own session namespace |
| `trading` | An autonomous trading sub-persona with risk limits enforced in code, price triggers, a journal and a kill switch. | The broker's MCP endpoint and an account | Real money. Off by default. Own session namespace and own dashboard |
| `radaromega` | Drives a radar application over the Chrome DevTools Protocol. Contributes a freshness watchdog and two skills; the tools come from a vendored MCP server. | The application, a vendored server that is not in this repository | Tied to a paid desktop app |
| `fishing` | Query and chart tools over a local fishing data platform. | A separate data platform repository | Regional dataset |
| `cloudflare-browser` | Screenshot, PDF, markdown, scrape and JSON extraction rendered at Cloudflare's edge. | A Cloudflare account with Browser Rendering | Generic |

The kitchen, mirror, trading, radar and fishing packages exist because the
author needed them. They are here as working examples of what an integration
can be, not because your kitchen or your mirror will match. Delete what you
do not need; the build will not notice.

## Writing your first integration

1. `mkdir integrations/my-thing` and write `manifest.yaml`. Only `name` is
   required and it must equal the directory name.

   ```yaml
   name: my-thing
   display_name: My Thing
   version: 1.0.0
   description: One line on what this adds.
   enabled: true
   config_key: my_thing
   access:
     sessions: ["*"]
   tools:
     - export_name: myThingTools
       provides: [do_the_thing]
   runtime:
     export_name: startMyThing
   ```

2. Add a `package.json` marked private with `"type": "module"`. Dependencies
   resolve from the root install.
3. Export a tool factory from `tools.ts` that returns an array of tool
   definitions, each with a name, a description, a zod input schema and a
   handler. The types are in `src/mcp/tools/types.ts` and `src/mcp/context.ts`.
4. If the package needs to run something in the daemon, export a runtime
   factory from `index.ts` that returns an object with a `stop()` method. The
   context it receives includes `fireSystemEvent(sessionKey, text)` to wake a
   conversation.
5. If it has settings, export a section from `config.ts` with `defineSection`
   and document the table in `config.example.toml`.
6. Add the package to `integrations-config.yaml` and restart the daemon.
7. Put tests in `integrations/my-thing/test/` and confirm `bun run typecheck`
   still passes with your directory deleted.

## Known gaps

- Several source comments mention `edmund integrations list` and `doctor`.
  Neither command exists yet.
- The manifest's `external_deps` field is informational; nothing checks it.
- The registry, manifest parser and access evaluator have no dedicated tests.
  The access rule that keeps trading tools out of ordinary chats is enforced
  by code but not pinned by a test. Contributions welcome.
