# Prompt templates

Structured prompts for when you delegate illustration work to the
`generation` skill. A prompt is three pieces: dimensional, aesthetic,
technical. Skipping any one is how you get output that can't be
composed back into the SVG.

## The structure

```
[SUBJECT] — [AESTHETIC] — [TECHNICAL] — [DIMENSIONAL]
```

## Template: illustration for an SVG badge center

```
A [SUBJECT, one line] in flat 2-color vector style.
Colors: [exact hex codes, e.g. "navy #1B2A49 on cream #F4EDE2"].
Vintage collegiate / distressed mascot aesthetic —
simple shapes, strong outlines, no small details that break under halftone.
Transparent background, no border, no text, no shadow —
the SVG wrapper will add those.
Fills a 1000x1000 square, centered, with ~10% breathing room from edges.
```

Swap `[SUBJECT]` and the style line; keep the technical + dimensional
pieces identical across rounds so you can composite consistently.

## Template: photo edit (raster mode)

```
Edit the attached photo to [SPECIFIC DELTA, e.g. "enlarge the fish ~40%
while keeping the person, pose, beach, sky, and jacket identical"].
Do not change the subject's face, pose, or clothing.
Preserve the existing lighting and color grade.
Output: same aspect ratio, same resolution.
```

Always pass the **previous round**, not the original, as the reference
— you're editing what the user just saw.

## Template: style match from reference

```
Illustration in the style of the attached references:
- palette: [extract from refs, e.g. "muted navy and rust on cream"]
- line treatment: [extract, e.g. "slightly rough ink-drawn edges"]
- composition: [extract, e.g. "centered mascot with circular top-arc text"]

Subject: [NEW SUBJECT].
Technical: flat 2-color, transparent background, no existing text copied
from the references, no visible watermark or signature.
Dimensional: fills a [SIZE] area centered.
```

## Template: variant fan for fuzzy feedback

Three prompts, three concepts. Differ on ONE axis so the user's pick
tells you something concrete:

```
Version A: [SUBJECT] — warm palette (rust, cream, gold), loose hand-drawn linework
Version B: [SUBJECT] — cool palette (navy, slate, cream), crisp geometric linework
Version C: [SUBJECT] — high-contrast (black, white, single accent), heavy distressed texture
```

When the user says "B, but warmer" you now know two things: crisp
geometric is in, navy palette is out. One round, two signals.

## Prompt hygiene

- Never put "beautiful," "amazing," "professional." Models already try.
  These tokens cost entropy and produce worse output.
- Never say "make it different" or "try something new" — give a
  direction ("darker," "more asymmetric," "swap the mascot for a crab").
- Reference images beat adjectives. Two refs > ten adjectives.
- When in SVG mode, say "no text, no border" in EVERY illustration
  prompt. AI likes to add text and borders. Your SVG already has them.

## Anti-patterns

- "In the style of [Specific Brand]" → trademark risk + the model
  produces copycats. Use "in the style of 1970s surf shop logos"
  instead — era/vibe, not brand.
- Asking for multi-color gradients in a screen-print design. The
  printability check will flag them; better to not generate them.
- Generating text into the illustration, then also rendering text in
  the SVG. Pick one. For badges with typography, let the SVG own text.
