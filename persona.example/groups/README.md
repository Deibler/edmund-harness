# groups/

Per-group memory: `groups/<slug>.md`, keyed off the chat GUID.

Same idea as `people/`, scoped to a thread instead of a person: what this group
is for, its running jokes, who's who in it, what it has decided.

Injected into the system prompt for that group. Because the group prompt must
stay identical for every member (so one warm worker can serve them all), keep
this file about the GROUP — never about one participant. Per-person detail
belongs in `people/`.
