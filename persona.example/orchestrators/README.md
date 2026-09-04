# orchestrators/

Extra named personas beyond the main one. Each lives in
`orchestrators/<key>/` and is invoked by name in any chat ("desmond, ...").

Resolution is **per-file with fallback**: `orchestrators/<key>/IDENTITY.md`
wins when present, otherwise the top-level `IDENTITY.md` is used. So an
orchestrator that just needs a different voice overrides one file and inherits
the rest.

```
orchestrators/
  desmond/
    IDENTITY.md      ← different character
    SOUL.md          ← its own memory
    (VENUE_DM.md, AGENTS.md, … omitted → inherited from the parent)
```

Register the key, invocation names, model, and role in `[orchestrators]` in
config.toml. Exactly one orchestrator is `primary` — it takes un-named DMs.
