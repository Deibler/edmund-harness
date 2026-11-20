---
"edmund-harness": patch
---

Make ideation pages quieter, put them through a design pass, and allow pulling one down.

- The first real build read as noisy. Measured at phone width it had:
  - 7 screens and 10 headings
  - 52 controls and 959 words
  - 8 disclaimers
  - 49% of its text under 14px
- Briefs now describe one centerpiece, with a "Leave out:" line, instead of a tool for every question in the thread.
- DESIGN.md has a Restraint section with targets and limits. The page check measures headings, controls, words, disclaimers and small text, and refuses a page past a limit. `--check` prints the numbers.
- unslop (Damir Sokolovsky, CC BY 4.0) is vendored unchanged at `skills/unslop/` after a full read (`SOURCE.md`). Edmund can use it on any page he designs. The ideation builder takes every page through it before publishing, with DESIGN.md's overrides for unattended builds: no waiting for a reply, no image generation, no scripts, and fonts bundled through `@fontsource`.
- `bun scripts/ideation-publish.ts --withdraw <id> [reason]` takes a published page down. Once withdrawn, a page:
  - returns 404 from the next request
  - can never be announced
  - leaves the portal
  - keeps its files
- A withdrawn page frees its thread for a new build, but still counts toward the person's weekly allowance.
