---
"edmund-harness": patch
---

Put the modules in layers, and remove what nothing used. No behaviour changes.

- The folders under `src/` now depend in one direction. Twenty of the 48 had formed one knot in which each depended, through the others, on all of them, while the files held only two import cycles. Twenty-six files moved to where their dependencies point: the persona loader, the system prompt and the MCP config out of the Claude runner's folder into `src/model/`, the code that runs a fired job into `src/scheduler/` and away from the job store, the registry of live calls and the screen lock into `src/sessions/`, the proactive queue and firing path into `src/ghost/`, and session-to-session relays into `src/relay/`. `tests/architecture.test.ts` fails on an import that runs against the layers, on a folder nobody placed, and on a new import cycle.
- About 240 exports that only their own file used are no longer exported, and 32 functions, constants and types that nothing used at all are deleted, with the unused imports and re-exports around them. Knip now fails the build, and the typecheck runs with `noUnusedLocals`.
- `tests/sandbox-api.test.ts` pins the 54 names that scripts in the assistant's sandboxes import from this checkout by path. No tool in the repository could see those imports: knip reported one of them as unused.
- The guard that every detached model process is written down now reads `src/model/` as well as `src/claude/` and `src/codex/`.
