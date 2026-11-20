# Source

unslop by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)),
<https://github.com/heydamir/unslop>, licensed under CC BY 4.0 (`LICENSE`).
Credit stays in every copy and adaptation, as the license asks.

Vendored unchanged from commit `a6f121eee5f29c2f74976b75456feae8b66afb3a`
(2026-11-01): `SKILL.md`, `references/` and `scripts/`. Left out: the
repository's README (install steps and an advert), `examples/` (deliberately
sloppy demo pages that load Tailwind from a CDN), and `agents/openai.yaml`
(Codex display metadata).

## Review (2026-11-03)

Read in full before vendoring.

- The markdown is design guidance only. There are no instructions to fetch,
  send or run anything beyond the two scripts. There are no hidden or
  bidirectional control characters. Every link goes to the author's X,
  GitHub or site.
- `scripts/snapshot.mjs` opens a URL you pass it in Playwright and saves that
  page, with its assets inlined, to a path you pass it. It needs Playwright,
  which this repo does not install, so it does nothing here until someone
  installs it.
- `scripts/story.mjs` serves one local story file on `127.0.0.1`, records it
  with Playwright and encodes it with ffmpeg. It deletes only its own
  `.story-frames/` folder next to that file.
- The images are WebP reference screenshots.

To update, diff a fresh clone against this folder and read every changed
line before copying it in.

## How the ideation builder uses it

The page builder (`src/ideation/build.ts`) uses unslop as the design pass on
its own page, under the overrides in `dashboard/ideation-template/DESIGN.md`.
Nobody is there to answer questions, so the builder writes the direction
itself and does not wait for a reply. Image generation and both scripts are
off. Fonts must be bundled. Where the two disagree, DESIGN.md wins.
