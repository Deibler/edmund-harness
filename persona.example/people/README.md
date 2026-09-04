# people/

Per-contact memory: `people/<handle>.md`, where `<handle>` is the normalized
E.164 number or Apple ID (e.g. `+15551234567.md`).

The file for whoever you're DMing is injected into the system prompt
automatically. In groups it isn't — the model calls `read_person_file(handle)`
when a particular person matters.

**The model writes these itself** via `remember_about_person(handle, section,
note)`, so you don't need to seed them. Conventional sections:

```markdown
# Alex

## Preferences
- Wants the answer first, reasoning only if asked.

## Shared history
- Moved to Denver in March 2026.

## Open items
- Still owes a decision on the trip dates.
```

Gitignored in a real `persona/` — these fill up with details about real people.
