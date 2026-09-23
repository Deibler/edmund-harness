/**
 * Writing a note by changing only the lines that differ.
 *
 * Apple Notes is a CRDT, and a device that has edited a note can resurrect text
 * another replica deleted. A whole-body select-all and paste deletes every line
 * on every write, title included, so each write left another complete copy for
 * a member's phone to bring back. Editing only changed lines means an unchanged
 * title or line is never deleted and cannot come back twice.
 *
 * The editor is a canvas with no text model, so the caret is steered by
 * keystrokes and every selection is copied back and compared before anything
 * replaces it. A note that cannot be walked that way (clipboard views that
 * disagree, a selection that is not what was counted) falls back to the
 * whole-body write, and the result says so.
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
 * The HTML says what each line is; the plain text says how far the caret moves
 * across it. Any disagreement (an attachment, a drawing) would put the caret on
 * the wrong text, so such a note is not walked at all.
 */
export function paragraphs(html: string, text: string): Para[] | null {
  if (!text) return html.trim() ? null : [];
  // Every paragraph the editor writes ends in a line break, the last included.
  // Without it the end of the note cannot be found by counting.
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
 * The fewest whole-line changes that turn `cur` into `want`, by longest common
 * subsequence. Blank paragraphs (null) are lines too; nothing asks for one, so
 * stray blanks are removed in passing.
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
 * Take the freshest tick for every checklist line. The document being written
 * was built from an earlier read, and somebody may have ticked a line since.
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
 * Put the caret at the start of paragraph `i`: Cmd+Up to the top, then Ctrl+E
 * (end of paragraph, even across wrapped rows, unlike the down arrow) and Right
 * per paragraph. Paragraph `n` of an `n`-paragraph note is the append point
 * after the last line break.
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
 * Apply one hunk. The selection to be replaced is copied back and compared
 * first, since a canvas selection cannot be inspected and one character off
 * would take a letter of the next line with it.
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
 * Record every `/records/modify` save the page makes; returns the page clock.
 *
 * A read straight after an edit only proves the editor shows it. The save goes
 * out seconds later, and that is when iCloud detects another replica's write,
 * answers CONFLICT and merges, so verification waits for the save.
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

/** Wait for a save begun after `since` to be accepted. The page merges and retries conflicts. */
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
 * Each attempt reads the note fresh, so a retry starts from whatever the last
 * attempt or a save merge left. Hunks apply bottom-up so an edit never moves
 * the lines above it. `walkable: false` means the caret cannot be steered
 * through this note and only a whole-body rewrite can make it current.
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
    // Only a save started after the last keystroke carries every edit.
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
 * Write a note line by line, falling back to a whole-body write only for an
 * empty note (nothing to delete) or one the caret cannot walk. The result says
 * which happened, so a fallback that fires every time is visible in the log.
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
