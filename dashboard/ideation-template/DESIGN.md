# Making a page for one person

The page is for one person, on their phone, who has only ever seen Edmund
answer in text. They open it from a link in iMessage. Its job is to show them,
in the first screen, something a text reply could not do, made from what they
already asked about.

## How a page is built

1. Copy this folder (without `node_modules` and `dist`) to your work directory.
2. `bun install`
3. Write `src/App.tsx` and whatever components it needs. Replace the
   placeholder entirely, and restyle `src/index.css` for the subject.
4. `bun run build` writes one file, `dist/index.html`, with everything inlined.
5. From the harness root: `bun scripts/ideation-publish.ts <id> <path to dist/index.html>`.
   It opens the page the way the person's phone will and refuses it for any
   problem it finds. Fix each one and run it again until it publishes.

## The sandbox it runs in

- **No network after it loads.** `fetch`, XHR and WebSockets are blocked. Bake
  data in at build time with an "as of" date, or compute it in the page (sun
  and moon positions, distances, costs, schedules).
- Images: import them (they are inlined) or use an `https` `<img>`. Map tiles
  load this way, so a Leaflet raster map works.
- **No cookies and no storage.** The page has an opaque origin, so
  `localStorage` throws. Keep state in React, and wrap any storage use in
  try/catch.
- Links may open in a new tab (`target="_blank" rel="noreferrer"`).
- At most 3 MB.

## Components and libraries

- Controls come from shadcn (`src/components/ui`, the base-nova style on Base
  UI). Add what you need with `bunx shadcn@latest add slider toggle-group tooltip accordion`.
  Icons come from `lucide-react`.
- Good libraries to add with `bun add` when the page needs them: `d3` (scales,
  shapes, geo), `leaflet` (maps), `suncalc` or `astronomy-engine` (sun, moon,
  planets), `date-fns`, `recharts` (through shadcn's chart), `three` (only
  when 3D is the point), `motion` (sparingly).
- No other UI kits (MUI, Bootstrap, Chakra, DaisyUI), no jQuery, no `<script>`
  tags from a CDN.
- Fonts: the sandbox loads fonts only from inside the file, so bundle them.
  `bun add @fontsource/<family>` and import the latin subsets you use in
  `src/main.tsx` (`import "@fontsource/inter/latin-400.css"`). Vite inlines
  them. At most two families and two weights each; a family costs about 50 KB
  per weight. Then name the family first in `--font-sans` or `--font-heading`
  in `src/index.css`.
- Leaflet's default attribution starts with a small flag icon, which reads as
  an emoji at phone size. Keep the credit and drop the icon:
  `map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>')`.

## The design pass: unslop

Before publishing, take the page through unslop, Damir Sokolovsky's skill for
turning AI-looking UI into a designed one. It is in the harness at
`skills/unslop/` (the builder's task gives the full path). Read its `SKILL.md`,
then `references/signs.md`, `references/tokens.md` and
`references/visuals.md`.

Its way of working is the standard: write a direction (product, character,
world, moments, signature), audit the page against `signs.md` line by line,
fix in its nine passes in order, then run its checklist. Its idea of one
bright element with quiet chrome around it is this page's centerpiece.

This is a page built from a brief with nobody to ask, so a few of its steps
change here:

- Skip its "set the direction and stop" wait. Write the five direction lines
  from the brief and carry on. The brief is the person's answer.
- Here, its "product" is the page, and its "world" is the person's subject:
  their sky, their river, their trail.
- No image generation and no image services. Visuals are built in code (SVG,
  canvas, the map, a chart) from the page's own data; its code treatments in
  `references/effects.md` are allowed on the centerpiece only.
- Do not run its scripts (`snapshot.mjs`, `story.mjs`). The phone-width
  pictures come from `--check`.
- Its layout rules for app shells (sidebars, 1440px canvases) and landing
  heroes do not apply. This page is mobile first at 390px. Take its spacing,
  color, icons, copy, type, details and motion passes as written, and its
  mobile rules.
- Its type families are fine, bundled as described above.
- Where unslop and this file disagree, this file wins.

## Restraint

A page made for one person does one thing well. It is a gift, not a
dashboard: the centerpiece from the brief, working, with their data in it, and
nothing that competes with it.

- Build what the brief asks for and nothing more. No extra sections, however
  good the idea; the brief's "Leave out" line is a rule.
- One primary number or answer on screen at a time. Large type for that, body
  text for the rest.
- At most one row of presets or chips for any control. If there are more
  choices than fit one row, use a select.
- Body text 15 to 17px. Small text is for axis labels and the footnote only.
- Say what is approximate once, in the footnote. Beside a figure only when that
  figure would otherwise mislead.
- Cut until removing one more thing would make it worse.

`--check` prints these numbers for your page. Aim for the target; the check
refuses a page past the limit.

| measure | target | limit |
|---|---|---|
| phone screens (844px each) | 1 to 3 | 4 |
| headings (h1 to h3) | 4 | 6 |
| controls (buttons, inputs, links, sliders, tabs, toggles) | 12 | 20 |
| words | 350 | 600 |
| disclaimers ("approximate", "not a forecast", "rounded"...) | 1 | 2 |
| text under 14px | 15% | 25% |

## Design rules

The page check enforces the first three, and the limits above. The rest are
on you.

1. **No left accent borders.** No coloured stripe down the left side of a card,
   callout, quote or list item (`border-left` of 2px or more, `border-l-2`,
   `border-l-4`, `border-l-8`).
2. **No gradient text** (`bg-clip-text`, `background-clip: text`).
3. **No emoji**, anywhere.
4. The first screen is the tool itself, working, with their data already in it:
   the slider, the map, the calculator. No intro screen, no "Get started".
5. The title is a name ("Sunset Compass"), not a sentence. No "Welcome to your
   personalized…". No marketing words: unlock, journey, discover, magic,
   elevate, seamless, insights.
6. None of the stock layouts: a hero with a big gradient headline, a subtitle
   and two buttons; a row of three identical cards, each with an icon in a
   coloured circle; "Overview", "Key insights", "Did you know?", "Fun facts"
   or "Next steps" boxes; stat tiles that repeat one number in a huge font.
7. No purple-to-blue or pink gradients, glowing blobs, glass blur panels, or
   neon-on-black.
8. Not everything in a card. Use space, 1px hairlines and alignment. A card is
   for something that really is a separate object.
9. Typography leads: one heading face and one text face, a real size scale,
   sentence case, tabular figures (`.tnum`) for numbers that change.
10. Colour comes from the subject, with one accent at most. Body text meets
    4.5:1 contrast.
11. Write like Edmund: plain and specific, using their places and numbers. Short
    labels, no exclamation marks.
12. Mobile first: 390px wide with no sideways scroll, 44px tap targets, 16px
    inputs, usable one-handed. Then check it looks deliberate at 1024px.
13. Anything approximate or unverified is said once, plainly, in the footnote
    (see Restraint), not beside every figure.
14. Semantic headings, labels on every control, visible focus, and
    `prefers-reduced-motion` respected.
15. End with one quiet line: "Made by Edmund for <first name>, <date>."

## What never goes on the page

Phone numbers, email addresses, street addresses, other people's details
beyond what the brief names, and anything about health, legal matters, money
troubles or grief.
