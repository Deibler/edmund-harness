import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SAME_COLOR, colorDistance } from "./color.ts";
import type { Tray } from "./report.ts";

/**
 * Sending prints through Bambu Connect, so the printer can stay in cloud mode
 * with Bambu Handy working.
 *
 * Bambu's firmware takes start and stop only from Bambu's own signed apps
 * unless Developer Mode is on, and the P2S offers Developer Mode only in LAN
 * Only Mode, which cuts Handy off. Bambu Connect is Bambu's route for other
 * software: it takes a sliced file through its bambu-connect:// link and
 * sends it once someone presses Send. The runtime presses Send for the
 * approver, behind the same gate as every other start.
 *
 * It drives the app through macOS Accessibility (native/connect.swift).
 * Bambu Connect exits when started with a debugging port, but its interface
 * is fully labelled, so every control is found by role and label, never by
 * screen position. The readers below are pure and tested against saved
 * screens; the driver presses only controls on an allowlist, inside the app's
 * window, and refuses anything that logs out, unbinds or pauses.
 */

export const CONNECT_APP = "/Applications/Bambu Connect.app";
const PROCESS_NAME = "Bambu Connect";
const SOURCE = join(import.meta.dir, "..", "native", "connect.swift");

export type AxNode = {
  path: string;
  role: string;
  title?: string;
  desc?: string;
  value?: string;
  id?: string;
  class?: string;
  disabled?: boolean;
  children?: AxNode[];
};

/* ── reading the screens ──────────────────────────────────────────────── */

export function findAll(n: AxNode, pred: (n: AxNode) => boolean, out: AxNode[] = []): AxNode[] {
  if (pred(n)) out.push(n);
  for (const c of n.children ?? []) findAll(c, pred, out);
  return out;
}

export function find(n: AxNode, pred: (n: AxNode) => boolean): AxNode | null {
  if (pred(n)) return n;
  for (const c of n.children ?? []) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
}

/** The static text in a subtree, in reading order. */
export function texts(n: AxNode): string[] {
  return findAll(n, (x) => x.role === "AXStaticText" && !!x.value).map((x) => x.value as string);
}

function classes(n: AxNode): string[] {
  return (n.class ?? "").split(/\s+/).filter(Boolean);
}

/** Bambu Connect's own windows; the menu bar beside them holds the system menu. */
function windows(tree: AxNode): AxNode[] {
  return (tree.children ?? []).filter((c) => c.role === "AXWindow");
}

/** The open dialog and its title. Semi dialogs put an id'd heading inside the dialog group. */
export function openModal(tree: AxNode): { title: string; node: AxNode } | null {
  for (const w of windows(tree)) {
    const dialog = find(w, (n) =>
      (n.children ?? []).some((c) => c.role === "AXHeading" && c.id === "semi-modal-title"),
    );
    if (dialog) {
      const heading = (dialog.children ?? []).find((c) => c.id === "semi-modal-title");
      return { title: heading?.title || texts(heading ?? dialog)[0] || "", node: dialog };
    }
  }
  return null;
}

/** The modal's own Cancel (or its close cross when it has none). */
function modalExit(m: AxNode): AxNode | null {
  return (
    find(m, (n) => n.role === "AXButton" && n.desc === "cancel") ??
    find(m, (n) => n.role === "AXButton" && n.desc === "close")
  );
}

/**
 * Bambu Connect shows a file name HTML-escaped ("Sam&#39;s") and with
 * ".3mf" added. This undoes both, so a name can be compared with what was sent.
 */
export function shownName(shown: string): string {
  return shown
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(Number.parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\.3mf$/i, "");
}

export type ImportScreen = { file: string; confirm: AxNode; cancel: AxNode | null };

/** "You will import the file "X"." with its Import Gcode 3MF button. */
export function readImport(tree: AxNode): ImportScreen | null {
  const m = openModal(tree);
  if (!m || m.title !== "Import file") return null;
  const said = texts(m.node).find((t) => t.startsWith("You will import the file"));
  const confirm = find(m.node, (n) => n.role === "AXButton" && n.desc === "confirm");
  if (!said || !confirm) return null;
  return { file: shownName(said.match(/"(.*)"/)?.[1] ?? ""), confirm, cancel: modalExit(m.node) };
}

export type PrintPage = {
  /** The file shown, as Bambu Connect names it ("Cube.3mf"). */
  file: string;
  print: AxNode;
  plates: { n: number; node: AxNode }[];
  /** The summary card: Compatible Printer, Bed type, Filaments, Time, Weight. */
  details: Record<string, string>;
};

export function readPrintPage(tree: AxNode): PrintPage | null {
  if (openModal(tree)) return null;
  const w = windows(tree)[0];
  if (!w) return null;
  const picker = find(w, (n) => n.role === "AXPopUpButton" && /\.3mf\b/i.test(n.title ?? ""));
  const print = find(w, (n) => n.role === "AXButton" && n.title === "Print");
  if (!picker || !print) return null;
  const plates = findAll(w, (n) => n.role === "AXButton" && /^\d+$/.test(n.title ?? "")).map(
    (node) => ({ n: Number(node.title), node }),
  );
  const t = texts(w);
  const details: Record<string, string> = {};
  for (let i = 0; i + 2 < t.length; i++) {
    const [key, colon, value] = [t[i], t[i + 1], t[i + 2]];
    if (colon === ":" && key && value !== undefined && !(key in details)) details[key] = value;
  }
  return { file: texts(picker)[0] ?? picker.title ?? "", print, plates, details };
}

export type SendDialog = {
  printer: string;
  bed: string;
  /** One per filament the plate uses, in the file's order: the slot Bambu Connect chose. */
  filaments: { slot: string; type: string }[];
  options: Record<string, { checked: string | null; choices: Record<string, AxNode> }>;
  send: AxNode;
  cancel: AxNode | null;
};

const SLOT = /^([A-H][1-4]|Ext)\b/;

export function readSendDialog(tree: AxNode): SendDialog | null {
  const m = openModal(tree);
  if (!m || m.title !== "Send to print") return null;
  const body = find(m.node, (n) => n.id === "semi-modal-body");
  const send = find(m.node, (n) => n.role === "AXButton" && n.desc === "confirm");
  if (!body || !send) return null;
  const parts = body.children ?? [];

  const printerGroup = parts.find((p) => / chevron_down$/.test(p.desc ?? ""));
  const printer = printerGroup ? (printerGroup.desc as string).replace(/ chevron_down$/, "") : "";

  let bed = "";
  parts.forEach((p, i) => {
    if (!bed && p.role === "AXImage" && /bed/i.test(p.desc ?? "")) {
      const next = parts[i + 1];
      if (next?.role === "AXStaticText") bed = next.value ?? "";
    }
  });

  const filaments = findAll(body, (n) => n.role === "AXGroup" && SLOT.test(n.desc ?? "")).map(
    (n) => {
      const [slot, ...type] = (n.desc as string).split(/\s+/);
      return { slot: slot as string, type: type.join(" ") };
    },
  );

  // An option is a label followed by a radio group of choices.
  const options: SendDialog["options"] = {};
  parts.forEach((p, i) => {
    const group = parts[i + 1];
    if (!group || !classes(group).includes("semi-radioGroup")) return;
    const name = texts(p)[0];
    if (!name) return;
    const choices: Record<string, AxNode> = {};
    let checked: string | null = null;
    for (const wrap of group.children ?? []) {
      const radio = find(wrap, (n) => n.role === "AXRadioButton");
      if (!radio?.title) continue;
      choices[radio.title] = radio;
      if (classes(wrap).includes("semi-radio-checked") || radio.value === "1")
        checked = radio.title;
    }
    options[name] = { checked, choices };
  });

  return { printer, bed, filaments, options, send, cancel: modalExit(m.node) };
}

/** Bambu Connect's name for a tray: "A1".."A4" for the first AMS, "Ext" for the spool holder. */
export function slotName(tray: { unit: number; slot: number }): string {
  if (tray.unit === 255 || tray.unit === 254) return "Ext";
  return `${String.fromCharCode(65 + tray.unit)}${tray.slot + 1}`;
}

/** Two slot names that hold the same loaded filament: same material, same color to the eye. */
export function sameFilament(trays: Tray[]): (a: string, b: string) => boolean {
  const by = new Map(trays.map((t) => [slotName(t), t]));
  return (a, b) => {
    const x = by.get(a);
    const y = by.get(b);
    return (
      !!x?.loaded &&
      !!y?.loaded &&
      x.type === y.type &&
      colorDistance(x.color, y.color) <= SAME_COLOR
    );
  };
}

/** Everything about the send dialog that must match the approved job before Send is pressed. */
export function checkSendDialog(
  d: SendDialog,
  want: {
    printer: string;
    slots: string[];
    timelapse: boolean;
    /** True when two slots hold the same filament (type and color), so either feeds the plan. */
    alike?: (a: string, b: string) => boolean;
  },
): string[] {
  const p: string[] = [];
  if (!want.printer) p.push("The printer's name on the Bambu account is unknown.");
  else if (d.printer !== want.printer) {
    p.push(`Bambu Connect has "${d.printer || "no printer"}" selected, not "${want.printer}".`);
  }
  if (d.filaments.length !== want.slots.length) {
    p.push(
      `Bambu Connect lists ${d.filaments.length} filament(s) for this plate; the plan has ${want.slots.length}.`,
    );
  } else {
    d.filaments.forEach((f, i) => {
      const planned = want.slots[i] as string;
      if (f.slot !== planned && !want.alike?.(f.slot, planned)) {
        p.push(
          `Bambu Connect would feed filament ${i + 1} from ${f.slot}; the approved plan uses ${want.slots[i]}.`,
        );
      }
    });
  }
  const tl = d.options.Timelapse?.checked;
  if (tl !== (want.timelapse ? "On" : "Off")) {
    p.push(`Timelapse is ${tl ?? "unset"} in Bambu Connect, not ${want.timelapse ? "On" : "Off"}.`);
  }
  return p;
}

/**
 * Controls the driver may press, by label. Anything that logs out, unbinds,
 * deletes or pauses is refused even if a screen ever labels it like these.
 */
const PRESSABLE = /^(Import Gcode 3MF|Print|Send|Cancel|close|On|Off|Auto|\d+)$/;
const NEVER = /log ?out|unlink|unbind|delete|remove|pause|firmware|update/i;

export function mayPress(tree: AxNode, n: AxNode): string | null {
  const top = Number(n.path.split(".")[0]);
  if (tree.children?.[top]?.role !== "AXWindow") return "it is outside Bambu Connect's window";
  // What the button says on screen; "confirm" is only its role in a dialog.
  const label = texts(n).join(" ") || n.title || n.desc || "";
  if (NEVER.test(label) || NEVER.test(n.title ?? "") || NEVER.test(n.desc ?? ""))
    return `"${label}" is never pressed`;
  if (!PRESSABLE.test(label)) return `"${label}" is not on the list of controls Edmund presses`;
  if (n.disabled) return `"${label}" is disabled`;
  return null;
}

/* ── the driver ───────────────────────────────────────────────────────── */

/**
 * The compiled helper for the current source, built on first use. Builds go
 * to a temporary name and are renamed into place.
 */
export function helperBinary(): string {
  const source = readFileSync(SOURCE);
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const dir = join(homedir(), "Library", "Caches", "edmund-harness", "printer");
  const bin = join(dir, `connect-${hash}`);
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  const tmp = `${bin}.${process.pid}.tmp`;
  const built = spawnSync("swiftc", ["-O", "-swift-version", "5", "-o", tmp, SOURCE], {
    encoding: "utf8",
    timeout: 180_000,
  });
  if (built.status !== 0) {
    throw new Error(
      `could not build the Bambu Connect helper (swiftc exit ${built.status}): ${(built.stderr || built.error?.message || "").slice(0, 400)}`,
    );
  }
  renameSync(tmp, bin);
  for (const name of readdirSync(dir)) {
    if (name.startsWith("connect-") && join(dir, name) !== bin && !name.endsWith(".tmp")) {
      rmSync(join(dir, name), { force: true });
    }
  }
  return bin;
}

export type SendRequest = {
  /** The sliced .gcode.3mf. */
  file: string;
  /**
   * What Bambu Connect calls the file, and so the task name the printer
   * reports. Plain letters, digits, spaces, dashes and underscores: it shows
   * anything else HTML-escaped.
   */
  name: string;
  plate: number;
  /** The printer's name on the Bambu account, looked up by serial. */
  printer: string;
  /** Bambu Connect slot names in filament order, from the approved plan. */
  slots: string[];
  /** Slots holding the same filament, either of which feeds the plan. */
  alike?: (a: string, b: string) => boolean;
  timelapse: boolean;
  /** Stop at the send dialog and cancel it: everything is checked, nothing is sent. */
  dryRun?: boolean;
};

export type SendOutcome = { ok: boolean; problems: string[]; seen: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long an import may take: a minute, plus ten seconds a megabyte, up to six minutes. */
export function importWaitMs(bytes: number): number {
  return Math.min(360_000, 60_000 + (bytes / 1_000_000) * 10_000);
}

export class BambuConnect {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: { app?: string; log?: (msg: string) => void } = {}) {}

  get app(): string {
    return this.opts.app || CONNECT_APP;
  }

  available(): boolean {
    return existsSync(this.app);
  }

  /** One conversation with the app at a time. */
  private exclusive<T>(f: () => Promise<T>): Promise<T> {
    const run = this.queue.then(f, f);
    this.queue = run.catch(() => {});
    return run;
  }

  private pid(): number | null {
    const r = spawnSync("pgrep", ["-x", PROCESS_NAME], { encoding: "utf8" });
    const first = r.stdout.split("\n").find(Boolean);
    return first ? Number(first) : null;
  }

  private tree(pid: number): AxNode {
    const r = spawnSync(helperBinary(), ["tree", String(pid)], {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const parsed = JSON.parse(r.stdout || "{}") as AxNode & { error?: string };
    if (parsed.error) throw new Error(parsed.error);
    return parsed;
  }

  private press(pid: number, tree: AxNode, n: AxNode): void {
    const refused = mayPress(tree, n);
    if (refused) throw new Error(`Not pressing it: ${refused}.`);
    const r = spawnSync(helperBinary(), ["press", String(pid), n.path], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const out = JSON.parse(r.stdout || "{}") as { error?: string };
    if (out.error) throw new Error(out.error);
    this.opts.log?.(`bambu connect: pressed "${texts(n).join(" ") || n.title || n.desc}"`);
  }

  private async waitFor<T>(
    pid: number,
    read: (t: AxNode) => T | null,
    ms: number,
    what: string,
  ): Promise<{ value: T; tree: AxNode }> {
    const end = Date.now() + ms;
    let last: AxNode | null = null;
    while (Date.now() < end) {
      last = this.tree(pid);
      const value = read(last);
      if (value) return { value, tree: last };
      await sleep(400);
    }
    const m = last ? openModal(last) : null;
    throw new Error(
      `Bambu Connect did not show ${what} within ${Math.round(ms / 1000)} s${m ? ` (it shows "${m.title}")` : ""}.`,
    );
  }

  private async running(): Promise<number> {
    let pid = this.pid();
    if (!pid) {
      spawnSync("open", ["-g", "-a", this.app]);
      const end = Date.now() + 40_000;
      while (!pid && Date.now() < end) {
        await sleep(500);
        pid = this.pid();
      }
      if (!pid) throw new Error("Bambu Connect did not start.");
    }
    // Ready once the window shows a page.
    await this.waitFor(
      pid,
      (t) => (windows(t).length && texts(t).length ? true : null),
      30_000,
      "its window",
    );
    return pid;
  }

  /** Closes whatever dialog is open, so a run never starts inside someone else's. */
  private async clear(pid: number): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const t = this.tree(pid);
      const m = openModal(t);
      if (!m) return;
      const exit = modalExit(m.node);
      if (!exit) throw new Error(`Bambu Connect has "${m.title}" open and no way to close it.`);
      this.press(pid, t, exit);
      await sleep(600);
    }
  }

  /** Imports the file, checks the send dialog against the approved job, and presses Send. */
  send(req: SendRequest): Promise<SendOutcome> {
    return this.exclusive(async () => {
      const pid = await this.running();
      await this.clear(pid);
      try {
        return await this.sendIn(pid, req);
      } catch (e) {
        // Leave nothing half done on screen for the next run or a person.
        await this.clear(pid).catch(() => {});
        throw e;
      }
    });
  }

  private async sendIn(pid: number, req: SendRequest): Promise<SendOutcome> {
    const link = `bambu-connect://import-file?path=${encodeURIComponent(req.file)}&name=${encodeURIComponent(req.name)}&version=1.0.0`;
    const opened = spawnSync("open", ["-g", link], { encoding: "utf8" });
    if (opened.status !== 0)
      throw new Error(`Could not open Bambu Connect's import link: ${opened.stderr}`);

    const imp = await this.waitFor(
      pid,
      (t) => {
        const s = readImport(t);
        return s && s.file === req.name ? s : null;
      },
      20_000,
      `the import of "${req.name}"`,
    );
    this.press(pid, imp.tree, imp.value.confirm);

    // A press that lands while Bambu Connect is still reading a big file is
    // dropped and the dialog just stays (a 22 MB three-color print sat on it;
    // a 50 KB part never did). So while the dialog still shows this file,
    // press Import again every few seconds, until the print page shows it.
    const waitMs = importWaitMs(statSync(req.file).size);
    const deadline = Date.now() + waitMs;
    let pressedAt = Date.now();
    let page: { value: PrintPage; tree: AxNode } | null = null;
    while (!page) {
      await sleep(1000);
      const t = this.tree(pid);
      const shown = readPrintPage(t);
      if (shown && shownName(shown.file) === req.name) {
        page = { value: shown, tree: t };
        break;
      }
      if (Date.now() > deadline) {
        const m = openModal(t);
        throw new Error(
          `Bambu Connect did not take "${req.name}" within ${Math.round(waitMs / 1000)} s${m ? ` (it shows "${m.title}")` : ""}.`,
        );
      }
      const still = readImport(t);
      if (still && still.file === req.name && Date.now() - pressedAt >= 5_000) {
        this.press(pid, t, still.confirm);
        pressedAt = Date.now();
      }
    }
    if (page.value.plates.length > 1) {
      const plate = page.value.plates.find((p) => p.n === req.plate);
      if (!plate) {
        return {
          ok: false,
          problems: [`The file has no plate ${req.plate} in Bambu Connect.`],
          seen: "",
        };
      }
      this.press(pid, page.tree, plate.node);
      await sleep(500);
    }
    const ready = await this.waitFor(pid, readPrintPage, 5_000, "the print button");
    this.press(pid, ready.tree, ready.value.print);

    let dlg = await this.waitFor(pid, readSendDialog, 20_000, "the send dialog");
    const wantTl = req.timelapse ? "On" : "Off";
    const tl = dlg.value.options.Timelapse;
    if (tl && tl.checked !== wantTl && tl.choices[wantTl]) {
      this.press(pid, dlg.tree, tl.choices[wantTl] as AxNode);
      await sleep(400);
      dlg = await this.waitFor(pid, readSendDialog, 5_000, "the send dialog");
    }
    const d = dlg.value;
    const seen = `printer "${d.printer}", bed ${d.bed || "?"}, filament ${d.filaments.map((f) => `${f.slot} ${f.type}`).join(", ") || "none"}, ${Object.entries(
      d.options,
    )
      .map(([k, v]) => `${k} ${v.checked ?? "?"}`)
      .join(", ")}`;
    const problems = checkSendDialog(d, req);
    if (problems.length || req.dryRun) {
      if (d.cancel) this.press(pid, dlg.tree, d.cancel);
      return { ok: problems.length === 0, problems, seen };
    }
    this.press(pid, dlg.tree, d.send);
    // The dialog closes when Bambu Connect has taken the job; an error keeps it open.
    await this.waitFor(pid, (t) => (readSendDialog(t) ? null : true), 60_000, "the send finishing");
    return { ok: true, problems: [], seen };
  }
}
