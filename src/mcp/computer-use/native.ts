/**
 * Client for the Swift helper that captures the screen and posts input.
 *
 * The helper is compiled from `native/helper.swift` on first use and cached
 * by a hash of its source, so an edit rebuilds it and nothing is committed as
 * a binary. One helper process serves one MCP server process, answering one
 * JSON request per line.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const SOURCE = join(import.meta.dir, "native", "helper.swift");
const REQUEST_TIMEOUT_MS = 30_000;
/** How long quitting waits for apps to exit before reporting them still open. */
const QUIT_WAIT_MS = 5_000;

export type Display = {
  id: number;
  name: string;
  /** Global points, origin at the top-left of the main display. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Physical pixels per point. */
  scale: number;
  main: boolean;
};

export type RunningApp = {
  bundleId: string;
  name: string;
  pid: number;
  hidden: boolean;
  /** An ordinary app with a Dock icon and windows, as opposed to an agent. */
  regular: boolean;
};

export type InstalledApp = { bundleId: string; name: string; displayName: string; path: string };

/**
 * An element on screen and the app that owns it: what a click at a point, or
 * a keystroke into the focused field, would reach. `role` is "desktop" over
 * bare desktop. The descriptive fields are absent when only window
 * information was available.
 */
export type PointOwner = {
  pid: number;
  bundleId: string;
  name: string;
  role: string;
  subrole?: string;
  /** Title, description, placeholder or help text, whichever is set. */
  label?: string;
  /** Current value, clipped; always empty for a password field. */
  value?: string;
  /** Title of the window it is in. */
  window?: string;
  /** A password field. */
  secure?: boolean;
  /** The element's accessibility identifier, when the app sets one. */
  identifier?: string;
  /** Identifiers of its ancestors, nearest first. */
  ancestors?: string[];
  /**
   * For the focused element only, when it edits text (never a password
   * field): the selection, and the text in it and either side of it.
   */
  selection?: { location: number; length: number };
  selectedText?: string;
  textBefore?: string;
  textAfter?: string;
};

/** One window and its named elements, as `inspect` finds them. */
export type InspectedWindow = {
  title: string;
  frame?: Rect;
  found: Record<
    string,
    { frame?: Rect; value: string; rows: Array<{ text: string; frame: Rect }> }
  >;
};

/** An app's windows, front first. */
export type Inspection = { running: boolean; windows: InspectedWindow[] };

export type Permissions = { screenRecording: boolean; accessibility: boolean; locked: boolean };

export type Capture = { data: string; width: number; height: number };

/** Names of the apps that exited, and of those still open (asking to save, say). */
export type QuitResult = { quit: string[]; stillOpen: string[] };

/**
 * `exclude` leaves those apps out; `include`, when set, captures only those
 * apps' windows over black, so nothing else on screen can reach the image.
 */
export type CaptureOptions = {
  display: number;
  exclude: string[];
  include?: string[];
  /** Global-point rectangles painted black before the image leaves the helper. */
  redact?: Rect[];
  width: number;
  height: number;
  rect?: Rect;
};

/**
 * What a settle watches: the apps a capture would show, over `rect` (the
 * display below its menu bar, whose clock and status icons never stop), at
 * `width`x`height`. No image ever leaves the helper.
 */
export type SettleView = {
  display: number;
  exclude: string[];
  include?: string[];
  rect: Rect;
  width: number;
  height: number;
};

export type SettleResult = { ms: number; settled: boolean };

/** A rectangle in points: display-local for a zoom, global elsewhere. */
export type Rect = { x: number; y: number; width: number; height: number };

export type Button = "left" | "right" | "middle";

/** One key of a chord: its virtual key code and, for a modifier, its flag mask. */
export type Chord = { modifiers: Array<[code: number, mask: number]>; keys: number[] };

/** Everything the session needs from the machine. Tests substitute a fake. */
export interface Native {
  permissions(): Promise<Permissions>;
  displays(): Promise<Display[]>;
  frontmost(): Promise<RunningApp | null>;
  running(): Promise<RunningApp[]>;
  ownerAt(x: number, y: number): Promise<PointOwner>;
  focused(): Promise<PointOwner | null>;
  /** An app's windows, front first, and their elements with these identifiers. */
  inspect(bundleId: string, ids: string[]): Promise<Inspection>;
  hide(bundleIds: string[]): Promise<string[]>;
  installedApps(): Promise<InstalledApp[]>;
  open(bundleId: string): Promise<RunningApp>;
  /** Quit these exact processes, never forcing; says which exited and which did not. */
  quit(apps: Array<{ pid: number; bundleId: string }>): Promise<QuitResult>;
  capture(opts: CaptureOptions): Promise<Capture>;
  /** Remember the screen as `settle` will see it, just before an action. */
  settleMark(view: SettleView): Promise<void>;
  /**
   * Wait for the action's effect: until the screen differs from the marked
   * frame by `minChanged` pixels and then holds still for `quietMs`, or
   * `maxMs` passes. Nothing seen changing means the whole `maxMs`.
   */
  settleWait(
    view: SettleView & { maxMs: number; quietMs: number; minChanged: number },
  ): Promise<SettleResult>;
  cursor(): Promise<{ x: number; y: number }>;
  click(x: number, y: number, button: Button, count: number, flags: number): Promise<void>;
  move(x: number, y: number, held: Button | null): Promise<void>;
  buttonDown(button: Button): Promise<void>;
  buttonUp(button: Button): Promise<void>;
  drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void>;
  scroll(x: number, y: number, dx: number, dy: number, flags: number): Promise<void>;
  chord(chord: Chord, opts?: { repeat?: number; holdMs?: number }): Promise<void>;
  type(text: string): Promise<void>;
  clipboardRead(): Promise<string | null>;
  clipboardWrite(text: string): Promise<void>;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class NativeHelper implements Native {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  permissions() {
    return this.call<Permissions>("permissions");
  }
  displays() {
    return this.call<Display[]>("displays");
  }
  frontmost() {
    return this.call<RunningApp | null>("frontmost");
  }
  running() {
    return this.call<RunningApp[]>("running");
  }
  ownerAt(x: number, y: number) {
    return this.call<PointOwner>("owner_at", { x, y });
  }
  focused() {
    return this.call<PointOwner | null>("focused");
  }
  inspect(bundleId: string, ids: string[]) {
    return this.call<Inspection>("inspect", { bundleId, ids });
  }
  hide(bundleIds: string[]) {
    return this.call<string[]>("hide", { bundleIds });
  }
  installedApps() {
    return this.call<InstalledApp[]>("installed_apps");
  }
  open(bundleId: string) {
    return this.call<RunningApp>("open", { bundleId });
  }
  quit(apps: Array<{ pid: number; bundleId: string }>) {
    return this.call<QuitResult>("quit", { apps, timeoutMs: QUIT_WAIT_MS });
  }
  capture(opts: CaptureOptions) {
    return this.call<Capture>("capture", opts);
  }
  async settleMark(view: SettleView) {
    await this.call("settle_mark", view);
  }
  settleWait(view: SettleView & { maxMs: number; quietMs: number; minChanged: number }) {
    return this.call<SettleResult>("settle", view);
  }
  cursor() {
    return this.call<{ x: number; y: number }>("cursor");
  }
  async click(x: number, y: number, button: Button, count: number, flags: number) {
    await this.call("click", { x, y, button, count, flags });
  }
  async move(x: number, y: number, held: Button | null) {
    await this.call("move", held ? { x, y, held } : { x, y });
  }
  async buttonDown(button: Button) {
    await this.call("button_down", { button });
  }
  async buttonUp(button: Button) {
    await this.call("button_up", { button });
  }
  async drag(from: { x: number; y: number }, to: { x: number; y: number }) {
    await this.call("drag", { fromX: from.x, fromY: from.y, x: to.x, y: to.y });
  }
  async scroll(x: number, y: number, dx: number, dy: number, flags: number) {
    await this.call("scroll", { x, y, dx, dy, flags });
  }
  async chord(chord: Chord, opts: { repeat?: number; holdMs?: number } = {}) {
    await this.call("chord", { ...chord, repeat: opts.repeat ?? 1, hold: opts.holdMs ?? 0 });
  }
  async type(text: string) {
    await this.call("type", { text });
  }
  async clipboardRead() {
    return (await this.call<{ text: string | null }>("clipboard_read")).text;
  }
  async clipboardWrite(text: string) {
    await this.call("clipboard_write", { text });
  }

  /** Stop the helper. It also exits by itself when this process's stdin closes. */
  close(): void {
    this.proc?.kill();
    this.proc = null;
  }

  private call<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const proc = this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the screen helper did not answer "${cmd}" within 30s`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      proc.stdin?.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
  }

  private start(): ChildProcess {
    if (this.proc) return this.proc;
    const proc = spawn(helperBinary(), [], { stdio: ["pipe", "pipe", "inherit"] });
    createInterface({ input: proc.stdout! }).on("line", (line) => this.settle(line));
    proc.on("exit", () => {
      this.proc = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("the screen helper exited"));
      }
      this.pending.clear();
    });
    this.proc = proc;
    return proc;
  }

  private settle(line: string): void {
    let msg: { id: number; ok: boolean; result?: unknown; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? "the screen helper failed"));
  }
}

/**
 * The compiled helper for the current source, building it if needed. Builds
 * go to a temporary name and are renamed into place, so two sessions starting
 * at once cannot run a half-written binary.
 */
export function helperBinary(): string {
  const source = readFileSync(SOURCE);
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const dir = join(homedir(), "Library", "Caches", "edmund-harness", "computer-use");
  const bin = join(dir, `helper-${hash}`);
  if (existsSync(bin)) return bin;

  mkdirSync(dir, { recursive: true });
  const tmp = `${bin}.${process.pid}.tmp`;
  const built = spawnSync("swiftc", ["-O", "-swift-version", "5", "-o", tmp, SOURCE], {
    encoding: "utf8",
    timeout: 180_000,
  });
  if (built.status !== 0) {
    throw new Error(
      `could not build the screen helper (swiftc exit ${built.status}): ${(built.stderr || built.error?.message || "").slice(0, 400)}`,
    );
  }
  renameSync(tmp, bin);
  // Builds of older sources are never used again.
  for (const name of readdirSync(dir)) {
    if (name.startsWith("helper-") && join(dir, name) !== bin && !name.endsWith(".tmp")) {
      rmSync(join(dir, name), { force: true });
    }
  }
  return bin;
}
