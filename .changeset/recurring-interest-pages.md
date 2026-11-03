---
"edmund-harness": minor
---

Build a page, unasked, for an interest someone keeps coming back to, and send them the link.

- After a conversation has been quiet for 20 minutes, at most once a day per person, an ideator pass (`src/ideation/ideator.ts`, one structured call) reads the last 30 days of the chat, groups the person's questions into interest threads, and proposes up to three pages, each citing the person's own messages.
- Code decides, not the model:
  - A thread counts only when the cited messages exist in chat.db, are theirs, come from this chat, are not reactions, and fall on 3 or more separate days in the window (`src/ideation/recurrence.ts`).
  - Health, legal, grief, relationship and money threads are never built.
  - Nothing is built for the same thread twice in 21 days, or for the same person twice in 7.
  - All ideation spend is capped per rolling 7 days.
- The pick is built by a detached sub-agent from `dashboard/ideation-template` (Vite, React, Tailwind and shadcn, built to one self-contained file), held to the template's `DESIGN.md`.
- `scripts/ideation-publish.ts` renders the page in headless Chrome at phone width under the production headers. It refuses a page that throws, logs errors, is blocked by the sandbox, is blank, scrolls sideways, uses a left accent border, gradient text or emoji, loads remote scripts, or is over 3 MB. The builder fixes and reruns until the page passes.
- A finished build does not take the ordinary "relay the result" wake-up. A page that published becomes one scheduled wake-up at the start of the person's next active hours, and Edmund shares it in his own words, or holds it if the conversation is elsewhere. A build that failed reaches nobody. A link counts as delivered only once it is found in chat.db.
- The kitchen host serves ready pages at `/i/<id>/` under an opaque-origin sandbox with no network access. Pages are noindex and no-referrer, read from disk on request, and count opens (link-preview fetches excluded).
- The portal has a "Made for you" tab: the person's recurring interests and the pages whose links reached them in the chat. It appears once there is one. "Erase everything" removes pages, runs and interests.
- Off by default (`[ideation] enabled = false`, `people = []`). It also stays off unless `[security].model_host_access = "full"`, because the builder needs a shell.
- `scripts/ideation-replay.ts <handle> [--as-of YYYY-MM-DD]` runs the ideator as a dry run and prints the threads, the days found in chat.db, what was turned down and why, and the pick. It never builds.
