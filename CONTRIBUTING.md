# Contributing

Thanks for looking. This is a personal project that grew into something other
people might run, so the bar is: do not break the parts that took months to
get right, and leave the next person a note about anything you learned the
hard way.

## Before you start

- Read [docs/development.md](docs/development.md). It is short and it names
  the landmines.
- If you are changing anything on the send path, the memory pipeline or the
  recovery loop, open an issue first and say what you intend. Those areas have
  history, and the history is in `CLAUDE.md`.
- You will need a Mac to run the suite meaningfully. Most tests run without
  Messages.app or the bridge, but anything that touches delivery needs
  `chat.db` fixtures.

## How changes land

`main` is protected. Nothing is pushed to it directly, not even by the
maintainer: every change is a pull request, and a pull request merges only
when the CI checks pass (typecheck, lint, the test suite, and a dependency
audit at high severity). Releases use changesets: a change that people
would notice carries a `.changeset` entry, and a "Version packages" pull
request accumulates them into the next version and the changelog.

## Making a change

1. Fork and branch.
2. Make the change with a test that fails without it. Then break the thing the
   test guards and confirm the test goes red; a test that cannot fail is worse
   than no test.
3. Run the four gates: `bun run typecheck`, `bun run lint`, `bun test tests/`,
   `bun run knip`.
4. If the change touches config, update `config.example.toml` and
   `docs/configuration.md`. If it touches a command, update `docs/cli.md`.
5. If a person running the harness would notice the change, add a changeset:
   `bun run changeset`, pick patch or minor, write one sentence.
6. Write a commit message that says why, not just what. The log is read.
7. Open a pull request. Describe what you verified and how, including anything
   you could not verify. CI runs on the pull request; the merge button waits
   for it.

## What gets merged

- Fixes with a test.
- Documentation that is more accurate than what it replaces.
- New skills that are general purpose, or that come with a clear note about
  what they are tied to.
- New integrations that follow the manifest model and keep core free of
  imports from them.

## What probably will not

- Relaxing a guard because it seemed like a false positive. The
  `chat_mismatch` guard in particular has been tested against relaxing it.
- Adding an `if` that stops the model from replying. Fix the bookkeeping or
  the context instead.
- Anything that requires the operator to keep a list current by hand.
- Emoji in any user facing surface.

## Privacy

Never commit real handles, names, addresses or coordinates, in tests, docs or
example config. Use `+1555` numbers and `example.com` addresses. If you find
something that slipped through, say so privately (see
[SECURITY.md](SECURITY.md)) rather than in a public issue.
