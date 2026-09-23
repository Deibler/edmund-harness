/**
 * The Chrome session that reaches iCloud Notes, and the primitives it offers.
 *
 * Notes has two halves. Locally, AppleScript can write a body but cannot invite
 * anyone (`shared` is read only and the share sheet exposes no accessibility
 * children), and it strips checklist markup. On icloud.com sharing is ordinary
 * DOM, but the note body is a `<canvas>`: the only ways in are the keyboard
 * and the clipboard. Apple's clipboard HTML carries paragraph styling as JSON
 * in `data-tt`, checklist ticks included, so a copy reads the whole note.
 *
 * This module is transport only. `notedoc.ts` decides what a note says,
 * `notepatch.ts` how a write is applied, `notes_share.ts` who is on it, and
 * `notesync.ts` when any of it happens.
 *
 * Invariants:
 *   - Every step has a deadline. This runs from the ten-second watch pass, so a
 *     wedged browser must fail in seconds rather than hold the note lock.
 *   - Navigate by the note's own URL when one is known. The note list is
 *     virtualised and recycles DOM nodes, so a title match can select a
 *     different note.
 *   - The page must believe it has focus. The canvas editor ignores keys and
 *     pastes while `document.hasFocus()` is false, which is always true of a
 *     background tab; `Emulation.setFocusEmulationEnabled` fixes that without
 *     taking focus from whoever is using the Mac.
 *   - No credentials. This borrows a signed-in browser profile; a lapsed
 *     session is reported as an error for a person to fix.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const HOST = "127.0.0.1";

/**
 * A dedicated Chrome profile and debugging port for the kitchen.
 *
 * The assistant's own browser is launched with `--remote-debugging-pipe`, so it
 * has no socket to attach to, and a copied profile does not carry the iCloud
 * session. A dedicated profile needs one sign-in and cannot be closed from
 * under a sync by somebody closing a tab.
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
 * Start the kitchen's Chrome unless one is already listening. Two processes
 * cannot share a user-data-dir, so this never launches a second copy.
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
 * Attach to a tab showing iCloud Notes, reusing one when possible.
 *
 * Uses the Target domain over the browser socket. On current Chrome the
 * `/json/list` and `/json/new` HTTP helpers report no tabs even when tabs are
 * open, which reads as a missing browser rather than a changed endpoint.
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

  // The body is read and written through the clipboard, and the canvas editor
  // ignores input unless the page believes it is focused.
  await browser
    .send("Browser.grantPermissions", {
      origin: ORIGIN,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    })
    .catch(() => {});
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});

  if (goToNotes) await navigate(page, NOTES_URL);
  // The app boots inside an iframe after the outer load event, so callers still
  // poll for what they need.
  await sleep(goToNotes ? 4000 : 1200);
  return page;
}

/* ------------------------------------------------------------------ *
 * Talking to the page
 * ------------------------------------------------------------------ */

/**
 * Run a script body in the tab and return its value.
 *
 * The app lives in a same-origin iframe, reached through `contentDocument`
 * rather than an execution context id, which changes whenever the app
 * re-frames itself. The body has `ARG`, `doc`, `all`, `label`, `byLabel` and
 * `wait` in scope.
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
 * Navigate, then wait until the tab answers a trivial expression again.
 *
 * A script dispatched while the old execution context is being torn down fails
 * with "Inspected target navigated or closed", so readiness is probed rather
 * than assumed from a fixed pause. The probe is side-effect free because it may
 * be sent any number of times.
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
 * Press a key, optionally as a named editing command. The editor acts on
 * `commands` rather than modifier bits, so Meta+A without `selectAll` does
 * nothing.
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
 * Empty the focused field with the keyboard. The search box is a controlled
 * component, so setting `.value` leaves the old query in the app's model and a
 * real note then reads as missing.
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
 * Put the caret in the note body and confirm it landed there.
 *
 * Clicks stay clear of the left margin, where a click on a checklist circle
 * toggles it. The landing is verified because a missed click leaves focus on
 * the page body, where select-all and copy return the app's own chrome as if it
 * were the note. Several points are tried since the dead spot depends on the
 * window size.
 */
export async function focusEditor(cdp: Page): Promise<boolean> {
  // Close any popover first: the share popover covers part of the editor and
  // would swallow the click.
  await evaluate(cdp, DISMISS).catch(() => {});
  await sleep(300);

  const r = await evaluate<{ x: number; y: number; w: number; h: number } | null>(cdp, EDITOR_RECT);
  if (!r) return false;

  // Past the checklist gutter (circles sit about 36px in) and clear of the
  // right-hand overlays.
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
 * The whole note body as Apple's clipboard HTML, via a real select-all and copy
 * (`withNote` restores the clipboard afterwards).
 *
 * Returns "" for an empty note and null for a failed read. The two must stay
 * distinct: every caller refuses to write on null, because rewriting a shared
 * note from a body that was never its body destroys the household's lines.
 */
export async function readBody(cdp: Page): Promise<string | null> {
  const got = await copyBody(cdp);
  if (!got) return null;
  const { html } = got;
  if (html === null) return null;
  if (!html.trim()) return "";
  // Editor content always carries Apple's paragraph styling; page chrome does
  // not, so this rejects a selection that was never in the note.
  return /data-tt=/.test(html) ? html : null;
}

/** One copy, as both of the views the clipboard carries. */
export type Copied = { html: string | null; text: string | null };

/**
 * Copy the current selection and return both clipboard views. The HTML says
 * what each line is (checklist item, tick, heading); the plain text is what the
 * caret moves through, one arrow press per character or line break.
 */
export async function copySelection(cdp: Page): Promise<Copied | null> {
  await press(cdp, "c", "KeyC", 67, { modifiers: 4, commands: ["copy"] });
  await sleep(700);
  return await evaluate<Copied | null>(
    cdp,
    `
    try {
      let html = null, text = null;
      for (const it of await navigator.clipboard.read()) {
        if (it.types.includes('text/html')) html = await (await it.getType('text/html')).text();
        if (it.types.includes('text/plain')) text = await (await it.getType('text/plain')).text();
      }
      return { html, text };
    } catch (e) { return null; }
  `,
  );
}

/** The whole note body, as both clipboard views. Null when the caret never got in. */
export async function copyBody(cdp: Page): Promise<Copied | null> {
  if (!(await focusEditor(cdp))) return null;
  await selectAll(cdp);
  await sleep(350);
  return await copySelection(cdp);
}

export type WriteResult = { ok: true; body: string } | { ok: false; why: string };

/**
 * Replace the whole note body with this HTML: select-all, then one paste.
 *
 * Only a fallback (see `notepatch.ts`): a whole-body paste deletes every line,
 * and a member's device can resurrect deleted lines as stacked copies.
 *
 * A select-all that silently misses turns the paste into an insert, and that
 * cannot be observed on a canvas. So the write only counts once the note has
 * been read back and `accepts` recognises it; a rejected write is retried,
 * since a select-all that does take replaces whatever the last attempt left.
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
 * Click the row whose title matches exactly, and confirm the app selected it.
 *
 * The list is virtualised: off-screen `.list-item` nodes keep stale titles, and
 * clicking one selects a different note. Only rows marked `on-screen` count,
 * and the row must end up `is-selected`. It polls for the matching row, since a
 * fixed pause races the search filter and iCloud syncing a recent write.
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
   * Create the note when none has this title. Off by default: only the caller
   * that writes the note's content may create one, or a second empty shared note
   * appears beside the real list.
   */
  create?: boolean;
};

/**
 * Open one note (by stored URL, else by title) and run `fn` against it.
 *
 * Restores the system clipboard afterwards, since reading a note clobbers it
 * and this runs unattended.
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
    // No Page.bringToFront: input goes to the renderer directly, and this must
    // not steal focus from whoever is using the Mac.

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

    // Direct route: the note's URL or share link (iCloud redirects the latter).
    // The title is still checked, since a stored URL can outlive its note.
    if (opts.known) {
      await navigate(cdp, opts.known);
      await sleep(7000);
      const at = await evaluate<{ ok: boolean; url: string }>(cdp, CONFIRM_OPEN, title);
      if (at.ok) {
        lastUrl = at.url;
        return await fn(cdp);
      }
      // Renamed, or re-shared under a new link: fall back to the title search.
    }

    const select = async (): Promise<Picked> => {
      const ready = await evaluate<{ ok: boolean; why?: string }>(cdp!, FIND_NOTE);
      if (!ready.ok) return { ok: false, why: ready.why };
      await clearField(cdp!);
      await typeText(cdp!, title);
      return await evaluate<Picked>(cdp!, PICK_ROW, title);
    };

    // A long-lived tab's list goes stale, so a miss earns one reload before the
    // note is declared missing.
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
      // Clear the search first, or it filters out the new, untitled note.
      await evaluate(cdp, FIND_NOTE);
      await clearField(cdp);
      await sleep(600);
      const made = await evaluate<{ ok: boolean; why?: string }>(cdp, NEW_NOTE);
      if (!made.ok) return { ok: false as const, error: `Could not create a note (${made.why}).` };
      lastUrl = null;
      const out = await fn(cdp);
      // A note's title is its first line, so its URL is only findable once the
      // body has been written.
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
