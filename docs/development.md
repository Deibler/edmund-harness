# Development

How to change this codebase without breaking the parts that took months to
get right.

## The loop

```bash
bun run dev              # daemon in the foreground with reload
bun run typecheck        # tsc --noEmit over src, cli, scripts, integrations
bun run lint             # biome check
bun test tests/          # the suite; see below about the root sweep
bun run knip             # unused files, exports, dependencies
```

All four gates should be clean before a change lands. Biome runs at 100
columns with a few rules deliberately off: unused template literals (backticks
are the convention here), control characters in regexes (ANSI and `chat.db`
decoding need them), and non null assertions. `noExplicitAny` is a warning;
the remaining ones are real.

## Continuous integration

Every push to `main` and every pull request runs `.github/workflows/ci.yml`
on a macOS runner: the imcore-bridge client is checked out beside the
harness and built, then typecheck, lint, the test suite and a dependency
audit at high severity run. Knip runs as advisory until the unused-export
backlog in the kitchen integration is cleared. `main` only accepts pull
requests whose checks passed. Dependabot opens weekly update pull requests
for the three package roots and the workflow actions.

Versions come from changesets. `bun run changeset` records a change;
`.github/workflows/release.yml` keeps a "Version packages" pull request open
and tags the release when it merges. The package is versioned and tagged,
not published to npm.

## Tests

`bun test tests/`, not bare `bun test`. The root sweep also picks up a
vendored package's own specs. `tests/_setup.ts` is preloaded through
`bunfig.toml` and points the sandbox root at a temporary directory, because
tests once wrote hundreds of fake proactive decisions into live telemetry.

Some suites are opt in through environment variables because they need a
live model, a speech model or a worker process: `RUN_GHOST_SMOKE`,
`RUN_KOKORO_SMOKE`, `RUN_MCP_STDIO_SMOKE`, `RUN_WORKER_SMOKE`.

A handful of tests are known to fail on a clean baseline or to flap under
parallel load. The list lives in `CLAUDE.md`. Compare the failing set to that
list; do not compare counts, because the baseline itself varies between runs.

Two habits that matter more here than usual:

- **Prove a test can fail.** After writing a guard, break the thing it guards
  and watch the test go red, then restore it. One guard in this project's
  history matched a substring in an unrelated line and passed for every broken
  call site.
- **Verify against the system of record.** A send that returns success may
  have landed in the wrong chat. Tests that touch delivery should check
  `chat.db` fixtures, not return values.

## One pipeline

Inbound goes `InboundMessage` to `SessionPipeline.enqueue` to `handleBatch`
to `runModel` to `sendDeliver`. Never bypass it, never spawn a model CLI
outside the runner, never write a send that skips the deliverer. Every
proactive and recovery path wakes a session by inserting a one-shot cron row,
and that is the only door. If you need a new way in, use that one.

Use the factories: `sessionKeyFor` for keys, `src/db/open.ts` for SQLite,
`src/util/log.ts` for logging, `src/util/ids.ts` for ids. Hand built session
key strings are how the bot once answered itself.

## Things that will bite you

- **MCP stdout.** `src/mcp/server.ts` speaks JSON-RPC on stdout. A stray
  `console.log` anywhere in that process breaks every tool. `protectStdout()`
  redirects the console; leave it.
- **Tool schemas.** A zod type the MCP SDK cannot serialise publishes an empty
  schema and the model guesses the arguments. Tests pin the published schemas.
- **The bridge build.** In the bridge repository, `make -C native` sometimes
  only re-signs. `touch native/src/*.m` first and look for `clang`. A rebuilt
  library loads on the next Messages launch.
- **Gitignored state.** `config.toml`, `persona/`, `data/` and `sandbox/` are
  local. A `git revert` leaves them as they were.
- **The compaction threshold** is cost control. Read [costs.md](costs.md)
  before touching it.
- **The send guard** (`chat_mismatch`) is a true positive. Fix resolution,
  never the guard.
- **Maintenance order** is append, consolidate, archive. A test pins it.
- **`log` may be shadowed** in your shell. `/usr/bin/log`.

## Adding a tool

Tools live in `src/mcp/tools/*.ts` as `ToolDef` objects with a zod input
schema and a handler, and are assembled in the server. If the tool sends
anything, go through the bridge control socket via `invoke()`; do not open a
second bridge. If it writes files, use the sandbox path from the context and
`assertPathSafe`. Add the tool's name to nothing else; the skill drift test
harvests names automatically.

## Adding a config key

Add it to the zod schema in `src/config/config.ts` with a default and a
doc comment, then to `config.example.toml` with a comment, then to
[configuration.md](configuration.md). The example file has drifted from the
schema before; keep them in step.

## Claude Code hooks

`.claude/settings.json` is tracked and fires for anyone who opens this
repository in Claude Code, as well as for the daemon's own headless workers.
`scripts/guard-path.ts` restricts writes to the session sandbox and data
directory when a sandbox is set, and allows everything when it is not, so a
contributor's session is unaffected. `scripts/post-tool-deliver.ts` delivers
generated media after a generation tool returns. Neither should surprise you,
but you should know they run.

## Where the design reasoning lives

`docs/design/` holds the plan written before each subsystem, kept as a record
of why. `docs/research/` holds the literature review behind the memory layers.
`CLAUDE.md` holds the landmines and the three big fixes. When you learn
something the hard way, that file is where it goes, and if what you learned is
an invariant, a test is where it goes.
