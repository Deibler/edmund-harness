# Integrations

Optional packages that extend the harness. Core is complete without any of
them: it watches iMessage, runs turns, remembers, recovers. An integration adds
a capability — a broker, a radar app, a display, a data platform.

The rule that makes them optional: **core never imports `integrations/<name>/`
directly.** It asks the registry for tools or runtimes and gets whatever is
installed. Deleting a directory removes the integration completely — no import
is attempted, no tools appear, no runtime starts, nothing to clean up in core.

This is enforced, not aspirational: `bun run typecheck` passes with any subset
of these directories deleted, including all of them. Core resolves everything
through `src/integrations/` using computed paths, so the compiler never treats
a package as a build dependency. The few places core genuinely needs something
from an integration (the trading router gate, the mirror envelope block) go
through `optional.ts` + `contracts.ts` and fall back to the no-integration
behavior when the package is absent.

```
integrations/
  integrations-config.yaml   ← operator: which ones run HERE
  <name>/
    manifest.yaml            ← author: what it is, provides, who may reach it
    package.json
    index.ts                 ← daemon runtime (watchers, bridges) — optional
    tools.ts                 ← MCP tool factories — optional
    src/                     ← implementation, private to the package
```

## The two config files

| File | Owned by | Answers |
|---|---|---|
| `<name>/manifest.yaml` | the package author | What is this? What tools does it provide? Who *should* be able to reach it? |
| `<name>/config.ts` | the package author | The zod schema for its `config.toml` section, plus a typed accessor. |
| `integrations-config.yaml` | the operator | Which installed packages run on *this machine*? Any local tightening? |

They change for different reasons — capabilities vs. deployment — which is why
they are separate.

**Config sections belong to their package.** `[trading]`, `[mirror]`,
`[radaromega]`, `[fishing]`, and `[cloudflare]` still live in `config.toml`
(one file the operator edits), but core keeps them **opaque**: it never
validates or types them. The schema lives in `integrations/<name>/config.ts`,
and the integration reads its own settings through a memoized accessor:

```ts
import { tradingConfig } from "../config.ts";
const cfg = tradingConfig(config);   // validated + typed
cfg.max_position_pct
```

That is what keeps the core schema free of integration fields — delete a
package and no core type changes. Where core genuinely needs a value from one
(the MCP loadout needs the Robinhood URL; the skill filter needs to know if
RadarOmega is on), it reads it as plain data through `src/integrations/
settings.ts`, which declares only the handful of fields core touches and
supplies "integration absent" defaults. No import, no coupling.

`config.toml → [integrations]` points at the store:

```toml
[integrations]
enabled = true
dir = "./integrations"
config_file = "./integrations/integrations-config.yaml"
```

## Access control

Declared, not coded. `resolveAccess()` evaluates the manifest against the live
session; deny beats allow:

1. `dedicated_session_only` — only the integration's own namespace. This is how
   Robinhood tools stay inside `trading:` sessions and the glass tools inside
   `mirror:`, instead of an `if` at every call site.
2. `deny_sessions` — explicit denial.
3. `sessions` — namespace allowlist (`"*"` = any).
4. `handles` — sender allowlist, when non-empty.

Namespaces: `main`, `orch`, `trading`, `mirror`, `agent`.

## Adding an integration

1. `mkdir integrations/my-thing`
2. Write `manifest.yaml`:

```yaml
name: my-thing
display_name: My Thing
version: 1.0.0
description: One line on what this adds.
enabled: true
config_key: my_thing          # reads [my_thing] from config.toml

access:
  sessions: ["*"]             # or [main], or dedicated_session_only: true

tools:
  - export_name: myThingTools # a factory exported from tools.ts
    provides: [do_the_thing]

runtime:
  export_name: startMyThing   # optional; exported from index.ts
```

3. Export the tool factory from `tools.ts`:

```ts
import type { ToolContext } from "../../src/mcp/context.ts";
import type { ToolDef } from "../../src/mcp/tools/types.ts";

export function myThingTools(ctx: ToolContext): ToolDef[] {
  return [/* … */];
}
```

4. If it needs daemon-side work, export a runtime from `index.ts`:

```ts
import type { IntegrationRuntime, IntegrationRuntimeContext }
  from "../../src/integrations/host.ts";

export function startMyThing(ctx: IntegrationRuntimeContext): IntegrationRuntime {
  const timer = setInterval(() => {/* … */}, 60_000);
  return { stop: () => clearInterval(timer) };
}
```

5. Add it to `integrations-config.yaml`. Done — no core edits.

`ctx.fireSystemEvent(sessionKey, text)` is the shared wake path: it queues a
one-shot cron the scheduler picks up in ~2s. Integrations get no private route
into a session.

## Channel integrations

An integration that is a *medium* the assistant talks through — not just a tool
surface — additionally receives `ctx.channel`: the turn pipeline, a turn
interrupt, lifecycle observers, and deliverer registration. The mirror is the
only one today. Ordinary tool integrations are never handed these, so they are
structurally unable to reach into the pipeline.

## Installed

| Integration | Namespace | Runtime | Notes |
|---|---|---|---|
| `trading` | `trading:` | price-trigger watcher | Real money. Dedicated-session only. |
| `mirror` | `mirror:` | bridge + voice orchestrator | Channel; needs `ctx.channel`. |
| `radaromega` | — | freshness watchdog | Tools come from the vendored stdio MCP server. |
| `fishing` | — | — | Direct query/viz tools; endpoint guidance in `skills/fishing`. |
| `cloudflare-browser` | — | — | Rendering runs at Cloudflare's edge. |
| `kitchen` | — | schedules + Notes sync | Per-household inventory, meals and deals; 21 tools. Available in every session; isolation is per account. |

## Failure stance

A broken integration degrades the surface; it never breaks a turn.

- Malformed manifest → that package is skipped, others load.
- Missing/failed module import → contributes nothing, logged.
- Tool factory throws → that group is skipped, other tools still register.
- Runtime fails to start → logged, daemon boots anyway.
- Unmet `requires:` → the dependent integration disables itself.
