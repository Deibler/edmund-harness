**What this changes and why**

**How you verified it**
Not "tests pass". What you ran, what you observed, and against which system
of record. If it touches sending, say what `chat.db` showed.

**Gates**
- [ ] `bun run typecheck`
- [ ] `bun run lint`
- [ ] `bun test tests/` (failing set compared against the known flaky list)
- [ ] `bun run knip`

**Docs**
- [ ] `config.example.toml` and `docs/configuration.md` if config changed
- [ ] `docs/cli.md` if a command changed
- [ ] No real handles, names, addresses or coordinates anywhere in the diff
