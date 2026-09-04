/**
 * The browser this integration drives, and the handful of things it can do.
 *
 * Apple Notes has two halves and neither is reachable the same way.
 *
 * Locally, AppleScript can write a note's body and nothing else: it cannot
 * invite anybody (the dictionary's `shared` is read only, `NSSharingService`
 * does nothing for Notes, and the share sheet reports zero children to
 * accessibility) and it silently strips every checklist markup, so a list
 * written that way can never be ticked.
 *
 * On icloud.com both exist. Sharing is ordinary DOM. The note body is NOT: the
 * editor paints to a `<canvas>`, so there is no element to read or set, and the
 * only ways in are the ones a person has — the keyboard and the clipboard.
 * That turns out to be enough, because Apple's own clipboard flavour carries
 * the paragraph styling as JSON in `data-tt`, checklists included. One copy
 * reads the whole note with its tick state; one paste rewrites it.
 *
 * Everything here is transport. What to put in a note lives in `notedoc.ts`,
 * who to share it with in `notes_share.ts`, and when to do either in
 * `notesync.ts`.
 *
 * Rules, each one paid for:
 *
 *   - EVERY STEP HAS A DEADLINE. This is reachable from the ten-second watch
 *     pass, so a wedged browser has to fail in seconds rather than hold a lock.
 *   - NAVIGATE BY THE NOTE'S OWN URL when one is known. The note list is
 *     virtualised and recycles DOM nodes, so a title match can click a row that
 *     selects a different note — that happened, and it read one note's
 *     participants as another's.
 *   - THE PAGE MUST BELIEVE IT HAS FOCUS. The canvas editor ignores every key
 *     and paste when `document.hasFocus()` is false, which is always true for a
 *     background tab. `Emulation.setFocusEmulationEnabled` fixes that without
 *     taking focus away from whoever is actually using the Mac.
 *
 * There is no password in here and there must never be one. This borrows a
 * signed-in browser profile; if that session lapses the honest outcome is an
 * error telling a human to sign in, not a credential sitting in the repo.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const HOST = "127.0.0.1";

/**
 * A browser this integration owns, rather than whichever one happens to be open.
 *
 * Borrowing the assistant's browsing profile was the first attempt and does not
 * work: that Chrome is launched with `--remote-debugging-pipe`, so it has no
 * socket for anything but its own parent, and copying the profile did not carry
 * the iCloud session across. A dedicated profile costs one sign-in, ever, and in
 * exchange the kitchen's session cannot be ended by somebody closing a tab.
 */
const PORT = Number(process.env.KITCHEN_CDP_PORT || 9224);
const PROFILE =
  process.env.KITCHEN_CHROME_PROFILE ||
  resolve(process.env.EDMUND_DATA_DIR ?? "./data", "kitchen", "chrome-profile");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const NOTES_URL = "https://www.icloud.com/notes";
const ORIGIN = "https://www.icloud.com";

/** Whole-operation ceiling. Past this something is wrong, not slow. */
const DEADLINE_MS = 90_000;
/** Per-condition ceiling inside the page. */
export const STEP_MS = 15_000;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * A very small DevTools client
 * ------------------------------------------------------------------ */

type Cdp = {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  close(): void;
};

type BrowserVersion = { webSocketDebuggerUrl: string };
type TargetInfo = { targetId: string; type?: string; url?: string };
type RuntimeEvaluation = {
  exceptionDetails?: { exception?: { description?: string } };
  result?: { value?: unknown };
};

/** A client already bound to one page's session. */
export type Page = { send: Cdp["send"]; close(): void };

async function httpJson(path: string, ms = 3000): Promise<unknown> {
  const res = await fetch(`http://${HOST}:${PORT}${path}`, { signal: AbortSignal.timeout(ms) });
  return await res.json();
}

/**
 * Get a browser to talk to, starting one only if none is listening.
 *
 * Two processes cannot share a Chrome user-data-dir, so this never launches a
 * second copy on top of a running one.
 */
async function ensureBrowser(): Promise<void> {
  try {
    await httpJson("/json/version", 2000);
    return;
  } catch {
    // not running
  }
  spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      NOTES_URL,
    ],
    { detached: true, stdio: "ignore" },
  ).unref();

  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    try {
      await httpJson("/json/version", 1500);
      return;
    } catch {
      await sleep(400);
    }
  }
  throw new Error("Chrome did not come up on the debugging port.");
}

function connect(wsUrl: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map<number, { ok: (value: unknown) => void; no: (error: Error) => void }>();
    let seq = 0;
    const timer = setTimeout(() => reject(new Error("timed out opening a debugger socket")), 8000);

    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        send(method, params, sessionId) {
          const id = ++seq;
          return new Promise<unknown>((ok, no) => {
            pending.set(id, { ok, no });
            const frame: Record<string, unknown> = { id, method, params: params ?? {} };
            if (sessionId) frame.sessionId = sessionId;
            ws.send(JSON.stringify(frame));
            setTimeout(() => {
              if (pending.delete(id)) no(new Error(`${method} did not answer`));
            }, STEP_MS + 5_000);
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            /* already gone */
          }
        },
      });
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("could not open a debugger socket"));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        error?: { message?: string };
        result?: unknown;
      };
      if (!msg.id) return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.no(new Error(msg.error.message ?? "devtools error"));
      else p.ok(msg.result);
    };
  });
}

/**
 * Get a session on a tab showing iCloud Notes.
 *
 * Goes through the browser socket and the Target domain rather than the older
 * `/json/list` and `/json/new` HTTP helpers. On current Chrome those are not
 * equivalent: `/json/list` came back empty here with tabs plainly open, and
 * `/json/new` answers a GET with a non-JSON error, so the HTTP path fails in
 * the shape of "the browser has no tabs" when the truth is that the endpoint no
 * longer reports them.
 */
async function notesTab(): Promise<Page> {
  const version = (await httpJson("/json/version")) as BrowserVersion;
  const browser = await connect(version.webSocketDebuggerUrl);

  const { targetInfos } = (await browser.send("Target.getTargets")) as {
    targetInfos?: TargetInfo[];
  };
  const pages = (targetInfos ?? []).filter((t) => t.type === "page");
  let target = pages.find((t) => String(t.url).includes("icloud.com/notes"));
  let goToNotes = false;

  if (!target) {
    target =
      pages.find((t) => String(t.url).includes("icloud.com")) ??
      pages.find((t) => String(t.url).startsWith("about:blank"));
    goToNotes = true;
  }
  if (!target) {
    const made = (await browser.send("Target.createTarget", { url: NOTES_URL })) as {
      targetId: string;
    };
    target = { targetId: made.targetId };
    goToNotes = false;
  }

  const { sessionId } = (await browser.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  })) as { sessionId: string };

  const page: Page = {
    send: (method, params) => browser.send(method, params, sessionId),
    close: () => browser.close(),
  };

  // Reading and writing the note body both go through the clipboard, and the
  // canvas editor ignores input entirely unless the page thinks it is focused.
  // Granted and enabled once per session, before anything tries to use them.
  await browser
    .send("Browser.grantPermissions", {
      origin: ORIGIN,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    })
    .catch(() => {});
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});

  if (goToNotes) await navigate(page, NOTES_URL);
  // The app boots inside an iframe; the outer load event fires well before the
  // note list exists, so callers still poll for what they need.
  await sleep(goToNotes ? 4000 : 1200);
  return page;
}

/* ------------------------------------------------------------------ *
 * Talking to the page
 * ------------------------------------------------------------------ */

/**
 * Run a function in the tab and get its value back.
 *
 * Everything real lives in a same-origin iframe, so page code reaches it via
 * `contentDocument` rather than by hunting an execution context id — the id
 * changes whenever the app re-frames itself, and a stale one fails in a way
 * that reads exactly like "the button is missing".
 */
export async function evaluate<T>(cdp: Page, body: string, arg?: unknown): Promise<T> {
  const src = `(async () => {
    const ARG = ${JSON.stringify(arg ?? null)};
    const doc = () => {
      const f = document.querySelector('iframe');
      return (f && f.contentDocument) || document;
    };
    const all = (sel) => [...doc().querySelectorAll(sel)];
    const label = (el) => (el.getAttribute('aria-label') || el.title || el.innerText || '').trim();
    const byLabel = (re) => all('button,[role=button],div[class*=cw-button],ui-button')
      .find((el) => re.test(label(el)));
    const wait = async (fn, ms = ${STEP_MS}) => {
      const until = Date.now() + ms;
      for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() > until) return null;
        await new Promise((r) => setTimeout(r, 150));
      }
    };
    ${body}
  })()`;
  const res = (await cdp.send("Runtime.evaluate", {
    expression: src,
    awaitPromise: true,
    returnByValue: true,
  })) as RuntimeEvaluation;
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? "page script failed");
  }
  return res.result?.value as T;
}

/**
 * Go somewhere, and do not come back until the tab will answer again.
 *
 * A fixed pause after `Page.navigate` is not enough on its own. The old
 * execution context is torn down at some point during the load, and any script
 * that happens to be dispatched into it comes back as "Inspected target
 * navigated or closed" — which is thrown, aborts the whole operation, and reads
 * like the browser died rather than like a page that was simply not ready yet.
 *
 * So the wait is for evidence instead of for a duration: a trivial expression
 * is dispatched until one of them answers. It is trivial on purpose — the probe
 * has to be safe to send an unknown number of times, which nothing else here
 * is.
 */
export async function navigate(cdp: Page, url: string, settleMs = 8_000): Promise<void> {
  await cdp.send("Page.navigate", { url });
  const until = Date.now() + settleMs;
  for (;;) {
    try {
      await cdp.send("Runtime.evaluate", { expression: "1", returnByValue: true });
      return;
    } catch {
      if (Date.now() >= until) return;
      await sleep(250);
    }
  }
}

/** Type at the browser level, because the app's fields ignore synthetic input. */
export async function typeText(cdp: Page, text: string): Promise<void> {
  await cdp.send("Input.insertText", { text });
}

/**
 * Press a key, optionally as an editing command.
 *
 * `commands` is what makes shortcuts work: WebKit-derived editors act on the
 * named editing command rather than on the modifier bits, so a Meta+A with no
 * `selectAll` command selects nothing at all.
 */
export async function press(
  cdp: Page,
  key: string,
  code: string,
  vk: number,
  opts: { modifiers?: number; commands?: string[]; text?: string } = {},
): Promise<void> {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      modifiers: opts.modifiers ?? 0,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      text: type === "keyDown" ? opts.text : undefined,
      commands: type === "keyDown" ? opts.commands : undefined,
    });
  }
}

export const pressEnter = (cdp: Page) => press(cdp, "Enter", "Enter", 13, { text: "\r" });
const selectAll = (cdp: Page) =>
  press(cdp, "a", "KeyA", 65, { modifiers: 4, commands: ["selectAll"] });

/**
 * Empty the focused field the way a person would.
 *
 * Setting `.value` from page script does not work here: the search box is a
 * controlled component, so the app's own model keeps the old query and the next
 * thing typed lands on the end of it. That produced the worst possible failure
 * — a real note reported as not existing — so text goes out through the same
 * keyboard path a human would use.
 */
export async function clearField(cdp: Page): Promise<void> {
  await selectAll(cdp);
  await press(cdp, "Backspace", "Backspace", 8);
}

async function click(cdp: Page, x: number, y: number): Promise<void> {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
}

/* ------------------------------------------------------------------ *
 * The note body, which is a canvas
 * ------------------------------------------------------------------ */

const EDITOR_RECT = `
  const ec = await wait(() => doc().querySelector('.editor-container'), 8000);
  if (!ec) return null;
  const r = ec.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
`;

/** Is the caret actually in the note body, or still on the page around it? */
const CARET_IN_EDITOR = `
  const a = doc().activeElement;
  return !!(a && a.closest && a.closest('.editor-container'));
`;

/**
 * Put the caret in the note body, and prove it landed there.
 *
 * Aims at the RIGHT side deliberately: checklist circles sit in the left margin
 * and a click on one toggles it, so clicking into the middle of a note risks
 * silently ticking somebody's shopping as a side effect of opening it.
 *
 * The verification is not defensive padding. A click that misses leaves focus
 * on the page `<body>`, where a select-all then selects the entire app — the
 * sidebar, the search filters, the lot — and a copy returns that as if it were
 * the note. It did, and the app's own chrome ended up parsed as a line of
 * somebody's shopping list. So the caret is checked rather than assumed, and
 * several points are tried, because the one dead spot depends on how the window
 * happens to be sized.
 */
export async function focusEditor(cdp: Page): Promise<boolean> {
  // Close anything floating over the note first. The share popover in
  // particular covers the top right of the editor, which is where a click aimed
  // at empty space would otherwise land — it would hit the popover, focus would
  // stay off the note, and the read would come back as page chrome.
  await evaluate(cdp, DISMISS).catch(() => {});
  await sleep(300);

  const r = await evaluate<{ x: number; y: number; w: number; h: number } | null>(cdp, EDITOR_RECT);
  if (!r) return false;

  // Past the checklist gutter but well clear of the right-hand overlays.
  // Circles sit about 36px in and a click on one toggles it, so nothing here
  // goes near the left margin: silently ticking somebody's shopping while
  // opening their note would be a nasty way to lose their place.
  const safe = Math.round(r.x + Math.min(200, r.w * 0.3));
  const points: Array<[number, number]> = [
    [safe, Math.round(r.y + r.h * 0.75)],
    [safe, Math.round(r.y + r.h * 0.95)],
    [Math.round(r.x + r.w - 40), Math.round(r.y + r.h * 0.75)],
  ];
  for (const [x, y] of points) {
    await click(cdp, x, y);
    await sleep(450);
    if (await evaluate<boolean>(cdp, CARET_IN_EDITOR)) return true;
  }
  return false;
}

/**
 * The whole note body as Apple's own clipboard HTML.
 *
 * There is no DOM to read, so this is a real select-all and copy. The system
 * clipboard is genuinely clobbered by that, which is why `withNote` puts back
 * whatever was on it when it is done.
 *
 * Returns null rather than a guess. Every caller treats null as "could not
 * read" and refuses to write, which is the only safe reading: the alternative
 * is rewriting a shared note from a body that was never actually its body.
 */
export async function readBody(cdp: Page): Promise<string | null> {
  if (!(await focusEditor(cdp))) return null;
  await selectAll(cdp);
  await sleep(350);
  await press(cdp, "c", "KeyC", 67, { modifiers: 4, commands: ["copy"] });
  await sleep(700);
  const html = await evaluate<string | null>(
    cdp,
    `
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        if (it.types.includes('text/html')) return await (await it.getType('text/html')).text();
      }
      return null;
    } catch (e) { return null; }
  `,
  );
  if (html === null) return null;
  // An empty note copies as nothing at all, which is a legitimate answer and
  // must stay distinguishable from a failed read.
  if (!html.trim()) return "";
  // Anything that came out of this editor carries Apple's paragraph styling.
  // Page chrome does not, so this is what separates "the note is empty" from
  // "the selection was never in the note".
  return /data-tt=/.test(html) ? html : null;
}

export type WriteResult = { ok: true; body: string } | { ok: false; why: string };

/**
 * Replace the whole note body with this HTML, and prove it was replaced.
 *
 * Select-all then paste, rather than typing: a paste is one operation the
 * editor either applies or does not, where typing thirty lines is thirty
 * chances to end up half-written. It also carries checklist state, which
 * keystrokes cannot.
 *
 * The select-all is the dangerous half, and it is the half that cannot be
 * watched. There is no DOM selection to inspect — the editor paints to a canvas
 * — so a select-all that did not take is indistinguishable from one that did
 * right up until the paste lands, at which point it has ADDED a copy of the
 * note instead of replacing it. This used to return true the moment the
 * keystroke was dispatched, which made that outcome invisible: the caller
 * recorded the note as current, stopped opening it, and a household's list
 * quietly accumulated ten stacked copies of itself over a few days.
 *
 * So a write is not finished until the note has been read back and the caller
 * has recognised what it says. `accepts` belongs to the caller because only the
 * caller knows what it asked for. A rejected write is retried rather than
 * reported, since a select-all that DOES take replaces everything — including
 * whatever mess the previous attempt made.
 */
export async function writeBody(
  cdp: Page,
  html: string,
  accepts: (body: string) => boolean,
  attempts = 3,
): Promise<WriteResult> {
  let why = "the note body could not be pasted";
  for (let i = 0; i < attempts; i++) {
    const staged = await evaluate<boolean>(
      cdp,
      `
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([ARG.html], { type: 'text/html' }),
          'text/plain': new Blob([ARG.text], { type: 'text/plain' }),
        })]);
        return true;
      } catch (e) { return false; }
    `,
      { html, text: html.replace(/<[^>]*>/g, "") },
    );
    if (!staged) {
      why = "the list could not be put on the clipboard";
      continue;
    }

    if (!(await focusEditor(cdp))) {
      why = "the caret would not go into the note body";
      continue;
    }
    await selectAll(cdp);
    await sleep(350);
    await press(cdp, "v", "KeyV", 86, { modifiers: 4, commands: ["paste"] });
    // iCloud debounces its save. Leaving before it fires loses the edit.
    await sleep(2500);

    const body = await readBody(cdp);
    if (body === null) {
      why = "the note could not be read back after writing";
      continue;
    }
    if (accepts(body)) return { ok: true, body };
    why = "the note did not come back saying what was written to it";
  }
  return { ok: false, why };
}

/* ------------------------------------------------------------------ *
 * The page steps for finding a note
 * ------------------------------------------------------------------ */

const SIGNED_OUT = `
  const t = document.body.innerText || '';
  return /Sign In to your Apple Account|Sign in with Apple Account/i.test(t)
    || !!document.querySelector('iframe[src*="idmsa.apple.com"]');
`;

/** Focus the search field so a title can be typed into it. */
const FIND_NOTE = `
  const box = await wait(() => doc().querySelector('input[type=search], [class*=search] input'));
  if (!box) return { ok: false, why: 'no search field' };
  const f = document.querySelector('iframe');
  if (f && f.contentWindow) f.contentWindow.focus();
  box.focus();
  return { ok: true };
`;

/**
 * Click the row whose title matches exactly, then prove the app agreed.
 *
 * Two hazards here, both of which bit.
 *
 * The list is VIRTUALISED and recycles its DOM nodes, so `.list-item` includes
 * off-screen leftovers still carrying the title of a note that is no longer
 * there. Matching one of those and clicking it selects something else entirely
 * — that is how a run once reported this household's note as being shared with
 * a throwaway address, which belonged to a different note. Only rows the app
 * has marked `on-screen` are real, and the row must end up `is-selected`.
 *
 * And it polls for the MATCHING row rather than for any rows at all, because a
 * fixed pause races both the search filter and iCloud syncing a recent write.
 */
const PICK_ROW = `
  const want = ARG.trim();
  const live = () => all('.notes-note-list-content-view .list-item')
    .filter((r) => /on-screen/.test(r.className) && r.offsetParent !== null);
  const titleOf = (r) => {
    const c = r.querySelector('.note-list-item-content');
    return ((c && c.innerText) || '').split('\\n')[0].trim();
  };
  const match = await wait(() => live().find((r) => titleOf(r) === want), 10000);
  if (!match) return { ok: false, why: 'notfound', saw: live().map(titleOf).slice(0, 8) };
  match.click();
  const settled = await wait(() => /is-selected/.test(match.className), 4000);
  if (!settled) return { ok: false, why: 'the row did not take the click' };
  await new Promise((r) => setTimeout(r, 700));
  return { ok: true, url: location.href };
`;

/** Confirm the note now on screen is the one asked for, whatever route got here. */
const CONFIRM_OPEN = `
  const want = ARG.trim();
  const ok = await wait(() => all('.notes-note-list-content-view .list-item')
    .some((r) => {
      if (!/is-selected/.test(r.className) || r.offsetParent === null) return false;
      const c = r.querySelector('.note-list-item-content');
      return ((c && c.innerText) || '').split('\\n')[0].trim() === want;
    }), 12000);
  return { ok: !!ok, url: location.href };
`;

/** Press the app's own compose button and wait for an empty note to open. */
const NEW_NOTE = `
  const btn = await wait(() => byLabel(/^Create a note$/i) ||
    doc().querySelector('.compose.cw-button'), 8000);
  if (!btn) return { ok: false, why: 'no compose button' };
  btn.click();
  await new Promise((r) => setTimeout(r, 2500));
  return { ok: true };
`;

const DISMISS = `
  const close = byLabel(/^(Close|Cancel|Done)$/i);
  if (close) close.click();
  doc().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return true;
`;

/* ------------------------------------------------------------------ *
 * The operation
 * ------------------------------------------------------------------ */

export type Failure = { ok: false; error: string; signedOut?: boolean };

/** Where a located note lives, so the next run can skip the hunt entirely. */
let lastUrl: string | null = null;
export const openedUrl = (): string | null => lastUrl;

export type NoteOpts = {
  /** The note's own address, if the household has one on file. */
  known?: string | null;
  /**
   * Make the note when no note by this title exists.
   *
   * Off by default, and the default is the important one. Creating a note from
   * the sharing path would leave a second, empty, shared note beside the real
   * list and the household would then tick the wrong one. Only the module that
   * owns the note's CONTENT is allowed to bring one into existence, and it does
   * so in the same operation that fills it in.
   */
  create?: boolean;
};

/**
 * Open one note by title and do something with it.
 *
 * Restores the system clipboard afterwards. Reading a note means a real
 * select-all and copy, and this can run unattended from the watch pass; walking
 * off with whatever somebody had copied would be a rude way to sync a shopping
 * list.
 */
export async function withNote<T>(
  title: string,
  fn: (cdp: Page) => Promise<T>,
  opts: NoteOpts = {},
): Promise<T | Failure> {
  let cdp: Page | null = null;
  const stop = setTimeout(() => cdp?.close(), DEADLINE_MS);
  let saved: string | null = null;
  try {
    await ensureBrowser();
    cdp = await notesTab();
    // Deliberately NOT Page.bringToFront. Input events are dispatched into the
    // renderer and do not need the OS window, and this can run from the watch
    // pass — stealing focus from whoever is using the Mac to tick a shopping
    // list would be a worse bug than anything it guards against.

    if (await evaluate<boolean>(cdp, SIGNED_OUT)) {
      return {
        ok: false as const,
        signedOut: true,
        error:
          "The browser is signed out of iCloud. Sharing and checklists both need a signed-in " +
          "session at icloud.com/notes; no local automation on this Mac can do either without one.",
      };
    }

    saved = await evaluate<string | null>(
      cdp,
      `
      try { return await navigator.clipboard.readText(); } catch (e) { return null; }
    `,
    );

    type Picked = { ok: boolean; why?: string; saw?: string[]; url?: string };

    /**
     * The cheap, exact route: go straight to the note's own address.
     *
     * A share link works too — iCloud redirects it to the canonical note URL —
     * so whichever of the two is on file is fine. The title is still checked
     * afterwards, because a stored URL can outlive the note it pointed at.
     */
    if (opts.known) {
      await navigate(cdp, opts.known);
      await sleep(7000);
      const at = await evaluate<{ ok: boolean; url: string }>(cdp, CONFIRM_OPEN, title);
      if (at.ok) {
        lastUrl = at.url;
        return await fn(cdp);
      }
      // Fall through and search by title: the note may have been renamed, or
      // the link replaced by somebody re-sharing it.
    }

    const select = async (): Promise<Picked> => {
      const ready = await evaluate<{ ok: boolean; why?: string }>(cdp!, FIND_NOTE);
      if (!ready.ok) return { ok: false, why: ready.why };
      await clearField(cdp!);
      await typeText(cdp!, title);
      return await evaluate<Picked>(cdp!, PICK_ROW, title);
    };

    /**
     * A tab left open for hours stops reflecting reality: notes written since it
     * loaded never appear in its list, and deleted ones linger. Reloading first
     * every time would cost ten seconds on every call, so the reload is the
     * retry — the cheap path is tried once, and a miss earns one fresh page
     * before the note is declared missing.
     */
    let picked = await select();
    if (!picked.ok) {
      await navigate(cdp, NOTES_URL);
      await sleep(9000);
      picked = await select();
    }
    if (!picked.ok && picked.why !== "notfound") {
      return { ok: false as const, error: `iCloud Notes did not finish loading (${picked.why}).` };
    }
    if (!picked.ok && opts.create) {
      // The search box still holds the title and would filter the new note out
      // of the list before it has one, so clear it before composing.
      await evaluate(cdp, FIND_NOTE);
      await clearField(cdp);
      await sleep(600);
      const made = await evaluate<{ ok: boolean; why?: string }>(cdp, NEW_NOTE);
      if (!made.ok) return { ok: false as const, error: `Could not create a note (${made.why}).` };
      lastUrl = null;
      const out = await fn(cdp);
      // Only knowable after the body is written, since a note's title IS its
      // first line and an empty note has no title to search for.
      const at = await evaluate<{ ok: boolean; url: string }>(cdp, CONFIRM_OPEN, title);
      if (at.ok) lastUrl = at.url;
      return out;
    }
    if (!picked.ok) {
      const saw = picked.saw?.length ? ` Visible notes: ${picked.saw.join(", ")}.` : "";
      return {
        ok: false as const,
        error: `No note titled "${title}" exists in this iCloud account.${saw}`,
      };
    }
    lastUrl = picked.url ?? null;
    return await fn(cdp);
  } catch (e) {
    return { ok: false as const, error: (e as Error).message || String(e) };
  } finally {
    clearTimeout(stop);
    if (cdp) {
      if (saved) {
        await evaluate(
          cdp,
          `
          try { await navigator.clipboard.writeText(ARG); } catch (e) {}
          return true;
        `,
          saved,
        ).catch(() => {});
      }
      await evaluate(cdp, DISMISS).catch(() => {});
      cdp.close();
    }
  }
}
