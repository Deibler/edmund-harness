# The user portal (dashboard/user-web)

The page a person opens from their standing link, `/u/<key>/<token>`. Rebuilt
2026-09-02 as a React app on shadcn (base-nova style, Tailwind v4), replacing
the server-rendered page in `dashboard/server/views/portalPage.ts`, which
stays as the fallback when the app has not been built.

## How it is served

| path | what | where |
|---|---|---|
| `GET /u/:key/:token` | the app shell (`dashboard/user-web/dist/index.html`), or the old server-rendered page if there is no build | routes/portal.ts |
| `GET /u/:key/:token/data` | everything the page shows, as JSON (`PortalPageData`) | routes/portal.ts |
| `POST /u/:key/:token/…` | settings, cron, privacy, credits/checkout — unchanged | routes/portal.ts |
| `GET /portal/assets/*` | the hashed bundles, cached immutable | routes/portalStatic.ts |
| `GET /brand/icon.png`, `/brand/logo.png` | the mark, for the tab icon and home-screen icon | routes/portalStatic.ts |

Static routes are mounted on both listeners; nothing under them is personal.
The token-gated routes keep their rate limiter (60 strict calls per minute
per IP: an open of the app costs two, shell plus data).

## Building

```
bun run portal:build      # cd dashboard/user-web && vite build → dist/
edmund restart --dashboard
```

`dist/` and `node_modules/` are gitignored; a fresh checkout needs
`cd dashboard/user-web && bun install` once. `bun run portal:dev` runs Vite
on :5174 and proxies `/u` and `/brand` to the local dashboard's public
listener (:4749), so a real portal link works against dev code.

## Where things are

- `src/App.tsx` — loads `/data`, owns the current tab (the URL hash, so
  `#credits` deep links from announcements still work), renders the shell
- `src/tabs.ts` — the tab list. Ids MUST match `PORTAL_TABS` in
  `src/announce/links.ts`; `tests/portal-spa-tabs.test.ts` pins them
- `src/components/Shell.tsx` — header (wordmark, chat name, menu sheet on
  phones), the horizontal section strip under 1024px, the left rail above
- `src/components/Sheet.tsx` — `Paper` (the card), `Row`, `Tag`
- `src/components/PageTitle.tsx` — `PageTitle`, `Eyebrow`, `Stat`, `Empty`
- `src/pages/*` — one file per tab
- `src/lib/api.ts` — base path from the URL, `loadPage`, `post`, `fileUrl`
- `src/lib/markdown.tsx` — the person file renderer (React nodes, never HTML)
- `src/components/ui/*` — shadcn components (`bunx shadcn@latest add …`)
- `src/index.css` — the theme

## The look

Paper and ink, from `dashboard/web/media/brand.md`: cream `#F5F1E8` page,
ink `#14213D` text, copper `#B8651B` for the one action colour (white text
passes contrast on it), amber `#E8A038` only for the spark in the mark,
slate `#5B6B7F` for secondary text, emerald for status alone. Charter for
the wordmark and headings, Avenir Next for UI — both ship with iOS and
macOS, so no font files are downloaded. Light only; the page is paper.

Rules the pages follow: one plain sentence under each title; numbers in the
serif with small labels; hairline rows instead of nested cards; no emoji;
tap targets 44px on phones; inputs at 16px so iOS does not zoom.

## Checking it on a phone without a phone

Headless Chrome will not shrink its window under about 500px, so
`--window-size=390,…` produces a cropped desktop layout, not a phone. Use
device emulation over the DevTools protocol instead: `bun scripts/portal-shot.ts
<outDir> home=<url>#home credits=<url>#credits desktop=<url>@1280x900`. It launches
Chrome with `--remote-debugging-port=0`, sets
`Emulation.setDeviceMetricsOverride({width:390,height:844,mobile:true})`,
blocks `*/file?p=*` so a 300-image media grid does not stall the load, and
captures each `#tab`. The dashboard's public listener and tunnel serve the
page identically, so shooting through `https://edmund.example.com`
is the real thing.

## Revoking a link

The link is the credential. `edmund portal revoke <handle>` invalidates every
link issued so far for that conversation; the next proactive message or
`get_portal_link` carries the new one. Generations live in
`data/portal-generations.json`, read by both the daemon and the dashboard.

## Destructive actions

Erasing everything requires typing `ERASE` in the dialog, and the server
checks the word rather than trusting the button. The wipe and reset actions
carry an explicit confirmation flag from the dialog; a bare POST does nothing.
The React portal needs `bun run portal:build` for the dialog change to ship.

