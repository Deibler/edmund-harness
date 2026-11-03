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
- Leaflet's default attribution starts with a small flag icon, which reads as
  an emoji at phone size. Keep the credit and drop the icon:
  `map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>')`.

## Design rules

The page check enforces the first three. The rest are on you.

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
13. Anything approximate or unverified says so where it appears, small and
    plain.
14. Semantic headings, labels on every control, visible focus, and
    `prefers-reduced-motion` respected.
15. End with one quiet line: "Made by Edmund for <first name>, <date>."

## What never goes on the page

Phone numbers, email addresses, street addresses, other people's details
beyond what the brief names, and anything about health, legal matters, money
troubles or grief.
