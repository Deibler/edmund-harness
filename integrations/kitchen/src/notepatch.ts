/**
 * Change only the lines of a note that need changing.
 *
 * The obvious write — select everything, paste the new list — is what filled
 * one household member's phone with the list title seven times over. Apple
 * Notes is a CRDT, and a device that has ever edited a note itself can bring
 * back text another replica deleted, then push that text back to the server.
 * Measured on this Mac in September 2026 against a scratch note: the web copy
 * stayed clean while the device kept a layer of every select-all paste. A whole-body write
 * deletes EVERY line on every pass, title included, so each pass left one more
 * complete copy for a device to resurrect.
 *
 * So a write here deletes exactly the lines that changed and nothing else. An
 * unchanged title is never touched, which means it cannot come back twice.
 *
 * The editor is a canvas with no text model to address, so the caret is steered
 * by keystrokes and every selection is copied and checked before anything is
 * pasted over it. Where the note cannot be walked that way — two clipboard views
 * that disagree, a selection that does not say what was counted — the caller's
 * whole-body write is the fallback, because a list that is current matters more
 * than one that is tidy.
 */

import {
  type Page,
  type WriteResult,
  copyBody,
  copySelection,
  evaluate,
  focusEditor,
  press,
  readBody,
  sleep,
  writeBody,
} from "./icloud.ts";
import { type Block, parseAppleHtml, sameDoc, tickKey, ticksIn, toAppleHtml } from "./notedoc.ts";

/** One paragraph as the caret sees it: its exact text, and what kind of line it is. */
export type Para = { raw: string; block: Block | null };

/**
 * The note's paragraphs, or null when the two clipboard views disagree.
 *
 * The HTML says what each line is and the plain text says how far the caret has
 * to travel across it. Steering by one while trusting the other would select the
 * wrong text the first time they differ — an attachment, a drawing, anything the
 * HTML renders as something other than characters — so any disagreement at all
 * means this note is not walked, and the caller rewrites it the old way.
 */
export function paragraphs(html: string, text: string): Para[] | null {
  if (!text) return html.trim() ? null : [];
  // Every paragraph the editor writes ends in a line break, the last one
  // included. A note that does not has come from somewhere else, and where its
  // end is cannot be reasoned about by counting.
  if (!text.endsWith("\n")) return null;
  const lines = text.slice(0, -1).split("\n");
  const chunks = html.split(/<\/p>/i).filter((c) => /<span/i.test(c));
  if (chunks.length !== lines.length) return null;

  const out: Para[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const block = parseAppleHtml(`${chunks[i]}</p>`)[0] ?? null;
    const plain = raw.replace(/\u00a0/g, " ").trim();
    if (block ? block.text.replace(/\u00a0/g, " ") !== plain : plain !== "") return null;
    out.push({ raw, block });
  }
  return out;
}

const keyOf = (b: Block | null): string =>
  b ? `${b.kind}|${b.kind === "todo" ? Boolean(b.done) : ""}|${b.text}` : "blank";

/** A run of lines to take out at `at`, and what goes in their place. */
export type Hunk = { at: number; remove: number; insert: Block[] };

/**
 * The fewest line changes that turn `cur` into `want`.
 *
 * A longest common subsequence over whole lines. Lines are the unit because a
 * line is what a person reads and ticks; rewriting part of one saves nothing
 * and makes the caret arithmetic harder. Blank paragraphs are lines too, and
 * since nothing asks for one, stray blanks are removed in passing.
 */
export function diffParas(cur: Array<Block | null>, want: Block[]): Hunk[] {
  const a = cur.map(keyOf);
  const b = want.map(keyOf);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const hunks: Hunk[] = [];
  let open: Hunk | null = null;
  let i = 0;
  let j = 0;
  const flush = () => {
    if (open && (open.remove || open.insert.length)) hunks.push(open);
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      open ??= { at: i, remove: 0, insert: [] };
      open.insert.push(want[j]!);
      j++;
    } else {
      open ??= { at: i, remove: 0, insert: [] };
      open.remove++;
      i++;
    }
  }
  flush();
  return hunks;
}

/**
 * Take the freshest tick for every checklist line.
 *
 * The list being written was built from an earlier read. Somebody in a shop can
 * tick the eggs between that read and this write, and every tick in a built
 * document came from the note in the first place, so the newer read wins.
 */
export function carryTicks(want: Block[], fresh: Block[]): Block[] {
  const ticks = ticksIn(fresh);
  return want.map((b) =>
    b.kind === "todo" && ticks.has(tickKey(b.text))
      ? { ...b, done: ticks.get(tickKey(b.text)) }
      : b,
  );
}

/** The same lines, in the same order, of the same kinds, ticked the same way. */
export function sameOrder(want: Block[], got: Block[]): boolean {
  const norm = (s: string) =>
    s
      .normalize("NFC")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/\s+/g, " ")
      .trim();
  if (want.length !== got.length) return false;
  return want.every((w, i) => {
    const g = got[i]!;
    if (w.kind !== g.kind || norm(w.text) !== norm(g.text)) return false;
    return w.kind !== "todo" || Boolean(w.done) === Boolean(g.done);
  });
}

/* ------------------------------------------------------------------ *
 * Steering the caret
 * ------------------------------------------------------------------ */

const key = (cdp: Page, name: string, code: string, vk: number, modifiers = 0) =>
  press(cdp, name, code, vk, { modifiers });

/**
 * Put the caret at the start of paragraph `i`.
 *
 * Cmd+Up is the top of the note, and Ctrl+E then Right is "the start of the
 * next paragraph". Ctrl+E is used rather than the down arrow because it goes to
 * the end of the PARAGRAPH: a long line wraps, and the arrow moves one wrapped
 * row at a time. Paragraph `n` of an `n` paragraph note is the empty spot after
 * the last line break, which is where an append goes.
 */
async function caretTo(cdp: Page, i: number): Promise<void> {
  await key(cdp, "ArrowUp", "ArrowUp", 38, 4);
  for (let k = 0; k < i; k++) {
    await key(cdp, "e", "KeyE", 69, 2);
    await key(cdp, "ArrowRight", "ArrowRight", 39);
  }
}

const graphemes = (s: string): number => [...new Intl.Segmenter().segment(s)].length;

/**
 * Apply one hunk, checking the selection before replacing it.
 *
 * The copy is the whole point. There is no way to look at a canvas selection,
 * and a selection one character off in either direction takes a letter of the
 * next line with it — which a person reads as their list quietly getting
 * corrupted. Copying it back and comparing text is the only way to know what
 * is about to be pasted over.
 */
async function applyHunk(cdp: Page, cur: Para[], h: Hunk): Promise<string | null> {
  await caretTo(cdp, h.at);
  if (h.remove) {
    const expect = cur
      .slice(h.at, h.at + h.remove)
      .map((p) => `${p.raw}\n`)
      .join("");
    const n = graphemes(expect);
    for (let k = 0; k < n; k++) await key(cdp, "ArrowRight", "ArrowRight", 39, 8);
    const got = await copySelection(cdp);
    if (got?.text !== expect) {
      await key(cdp, "ArrowLeft", "ArrowLeft", 37);
      return `the selection at line ${h.at + 1} did not hold what was counted`;
    }
  }
  if (h.insert.length) {
    const html = toAppleHtml(h.insert);
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
      { html, text: h.insert.map((b) => `${b.text}\n`).join("") },
    );
    if (!staged) return "the new lines could not be put on the clipboard";
    await press(cdp, "v", "KeyV", 86, { modifiers: 4, commands: ["paste"] });
  } else {
    await key(cdp, "Backspace", "Backspace", 8);
  }
  await sleep(250);
  return null;
}

/* ------------------------------------------------------------------ *
 * Waiting for the save
 * ------------------------------------------------------------------ */

/**
 * Start noting every save the page makes. Returns the page's clock.
 *
 * Reading the note back straight after an edit only proves the editor shows it.
 * The save goes out about six seconds later, and it is at save time that iCloud
 * notices another replica wrote first, answers CONFLICT, and merges — which is
 * the other way a note ends up with two copies of itself. A read taken before
 * that merge cannot see it, so the check waits for the save.
 */
const WATCH_SAVES = `
  const f = document.querySelector('iframe');
  const w = (f && f.contentWindow) || window;
  if (!w.__kitchenSaves) {
    w.__kitchenSaves = [];
    const original = w.fetch.bind(w);
    w.fetch = async (input, init) => {
      const url = String((input && input.url) || input);
      const started = Date.now();
      const res = await original(input, init);
      if (/\\/records\\/modify/.test(url)) {
        let body = '';
        try { body = await res.clone().text(); } catch (e) {}
        w.__kitchenSaves.push({ started, status: res.status, conflict: /CONFLICT|oplock/.test(body) });
      }
      return res;
    };
  }
  return Date.now();
`;

const SAVES_SINCE = `
  const f = document.querySelector('iframe');
  const w = (f && f.contentWindow) || window;
  return (w.__kitchenSaves || []).filter((s) => s.started >= ARG);
`;

type Save = { started: number; status: number; conflict: boolean };

/** Wait for a save that began after `since` to be accepted. Conflicts are merged and retried by the page. */
async function waitForSave(
  cdp: Page,
  since: number,
  ms = 20_000,
): Promise<{ saved: boolean; conflicts: number }> {
  const until = Date.now() + ms;
  let conflicts = 0;
  while (Date.now() < until) {
    const saves = (await evaluate<Save[]>(cdp, SAVES_SINCE, since).catch(() => [])) ?? [];
    conflicts = saves.filter((s) => s.conflict).length;
    if (saves.some((s) => s.status === 200 && !s.conflict)) return { saved: true, conflicts };
    await sleep(500);
  }
  return { saved: false, conflicts };
}

/* ------------------------------------------------------------------ *
 * The write
 * ------------------------------------------------------------------ */

export type PatchResult =
  | (WriteResult & { ok: true; hunks: number; saved: boolean; conflicts: number })
  | { ok: false; why: string; walkable: boolean };

/**
 * Make the note say `want`, touching only the lines that differ.
 *
 * Each attempt reads the note fresh, so a second attempt starts from whatever
 * the first one — or a concurrent save merge — actually left. Hunks go in from
 * the bottom up so an edit never moves the lines above it.
 *
 * `walkable: false` on a failure means the note could not be steered through at
 * all, and a whole-body rewrite is the only way left to make it current.
 */
export async function patchBody(cdp: Page, want: Block[], attempts = 3): Promise<PatchResult> {
  let why = "the note never came back saying what was written to it";
  for (let n = 0; n < attempts; n++) {
    const copied = await copyBody(cdp);
    if (!copied || copied.html === null || copied.text === null) {
      return { ok: false, why: "the note body could not be read", walkable: true };
    }
    const cur = paragraphs(copied.html, copied.text);
    if (!cur)
      return { ok: false, why: "the note has lines that cannot be counted", walkable: false };

    const target = carryTicks(want, parseAppleHtml(copied.html));
    const hunks = diffParas(
      cur.map((p) => p.block),
      target,
    );
    if (!hunks.length && n === 0) {
      return { ok: true, body: copied.html, hunks: 0, saved: true, conflicts: 0 };
    }

    await evaluate<number>(cdp, WATCH_SAVES);
    if (!(await focusEditor(cdp)))
      return { ok: false, why: "the caret would not go into the note body", walkable: true };
    for (const h of [...hunks].reverse()) {
      const failed = await applyHunk(cdp, cur, h);
      if (failed) return { ok: false, why: failed, walkable: false };
    }
    // Only a save that STARTED after the last keystroke carries all of them.
    const since = await evaluate<number>(cdp, "return Date.now();");
    const saved = hunks.length ? await waitForSave(cdp, since) : { saved: true, conflicts: 0 };

    const body = await readBody(cdp);
    if (body === null) {
      why = "the note could not be read back after writing";
      continue;
    }
    if (sameOrder(target, parseAppleHtml(body))) {
      return { ok: true, body, hunks: hunks.length, ...saved };
    }
    why = "the note did not come back saying what was written to it";
  }
  return { ok: false, why, walkable: true };
}

/**
 * Write a note the careful way, falling back to a whole-body write only when
 * the careful way cannot be taken.
 *
 * An empty note has nothing to delete, so there is nothing a whole-body paste
 * could leave behind, and it goes straight to that. Otherwise the fallback is
 * only for a note the caret cannot be steered through, and the result says so,
 * because a fallback that happens every time is the old bug back.
 */
export async function writeNote(
  cdp: Page,
  want: Block[],
  hasBody: boolean,
): Promise<{ ok: true; how: string } | { ok: false; why: string }> {
  const whole = async (reason: string) => {
    const w = await writeBody(cdp, toAppleHtml(want), (body) =>
      sameDoc(want, parseAppleHtml(body)),
    );
    return w.ok ? { ok: true as const, how: `rewrote the whole note (${reason})` } : w;
  };
  if (!hasBody) return await whole("it was empty");

  const p = await patchBody(cdp, want);
  if (p.ok) {
    const lines = p.hunks === 1 ? "1 change" : `${p.hunks} changes`;
    const save = p.saved ? "" : ", save not seen";
    const merged = p.conflicts ? `, ${p.conflicts} merged` : "";
    return { ok: true, how: `${lines}${save}${merged}` };
  }
  if (!p.walkable) return await whole(p.why);
  return { ok: false, why: p.why };
}
