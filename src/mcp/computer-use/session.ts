/**
 * One conversation's hold on the screen: its grants, the screenshot its
 * coordinates refer to, and every action behind the gates.
 *
 * The gates, in the order an action meets them:
 *  1. the [computer_use] policy, read again now, still covers this session,
 *     and something is granted under it (grants it no longer allows are
 *     taken back);
 *  2. this conversation holds the screen lock (waiting while another
 *     conversation finishes), and the Mac is not locked;
 *  3. the frontmost app is granted, and its tier allows the action;
 *  4. for anything aimed at a point, the app that owns that point is granted
 *     too, since a click reaches whatever is under it, not the frontmost app.
 *     The desktop and the Dock count as Finder;
 *  5. fixed refusals that need no judgment: ending the session or quitting
 *     Messages, by shortcut or by the menu item it stands for (keys.ts);
 *     entering text in a password field, by typing or by key; and replacing
 *     a whole note in Notes after Select All;
 *  6. scope: in Messages, only the conversation the request came from; in
 *     Notes, never another household's list, and for a contact only their
 *     own (scope.ts);
 *  7. the safety check (guard.ts), which sees the action in words, who asked
 *     from where, and what the screen is showing.
 *
 * Only looking (screenshot, zoom, cursor position, waiting) skips the last
 * three; every action that can change something passes all seven. What a
 * contact looks at is scoped too: their captures black out every other
 * conversation and every other household's list.
 *
 * A conversation holds the screen from its first action until its turn ends
 * (endHold), and then quits the apps it launched in that time.
 */

import type { ToolResult } from "../tools/types.ts";
import { clip, deletedText, describeElement, quoted, removesSelection } from "./describe.ts";
import { type Frame, frameFor, inFrame, toImage, toScreen, zoomRegion } from "./geometry.ts";
import { type Check, type Guard, refusalText } from "./guard.ts";
import {
  blockedChord,
  blockedMenuItem,
  chordMeaning,
  editsText,
  isSystemCombo,
  modifierFlags,
  movesCaret,
  parseChord,
} from "./keys.ts";
import type { ScreenLock } from "./lock.ts";
import type {
  Button,
  Capture,
  Chord,
  Display,
  InstalledApp,
  Native,
  PointOwner,
  QuitResult,
  Rect,
  RunningApp,
  SettleView,
} from "./native.ts";
import {
  type ActionKind,
  type Grant,
  type GrantFlags,
  type Policy,
  TIER_NOTE,
  approved,
  resolveApp,
  tierAllows,
  tierOf,
} from "./policy.ts";
import {
  IDS,
  MESSAGES,
  NOTES,
  type Scope,
  describeConversation,
  isConversationRow,
  isOwnNote,
  keyWindow,
  noteRefusal,
  openNoteTitle,
  redactions,
  rowAt,
  searchFieldInput,
  whoseTitle,
  windowAt,
} from "./scope.ts";

export type Action = {
  action: string;
  /** Why the model is doing this; the safety check reads it. */
  explanation?: string;
  coordinate?: number[];
  start_coordinate?: number[];
  region?: number[];
  text?: string;
  scroll_direction?: "up" | "down" | "left" | "right";
  scroll_amount?: number;
  duration?: number;
  repeat?: number;
};

type Content = ToolResult["content"][number];
type Step = { text: string; image?: Content; frame?: Frame };
type Point = { x: number; y: number };

/** A refusal the model can act on. Anything else that throws is a failure. */
export class Refusal extends Error {}

const FINDER = "com.apple.finder";
const DOCK = "com.apple.dock";
const MAX_WAIT_SECONDS = 100;
const TYPED_SHOWN = 300;
/** How long an action waits for another conversation to finish with the screen. */
export const SCREEN_WAIT_MS = 120_000;
const SCREEN_POLL_MS = 1_000;
/**
 * A batch's `wait` right after an action ends once the screen shows the
 * action's effect and has held still this long, instead of sleeping in full.
 * One 68-minute turn on 2026-09-23 spent 599s in 560 waits, 532 of them a
 * flat second. An effect that never shows still gets the whole wait.
 */
const SETTLE_QUIET_MS = 300;
/** Pixels, at the watch's half resolution, that count as an effect: more than a caret blink. */
const SETTLE_MIN_CHANGED = 50;
/** Longer waits are deliberate (an export, a launch) and are slept in full. */
const SETTLE_MAX_SECONDS = 10;
/** The menu bar's clock and status icons never stop changing, so a settle watches below it. */
const MENU_BAR_POINTS = 40;
/** Never quit at the end of a hold, whoever launched them: the bridge lives in Messages. */
const NEVER_QUIT = new Set([MESSAGES, FINDER]);
/** The apps whose windows a contact's capture blacks out in part. */
const SCOPED_APPS = new Set([MESSAGES, NOTES]);
/** Captures taken before a contact's gets every list blacked out whole. */
const CAPTURE_TRIES = 3;
const MOVED_NOTE =
  "The conversation and note lists kept changing while this was taken, so they are blacked out whole in this image; take another screenshot to see them.";

/**
 * What a capture shows: the apps it takes or leaves out, what it blacks out,
 * the apps it had to leave out because their windows could not be read, and
 * the frames of every sidebar list in the ones it could.
 */
type View = {
  exclude: string[];
  include?: string[];
  redact: Rect[];
  withheld: string[];
  lists: Rect[];
};

export type SessionDeps = {
  native: Native;
  policy: Policy;
  scope: Scope;
  guard: Guard;
  lock: ScreenLock | null;
  /**
   * This session's policy as the config has it right now: null once it gets
   * no tools, a throw when the config cannot be read. Asked before every
   * grant, listing and action, so an edit to [computer_use] reaches a session
   * that is already running. Defaults to `policy`.
   */
  livePolicy?: () => Policy | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export class ComputerSession {
  private readonly grants = new Map<string, Grant>();
  private flags: GrantFlags = {
    clipboardRead: false,
    clipboardWrite: false,
    systemKeyCombos: false,
  };
  /** The screenshot the model's coordinates refer to. */
  private frame: Frame | null = null;
  private display = "auto";
  private held: Button | null = null;
  /** The next input marks the screen first, because a `wait` follows it. */
  private markNext = false;
  /** What the last input marked, for the `wait` right after it. */
  private marked: SettleView | null = null;
  /** Select All went to Notes, and nothing has moved the caret since (gateWholeNote). */
  private noteSelectedAll = false;
  /**
   * Set while this conversation holds the screen: the pids already running
   * when it took the screen (never quit when it lets go) and when it last
   * acted.
   */
  private hold: { before: Set<number>; lastActed: number } | null = null;
  /** Apps this hold launched, by pid, to quit when it ends. */
  private readonly launched = new Map<number, RunningApp>();
  /**
   * Untitled windows already open, by pid, when this hold could first act in
   * their app: at the start of the hold for apps granted then, at the grant
   * for apps granted later. Apps the hold launched have none. See ownDocument.
   */
  private readonly untitledBefore = new Map<number, Set<string>>();
  private installed: InstalledApp[] | null = null;
  private readonly native: Native;
  private readonly policy: Policy;
  private readonly scope: Scope;
  private readonly guard: Guard;
  private readonly lock: ScreenLock | null;
  private readonly livePolicy: () => Policy | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(deps: SessionDeps) {
    this.native = deps.native;
    this.policy = deps.policy;
    this.scope = deps.scope;
    this.guard = deps.guard;
    this.lock = deps.lock;
    this.livePolicy = deps.livePolicy ?? (() => deps.policy);
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
  }

  // ─── Access ────────────────────────────────────────────────────────────

  /**
   * The policy as the config has it now, after taking back every grant and
   * grant flag it no longer allows. Null when this session gets nothing any
   * more: computer use switched off, a contact's check back in shadow, or the
   * session no longer on the tier it was scoped for. A config that cannot be
   * read refuses whatever was asked; it never falls back to an older reading.
   */
  private refresh(): Policy | null {
    let live: Policy | null;
    try {
      live = this.livePolicy();
    } catch (err) {
      throw new Refusal(
        `The computer-use settings could not be read right now (${message(err)}), so nothing was done. Try again in a minute.`,
      );
    }
    if (live && live.tier !== this.policy.tier) live = null;
    for (const [bundleId, grant] of this.grants) {
      const app = this.installed?.find((a) => a.bundleId === bundleId) ?? {
        bundleId,
        name: grant.displayName,
        displayName: grant.displayName,
        path: "",
      };
      if (!live || !approved(live.apps, app)) this.grants.delete(bundleId);
    }
    this.flags = {
      clipboardRead: this.flags.clipboardRead && !!live?.clipboard,
      clipboardWrite: this.flags.clipboardWrite && !!live?.clipboard,
      systemKeyCombos: this.flags.systemKeyCombos && !!live?.systemKeyCombos,
    };
    return live;
  }

  async requestAccess(req: {
    apps: string[];
    reason: string;
    clipboardRead?: boolean;
    clipboardWrite?: boolean;
    systemKeyCombos?: boolean;
  }): Promise<string> {
    this.installed ??= await this.native.installedApps();
    let live: Policy | null;
    try {
      live = this.refresh();
    } catch (err) {
      return JSON.stringify({ granted: [], denied: [], error: message(err) });
    }
    const approvedNow = live?.apps ?? [];
    const denied: Array<{ app: string; reason: string }> = [];
    for (const name of req.apps) {
      const app = resolveApp(this.installed, name);
      if (!app) {
        denied.push({ app: name, reason: "not installed" });
      } else if (!approved(approvedNow, app)) {
        denied.push({ app: name, reason: "not approved for this conversation" });
      } else if (!this.grants.has(app.bundleId)) {
        this.grants.set(app.bundleId, {
          bundleId: app.bundleId,
          displayName: app.displayName,
          grantedAt: this.now(),
          tier: tierOf(app.bundleId),
        });
      }
    }
    if (this.hold) {
      const running = await this.native.running();
      await this.noteUntitled(running.filter((a) => this.hold?.before.has(a.pid)));
    }
    const ask = (flag: boolean | undefined) => Boolean(flag);
    this.flags = {
      clipboardRead: this.flags.clipboardRead || (ask(req.clipboardRead) && !!live?.clipboard),
      clipboardWrite: this.flags.clipboardWrite || (ask(req.clipboardWrite) && !!live?.clipboard),
      systemKeyCombos:
        this.flags.systemKeyCombos || (ask(req.systemKeyCombos) && !!live?.systemKeyCombos),
    };
    const limited = [...this.grants.values()]
      .filter((g) => g.tier !== "full")
      .map((g) => `${g.displayName}: ${TIER_NOTE[g.tier]}.`);
    return JSON.stringify({
      granted: [...this.grants.values()],
      denied,
      grantFlags: this.flags,
      approvedApps: approvedNow,
      screenshotFiltering: "native",
      ...(limited.length ? { notes: limited } : {}),
    });
  }

  listGranted(): string {
    let approvedApps: string[] | string;
    try {
      approvedApps = this.refresh()?.apps ?? [];
    } catch (err) {
      approvedApps = message(err);
    }
    return JSON.stringify({
      allowedApps: [...this.grants.values()],
      grantFlags: this.flags,
      approvedApps,
      coordinateMode: "pixels",
    });
  }

  // ─── Running actions ───────────────────────────────────────────────────

  /** One tool call. A screenshot becomes the new coordinate reference. */
  async single(action: Action): Promise<ToolResult> {
    try {
      const step = await this.step(action, this.frame);
      if (step.frame) this.frame = step.frame;
      return { content: [{ type: "text", text: step.text }, ...(step.image ? [step.image] : [])] };
    } catch (err) {
      return { content: [{ type: "text", text: message(err) }], isError: true };
    }
  }

  /**
   * Several actions in order, stopping at the first failure. Every coordinate
   * refers to the screenshot taken before the batch; the last screenshot
   * taken inside it becomes the reference afterwards. The batch's
   * explanation stands for each of its actions.
   */
  async batch(actions: Action[], explanation: string): Promise<ToolResult> {
    const reference = this.frame;
    const content: Content[] = [];
    let latest: Frame | null = null;
    let failed = false;
    for (const [i, action] of actions.entries()) {
      const label = `[${i + 1}/${actions.length}] ${action.action}`;
      if (action.action !== "wait") {
        this.marked = null;
        this.markNext = actions[i + 1]?.action === "wait";
      }
      try {
        const step = await this.step({ ...action, explanation }, reference);
        content.push({ type: "text", text: `${label}: ${step.text}` });
        if (step.image) content.push(step.image);
        if (step.frame) latest = step.frame;
      } catch (err) {
        content.push({ type: "text", text: `${label}: ${message(err)}` });
        if (i + 1 < actions.length) {
          content.push({
            type: "text",
            text: `Stopped; ${actions.length - i - 1} action(s) not run.`,
          });
        }
        failed = true;
        break;
      }
    }
    this.markNext = false;
    this.marked = null;
    if (latest) this.frame = latest;
    return { content, ...(failed ? { isError: true } : {}) };
  }

  /**
   * This conversation is done with the screen (its turn ended, it went idle,
   * or its server is exiting): let go of any held button, quit the apps this
   * hold launched, and give up the screen. Apps that were already running
   * are left as they were. Null when it was not holding the screen.
   *
   * If another conversation has taken the screen meanwhile (this one sat
   * idle too long), nothing is quit out from under it.
   */
  async endHold(): Promise<QuitResult | null> {
    if (this.held) await this.native.buttonUp(this.held).catch(() => {});
    this.held = null;
    if (!this.hold) {
      this.lock?.release();
      return null;
    }
    let result: QuitResult = { quit: [], stillOpen: [] };
    if (this.lock?.heldByOther()) {
      result.stillOpen = [...this.launched.values()].map((a) => a.name);
    } else {
      this.noteLaunched(await this.native.running().catch(() => []));
      const apps = [...this.launched.values()];
      if (apps.length) {
        result = await this.native
          .quit(apps.map((a) => ({ pid: a.pid, bundleId: a.bundleId })))
          .catch(() => ({ quit: [], stillOpen: apps.map((a) => a.name) }));
      }
    }
    this.launched.clear();
    this.untitledBefore.clear();
    this.hold = null;
    this.noteSelectedAll = false;
    // Quitting changes the screen, so old coordinates must not be reused.
    this.frame = null;
    this.lock?.release();
    return result;
  }

  /** How long since this conversation last used the screen, or null if it holds nothing. */
  idleFor(): number | null {
    return this.hold ? this.now() - this.hold.lastActed : null;
  }

  async close(): Promise<void> {
    await this.endHold();
  }

  private async step(a: Action, ref: Frame | null): Promise<Step> {
    switch (a.action) {
      case "wait":
        return this.wait(a);
      case "cursor_position":
        return this.cursorPosition(ref);
      case "screenshot":
        return this.screenshot();
      case "zoom":
        return this.zoom(ref, a.region);
      case "left_click":
        return this.click(ref, a, "left", 1);
      case "double_click":
        return this.click(ref, a, "left", 2);
      case "triple_click":
        return this.click(ref, a, "left", 3);
      case "right_click":
        return this.click(ref, a, "right", 1);
      case "middle_click":
        return this.click(ref, a, "middle", 1);
      case "mouse_move":
        return this.mouseMove(ref, a);
      case "left_click_drag":
        return this.drag(ref, a);
      case "left_mouse_down":
        return this.mouseDown(a);
      case "left_mouse_up":
        return this.mouseUp(a);
      case "scroll":
        return this.scroll(ref, a);
      case "key":
        return this.key(a);
      case "hold_key":
        return this.holdKey(a);
      case "type":
        return this.type(a);
      default:
        throw new Refusal(`unknown action "${a.action}"`);
    }
  }

  /**
   * Sleep, or, right after an input that marked the screen, watch for that
   * input's effect and stop once the screen has held still. A settle that
   * fails sleeps out whatever is left.
   */
  private async wait(a: Action): Promise<Step> {
    const secs = Math.min(Math.max(a.duration ?? 1, 0), MAX_WAIT_SECONDS);
    const view = this.marked;
    this.marked = null;
    const started = this.now();
    if (view && secs > 0 && secs <= SETTLE_MAX_SECONDS) {
      const r = await this.native
        .settleWait({
          ...view,
          maxMs: secs * 1000,
          quietMs: SETTLE_QUIET_MS,
          minChanged: SETTLE_MIN_CHANGED,
        })
        .catch(() => null);
      if (r?.settled) {
        return {
          text: `Waited ${(r.ms / 1000).toFixed(1)}s, until the screen stopped changing (asked for up to ${secs}s).`,
        };
      }
      if (r) return { text: `Waited ${secs}s.` };
    }
    await this.sleep(Math.max(0, secs * 1000 - (this.now() - started)));
    return { text: `Waited ${secs}s.` };
  }

  /**
   * Called right before input reaches the screen: when a `wait` follows,
   * remember the screen for it. Best effort; a wait without a mark sleeps.
   */
  private async beforeInput(): Promise<void> {
    if (!this.markNext) return;
    this.markNext = false;
    try {
      const display = this.pickDisplay(await this.native.displays());
      const frame = frameFor(display);
      const rect = {
        x: 0,
        y: MENU_BAR_POINTS,
        width: display.width,
        height: display.height - MENU_BAR_POINTS,
      };
      const view: SettleView = {
        display: display.id,
        ...this.captureFilter(await this.native.running()),
        rect,
        width: Math.round(frame.width / 2),
        height: Math.round((frame.height * rect.height) / display.height / 2),
      };
      await this.native.settleMark(view);
      this.marked = view;
    } catch {
      this.marked = null;
    }
  }

  // ─── Screen ────────────────────────────────────────────────────────────

  private async screenshot(): Promise<Step> {
    const perms = await this.enter("screen");
    const displays = await this.native.displays();
    const display = this.pickDisplay(displays);
    const running = await this.native.running();
    const toHide = running.filter(
      (app) =>
        app.regular && !app.hidden && !this.isGranted(app.bundleId) && app.bundleId !== FINDER,
    );
    const hidden = toHide.length ? await this.native.hide(toHide.map((a) => a.bundleId)) : [];
    const frame = frameFor(display);
    const { shot, withheld, moved } = await this.scopedCapture(running, {
      display: display.id,
      width: frame.width,
      height: frame.height,
    });
    const notes = [`Screenshot of ${display.name} (${shot.width}x${shot.height}).`];
    if (withheld.length) notes.push(withheldNote(withheld));
    if (moved) notes.push(MOVED_NOTE);
    if (perms.locked) {
      notes.push("The Mac is locked: you can look, but input would reach the login window.");
    }
    if (hidden.length) {
      notes.push(
        `${hidden.map((n) => `"${n}"`).join(", ")} ${hidden.length === 1 ? "was" : "were"} open and got hidden first (not granted). If an earlier action opened one of them, that is why you do not see it; call request_access to add it.`,
      );
    }
    const others = displays.filter((d) => d.id !== display.id).map((d) => `"${d.name}"`);
    if (others.length)
      notes.push(`Other displays: ${others.join(", ")}. Use switch_display to capture one.`);
    return {
      text: notes.join(" "),
      image: { type: "image", data: shot.data, mimeType: "image/jpeg" },
      frame: { ...frame, width: shot.width, height: shot.height },
    };
  }

  private async zoom(ref: Frame | null, region: number[] | undefined): Promise<Step> {
    if (!ref) throw new Refusal("Take a screenshot first; zoom regions are in its coordinates.");
    if (!region || region.length !== 4) throw new Refusal("zoom needs region: [x0, y0, x1, y1]");
    await this.enter("screen");
    const { rect, width, height } = zoomRegion(ref, region as [number, number, number, number]);
    const { shot, withheld, moved } = await this.scopedCapture(await this.native.running(), {
      display: ref.display.id,
      width,
      height,
      rect,
    });
    return {
      text: `Zoomed (${shot.width}x${shot.height}). Coordinates still refer to the full screenshot.${withheld.length ? ` ${withheldNote(withheld)}` : ""}${moved ? ` ${MOVED_NOTE}` : ""}`,
      image: { type: "image", data: shot.data, mimeType: "image/jpeg" },
    };
  }

  private async cursorPosition(ref: Frame | null): Promise<Step> {
    const p = await this.native.cursor();
    if (!ref)
      return { text: JSON.stringify({ x: Math.round(p.x), y: Math.round(p.y), space: "points" }) };
    const img = toImage(ref, p.x, p.y);
    const off = inFrame(ref, img.x, img.y) ? {} : { note: "outside the last screenshot" };
    return { text: JSON.stringify({ ...img, ...off }) };
  }

  // ─── Pointer ───────────────────────────────────────────────────────────

  private async click(ref: Frame | null, a: Action, button: Button, count: number): Promise<Step> {
    const flags = modifierFlags(a.text);
    const kind: ActionKind = button !== "left" ? "pointer" : flags ? "modified-click" : "click";
    const at = this.point(ref, a.coordinate);
    await this.enter("input");
    const front = await this.gateFrontmost(kind);
    const target = await this.gatePoint(at, kind);
    const verb =
      count === 3
        ? "triple-click"
        : count === 2
          ? "double-click"
          : `${button}-click${a.text ? ` with ${a.text} held` : ""}`;
    await this.approve(a, front, target, `${verb} ${describeElement(target)}`, at);
    await this.beforeInput();
    await this.native.click(at.x, at.y, button, count, flags);
    if (target.bundleId === NOTES) {
      // Select All from the menu selects everything; a plain click anywhere
      // else in Notes (the text, the list of notes) puts the caret down.
      if (target.role === "AXMenuItem" && /^Select All$/i.test(target.label ?? "")) {
        this.noteSelectedAll = true;
      } else if (button === "left" && !flags && target.role && !target.role.startsWith("AXMenu")) {
        this.noteSelectedAll = false;
      }
    }
    const done =
      count === 3
        ? "Triple-clicked"
        : count === 2
          ? "Double-clicked"
          : `${capital(button)}-clicked`;
    return { text: `${done}.` };
  }

  /** Hovering changes nothing, so it is checked only while a button is held. */
  private async mouseMove(ref: Frame | null, a: Action): Promise<Step> {
    const at = this.point(ref, a.coordinate);
    await this.enter("input");
    const front = await this.gateFrontmost("pointer-move");
    if (this.held) {
      const target = await this.gatePoint(at, "pointer");
      await this.approve(
        a,
        front,
        target,
        `drag, with the left button held, to ${describeElement(target)}`,
        at,
      );
    }
    await this.beforeInput();
    await this.native.move(at.x, at.y, this.held);
    return { text: "Moved." };
  }

  private async drag(ref: Frame | null, a: Action): Promise<Step> {
    const to = this.point(ref, a.coordinate);
    const from = a.start_coordinate
      ? this.point(ref, a.start_coordinate)
      : await this.native.cursor();
    await this.enter("input");
    const front = await this.gateFrontmost("pointer");
    const source = await this.gatePoint(from, "pointer");
    const target = await this.gatePoint(to, "pointer");
    await this.approve(
      a,
      front,
      source,
      `drag from ${describeElement(source)} to ${describeElement(target)}`,
      from,
    );
    await this.approve(a, front, target, `drop onto ${describeElement(target)}`, to);
    await this.beforeInput();
    await this.native.drag(from, to);
    return { text: "Dragged." };
  }

  private async mouseDown(a: Action): Promise<Step> {
    if (this.held) throw new Refusal("The left button is already held; call left_mouse_up first.");
    await this.enter("input");
    const front = await this.gateFrontmost("pointer");
    const at = await this.native.cursor();
    const target = await this.gatePoint(at, "pointer");
    await this.approve(
      a,
      front,
      target,
      `press and hold the left button on ${describeElement(target)}`,
      at,
    );
    await this.beforeInput();
    await this.native.buttonDown("left");
    this.held = "left";
    return { text: "Left button down." };
  }

  /** Releasing is what completes a click or a drop, so it is judged like one. */
  private async mouseUp(a: Action): Promise<Step> {
    await this.enter("input");
    const front = await this.gateFrontmost("pointer");
    const at = await this.native.cursor();
    const target = await this.gatePoint(at, "pointer");
    await this.approve(
      a,
      front,
      target,
      `release the left button over ${describeElement(target)}`,
      at,
    );
    await this.beforeInput();
    await this.native.buttonUp("left");
    this.held = null;
    return { text: "Left button up." };
  }

  private async scroll(ref: Frame | null, a: Action): Promise<Step> {
    const at = this.point(ref, a.coordinate);
    const amount = a.scroll_amount ?? 0;
    const dir = a.scroll_direction;
    if (!dir) throw new Refusal("scroll needs scroll_direction");
    const flags = modifierFlags(a.text);
    await this.enter("input");
    const front = await this.gateFrontmost("scroll");
    const target = await this.gatePoint(at, "scroll");
    await this.approve(
      a,
      front,
      target,
      `scroll ${dir} ${amount} ticks over ${describeElement(target)}`,
      at,
    );
    const dy = dir === "up" ? amount : dir === "down" ? -amount : 0;
    const dx = dir === "left" ? amount : dir === "right" ? -amount : 0;
    await this.beforeInput();
    await this.native.scroll(at.x, at.y, dx, dy, flags);
    return { text: `Scrolled ${dir} ${amount}.` };
  }

  // ─── Keyboard ──────────────────────────────────────────────────────────

  private async key(a: Action): Promise<Step> {
    const repeat = Math.min(Math.max(a.repeat ?? 1, 1), 100);
    const { chord, focus, front, words, meaning } = await this.prepareChord(a);
    // The operator's rule (2026-09-24): removing things from a document Edmund made
    // this session is his to do. The harness checked whose document it is, so
    // only the destructive answer is set aside, and only for these keys.
    const doc = removesSelection(chord, meaning) ? this.ownDocument(focus) : null;
    const waive: Check["waive"] = doc
      ? {
          harms: ["destructive"],
          because: `"${doc}" is a document Edmund created during this session and has never saved`,
        }
      : undefined;
    // Say what a Delete removes: "forward-delete 27 times" is something the
    // safety check can only guess at, the line it deletes is not.
    const deletes = deletedText(chord, focus, repeat);
    await this.approve(
      a,
      front,
      focus,
      `press ${words}${repeat > 1 ? ` ${repeat} times` : ""}${
        deletes === null
          ? ""
          : deletes
            ? `, which deletes this text: ${quoted(deletes)}`
            : ", which deletes nothing (no text beside the caret)"
      }`,
      null,
      waive,
    );
    await this.beforeInput();
    await this.native.chord(chord, { repeat });
    this.afterNoteKey(front, focus, chord, meaning);
    return { text: "Key pressed." };
  }

  private async holdKey(a: Action): Promise<Step> {
    const secs = Math.min(Math.max(a.duration ?? 0, 0), MAX_WAIT_SECONDS);
    const { chord, focus, front, words, meaning } = await this.prepareChord(a);
    await this.approve(a, front, focus, `hold ${words} for ${secs}s`);
    await this.beforeInput();
    await this.native.chord(chord, { holdMs: secs * 1000 });
    this.afterNoteKey(front, focus, chord, meaning);
    return { text: `Held for ${secs}s.` };
  }

  /**
   * The gates a chord shares with hold_key, and the chord in words. A chord
   * that is never allowed says so before one that merely needs a grant.
   */
  private async prepareChord(a: Action) {
    const chord = this.parse(a.text);
    await this.enter("input");
    const front = await this.gateFrontmost("type");
    const blocked = blockedChord(chord, front.bundleId);
    if (blocked) {
      throw new Refusal(`"${a.text}" ${blocked}. Edmund never does that; nothing was pressed.`);
    }
    if (isSystemCombo(chord) && !this.flags.systemKeyCombos) {
      throw new Refusal(
        `"${a.text}" acts on the whole system and needs the systemKeyCombos grant (request_access with systemKeyCombos: true).`,
      );
    }
    const focus = await this.native.focused();
    const meaning = chordMeaning(chord, front.name);
    // Any key that would put text in a password field, not just Paste: a
    // letter at a time is typing it. Tab and Return (move on, submit) are not.
    if (focus?.secure && editsText(chord, false)) throw new Refusal(PASSWORD_FIELD);
    this.gateWholeNote(front.bundleId, focus, editsText(chord, true));
    const words = `key chord ${a.text}${meaning ? ` (macOS shortcut: ${meaning})` : ""}${focus ? ` with focus on ${describeElement(focus)}` : ""}`;
    return { chord, focus, front, words, meaning };
  }

  /**
   * After a key reaches Notes: Select All means the next edit would replace
   * the whole note, until a key moves the caret.
   */
  private afterNoteKey(
    front: RunningApp,
    focus: PointOwner | null,
    chord: Chord,
    meaning: string | null,
  ): void {
    if (front.bundleId !== NOTES) return;
    // A one-line field (the search field, a folder name) holds no note.
    if (meaning === "Select All" && focus?.role !== "AXTextField") this.noteSelectedAll = true;
    else if (movesCaret(chord)) this.noteSelectedAll = false;
  }

  /**
   * Refuses an edit that would replace or delete everything in a note: the
   * paste that stacked a shared shopping list, since every other device puts
   * its own copy of each deleted line back. Everything counts as selected when
   * the focused text reports a selection from its very start to its very end,
   * or, when it reports none, from Select All until a plain click in Notes or
   * a key that moves the caret. Ordinary edits (a line selected, a caret in
   * the middle) are untouched.
   */
  private gateWholeNote(app: string, focus: PointOwner | null, edits: boolean): void {
    if (app !== NOTES || !edits) return;
    const reported = focus?.selection && focus.role !== "AXTextField" ? focus : null;
    if (reported) {
      const whole =
        reported.selection!.location === 0 &&
        reported.selection!.length > 0 &&
        !reported.textBefore &&
        !reported.textAfter;
      if (!whole) {
        this.noteSelectedAll = false;
        return;
      }
    } else if (!this.noteSelectedAll) {
      return;
    }
    throw new Refusal(WHOLE_NOTE);
  }

  /**
   * Multi-line text goes through the clipboard when that is granted: editors
   * auto-indent and auto-complete typed newlines, but not pasted ones. The
   * previous clipboard text is put back afterwards.
   */
  private async type(a: Action): Promise<Step> {
    const text = a.text ?? "";
    await this.enter("input");
    const front = await this.gateFrontmost("type");
    const focus = await this.native.focused();
    if (focus?.secure) throw new Refusal(PASSWORD_FIELD);
    this.gateWholeNote(front.bundleId, focus, text.length > 0);
    const into = focus ? describeElement(focus) : `whatever has focus in ${front.name}`;
    const replacing = focus?.selectedText
      ? `, replacing the selected text ${quoted(focus.selectedText)}`
      : "";
    await this.approve(
      a,
      front,
      focus,
      `type text "${clip(text, TYPED_SHOWN)}" into ${into}${replacing}`,
    );
    await this.beforeInput();
    if (text.includes("\n") && this.flags.clipboardWrite) {
      const previous = await this.native.clipboardRead();
      await this.native.clipboardWrite(text);
      await this.native.chord(parseChord("cmd+v"));
      await this.sleep(250);
      if (previous !== null) await this.native.clipboardWrite(previous);
      return { text: "Typed (via clipboard)." };
    }
    await this.native.type(text);
    return { text: `Typed ${text.length} character${text.length === 1 ? "" : "s"}.` };
  }

  private parse(text: string | undefined) {
    if (!text) throw new Refusal('key needs text, e.g. "cmd+s" or "Return"');
    try {
      return parseChord(text);
    } catch (err) {
      throw new Refusal(message(err));
    }
  }

  // ─── Apps, displays, clipboard ─────────────────────────────────────────

  async openApplication(name: string, explanation: string): Promise<ToolResult> {
    return this.respond(async () => {
      this.installed ??= await this.native.installedApps();
      this.gateAccess();
      const app = resolveApp(this.installed, name);
      if (!app) throw new Refusal(`No installed application matches "${name}".`);
      if (!this.isGranted(app.bundleId)) {
        throw new Refusal(`${app.displayName} is not granted. Call request_access for it first.`);
      }
      await this.enter("input");
      const front = await this.native.frontmost();
      await this.check(
        "open_application",
        explanation,
        front,
        null,
        `open the application "${app.displayName}"`,
      );
      const opened = await this.native.open(app.bundleId);
      if (this.hold && !this.hold.before.has(opened.pid) && !NEVER_QUIT.has(opened.bundleId)) {
        this.launched.set(opened.pid, opened);
      }
      return `Opened "${app.displayName}".`;
    });
  }

  async switchDisplay(name: string): Promise<ToolResult> {
    return this.respond(async () => {
      if (name.trim().toLowerCase() === "auto") {
        this.display = "auto";
        return "Screenshots will capture the main display.";
      }
      const displays = await this.native.displays();
      const match = displays.find((d) => d.name.toLowerCase() === name.trim().toLowerCase());
      if (!match) {
        throw new Refusal(
          `No display named "${name}". Displays: ${displays.map((d) => `"${d.name}"`).join(", ")}.`,
        );
      }
      this.display = match.name;
      return `Screenshots will capture "${match.name}". Take a screenshot before clicking.`;
    });
  }

  async readClipboard(explanation: string): Promise<ToolResult> {
    return this.respond(async () => {
      this.gateAccess();
      if (!this.flags.clipboardRead)
        throw new Refusal("Reading the clipboard needs the clipboardRead grant.");
      await this.enter("clipboard");
      const front = await this.native.frontmost();
      await this.check(
        "read_clipboard",
        explanation,
        front,
        null,
        "read the text on the clipboard",
      );
      return (await this.native.clipboardRead()) ?? "(the clipboard holds no text)";
    });
  }

  async writeClipboard(text: string, explanation: string): Promise<ToolResult> {
    return this.respond(async () => {
      this.gateAccess();
      if (!this.flags.clipboardWrite)
        throw new Refusal("Writing the clipboard needs the clipboardWrite grant.");
      await this.enter("clipboard");
      await this.check(
        "write_clipboard",
        explanation,
        await this.native.frontmost(),
        null,
        `put this text on the clipboard: "${clip(text, TYPED_SHOWN)}"`,
      );
      await this.native.clipboardWrite(text);
      return "Clipboard written.";
    });
  }

  // ─── Gates ─────────────────────────────────────────────────────────────

  /**
   * Common entry for anything that touches the screen, input or clipboard:
   * something must be granted, this conversation must hold the screen, and
   * macOS must allow the capture or input at all. Input also needs the Mac
   * unlocked, or it would reach the login window.
   */
  private async enter(kind: "screen" | "input" | "clipboard") {
    this.gateAccess();
    await this.takeScreen();
    const perms = await this.native.permissions();
    if (kind === "clipboard") return perms;
    const need = kind === "screen" ? "screenRecording" : "accessibility";
    if (!perms[need]) {
      const pane = need === "screenRecording" ? "Screen & System Audio Recording" : "Accessibility";
      throw new Error(
        `macOS has not granted ${pane} to the process that started this session, so ${kind === "screen" ? "the screen cannot be captured" : "input cannot be sent"}. The operator can grant it in System Settings > Privacy & Security > ${pane}.`,
      );
    }
    if (kind === "input" && perms.locked) {
      throw new Refusal(
        "The Mac is locked, so input would go to the login window. Nothing was done; someone has to unlock the Mac first.",
      );
    }
    return perms;
  }

  /** Gate 1: the policy as it stands now, and something granted under it. */
  private gateAccess(): void {
    if (!this.refresh()) {
      throw new Refusal(
        "Screen control is switched off for this conversation now, and every grant was taken back. Nothing was done.",
      );
    }
    if (this.grants.size === 0)
      throw new Refusal("No apps are granted yet. Call request_access first.");
  }

  /**
   * Hold the screen, waiting while another conversation finishes with it.
   * The first time, record what is already running; after that, notice any
   * granted app that has appeared since (a link that opened Safari, say), so
   * it is quit when this hold ends.
   */
  private async takeScreen(): Promise<void> {
    if (this.lock) {
      const deadline = this.now() + SCREEN_WAIT_MS;
      let busy = this.lock.acquire();
      while (busy && this.now() < deadline) {
        await this.sleep(SCREEN_POLL_MS);
        busy = this.lock.acquire();
      }
      if (busy) {
        throw new Refusal(
          `${busy} It was still in use after a ${SCREEN_WAIT_MS / 60_000}-minute wait, so nothing was done. Tell the person the screen is busy and to ask again in a few minutes.`,
        );
      }
    }
    const running = await this.native.running();
    if (this.hold) this.noteLaunched(running);
    else {
      this.hold = { before: new Set(running.map((a) => a.pid)), lastActed: this.now() };
      await this.noteUntitled(running);
    }
    this.hold.lastActed = this.now();
  }

  /** Record the untitled windows of these apps, once each, for the granted ones. */
  private async noteUntitled(running: RunningApp[]): Promise<void> {
    for (const app of running) {
      if (!app.regular || !this.isGranted(app.bundleId) || this.untitledBefore.has(app.pid))
        continue;
      try {
        const { windows } = await this.native.inspect(app.bundleId, []);
        this.untitledBefore.set(app.pid, new Set(windows.map((w) => w.title).filter(isUntitled)));
      } catch {
        // Unknown, so no window of this app counts as Edmund's.
      }
    }
  }

  /**
   * The title of the never-saved document `target` is in, when Edmund made it
   * during this hold: an untitled window of an app the hold launched, or one
   * its app did not have when the hold could first act there. Null otherwise.
   * An app the hold launched that restores someone's unsaved document would
   * pass; quitting apps at the end of a hold makes that rare.
   */
  private ownDocument(target: PointOwner | null): string | null {
    if (!this.hold || !target) return null;
    const title = target.window ?? (target.role === "AXWindow" ? target.label : undefined);
    if (!title || !isUntitled(title)) return null;
    if (!this.hold.before.has(target.pid)) return title;
    const before = this.untitledBefore.get(target.pid);
    return before && !before.has(title) ? title : null;
  }

  private noteLaunched(running: RunningApp[]): void {
    if (!this.hold) return;
    for (const app of running) {
      if (
        app.regular &&
        this.isGranted(app.bundleId) &&
        !this.hold.before.has(app.pid) &&
        !NEVER_QUIT.has(app.bundleId)
      ) {
        this.launched.set(app.pid, app);
      }
    }
  }

  private async gateFrontmost(kind: ActionKind | "pointer-move"): Promise<RunningApp> {
    const front = await this.native.frontmost();
    if (!front || !this.isGranted(front.bundleId)) {
      const name = front?.name ?? "No app";
      throw new Refusal(
        `"${name}" is frontmost and is not granted, so nothing was done. Use open_application to bring a granted app forward, or request_access to add this one.`,
      );
    }
    if (kind !== "pointer-move") this.gateTier(front.bundleId, front.name, kind);
    return front;
  }

  /** The element under a point, provided its app is granted and its tier allows the action. */
  private async gatePoint(at: Point, kind: ActionKind): Promise<PointOwner> {
    const owner = await this.native.ownerAt(at.x, at.y);
    const bundleId = owner.role === "desktop" || owner.bundleId === DOCK ? FINDER : owner.bundleId;
    const name =
      bundleId === FINDER && owner.bundleId !== FINDER
        ? `Finder (${owner.role === "desktop" ? "the desktop" : "the Dock"})`
        : owner.name;
    if (!bundleId || !this.isGranted(bundleId)) {
      throw new Refusal(
        `That point is covered by ${name || "something without an app identity"}, which is not granted, so nothing was done. Take a screenshot to see what is there, or request_access for it.`,
      );
    }
    this.gateTier(bundleId, name, kind);
    // Scrolling over a menu item does not choose it; everything else here
    // can, on the press, the release or the drop.
    if (kind !== "scroll") await this.gateMenuItem(owner);
    return owner;
  }

  /**
   * The fixed refusals for what is under the pointer: the menu items a
   * refused shortcut stands for (Quit Messages, the Apple menu's Log Out, the
   * Dock's Quit), and in Notes an edit menu item while the whole note is
   * selected. An element the accessibility tree cannot read is refused in
   * Messages and the Dock, where it could be one of those Quits; elsewhere it
   * goes to the check, since a busy app's window falls back to the same.
   */
  private async gateMenuItem(owner: PointOwner): Promise<void> {
    const blocked = blockedMenuItem(owner);
    if (blocked) {
      throw new Refusal(`That menu item ${blocked}. Edmund never does that; nothing was clicked.`);
    }
    if (!owner.role && (owner.bundleId === MESSAGES || owner.bundleId === DOCK)) {
      throw new Refusal(
        `What is under that point in ${owner.bundleId === DOCK ? "the Dock" : "Messages"} could not be read, and a click there could quit Messages. Nothing was clicked; take a screenshot and try again.`,
      );
    }
    if (owner.role === "AXMenuItem" && NOTE_EDIT_ITEM.test(owner.label ?? "")) {
      this.gateWholeNote(owner.bundleId, await this.native.focused(), true);
    }
  }

  private gateTier(bundleId: string, name: string, kind: ActionKind): void {
    const tier = this.grants.get(bundleId)?.tier ?? tierOf(bundleId);
    if (!tierAllows(tier, kind)) {
      throw new Refusal(`${name} is ${TIER_NOTE[tier]}. This action was not sent.`);
    }
  }

  /**
   * Scope, then the safety check, for an action aimed at `target` (the
   * element under `at` for the pointer, the focused one for the keyboard).
   */
  private async approve(
    a: Action,
    front: RunningApp,
    target: PointOwner | null,
    words: string,
    at: Point | null = null,
    waive?: Check["waive"],
  ) {
    const facts = await this.gateScope(a, front, target, at);
    await this.check(a.action, a.explanation ?? "", front, target, words, facts, waive);
  }

  private async check(
    tool: string,
    explanation: string,
    front: RunningApp | null,
    target: PointOwner | null,
    action: string,
    facts: Record<string, string> = {},
    waive?: Check["waive"],
  ): Promise<void> {
    const verdict = await this.guard.check({
      tool,
      action,
      app: front?.name ?? "",
      window: target?.window ?? "",
      explanation,
      facts,
      ...(waive ? { waive } : {}),
    });
    if (!verdict.allowed) throw new Refusal(refusalText(verdict));
  }

  /**
   * An action in Messages must stay in the conversation this request came
   * from; getting there by clicking that conversation's row, or searching for
   * it, is allowed. An action in Notes must not touch another household's
   * list, and a contact's must touch only their own. Returns what the screen
   * shows, for the safety check.
   */
  private async gateScope(
    a: Action,
    front: RunningApp,
    target: PointOwner | null,
    at: Point | null,
  ): Promise<Record<string, string>> {
    const app = target?.bundleId || front.bundleId;
    if (app === MESSAGES) return this.gateConversation(a, target, at);
    if (app === NOTES) return this.gateNote(target, at);
    return {};
  }

  /**
   * A click is judged by the window under it; a key by the window holding
   * the focused element, which may be a conversation opened in a window of
   * its own. When Messages cannot say which window that is, nothing is sent.
   */
  private async gateConversation(
    a: Action,
    target: PointOwner | null,
    at: Point | null,
  ): Promise<Record<string, string>> {
    const mine = this.scope.conversation;
    if (!mine) {
      throw new Refusal(
        "This request did not come from a conversation, so there is no conversation in Messages to act on. Nothing was done.",
      );
    }
    const inspection = await this.native.inspect(MESSAGES, [IDS.conversationList]);
    const window = at ? windowAt(inspection, at) : keyWindow(inspection, target, (w) => w.title);
    const showing = window?.title ?? "";
    const own = `${showing}: the requester's own conversation, checked against chat.db`;
    const row = rowAt(window, IDS.conversationList, at);
    if (row) {
      if (isConversationRow(this.scope, row.text)) {
        return {
          messages_showing: showing || "(no conversation open)",
          row_clicked: "the requester's own conversation, in the sidebar",
        };
      }
      throw new Refusal(
        `That row is a different conversation, or could be. Only ${describeConversation(mine)} can be opened from here; nothing was done.`,
      );
    }
    if (target?.subrole === "AXSearchField") {
      const input = searchFieldInput(a.action, a.text);
      if (input === "edit") {
        return {
          messages_showing: window
            ? showing || "(no conversation open)"
            : "(not known: Messages did not say which window has focus)",
          focus: "the search field",
        };
      }
      if (input === "pick") {
        const what = a.action === "type" ? "A line break" : `"${a.text}"`;
        throw new Refusal(
          `${what} in the Messages search field opens whichever result is selected, and which conversation that is cannot be checked first. Nothing was done. Click the requester's own conversation among the results instead.`,
        );
      }
    }
    if (!window) {
      throw new Refusal(
        `Messages did not say which window has the keyboard focus, so where this would land cannot be checked. Nothing was done. Click in ${describeConversation(mine)} first, then try again.`,
      );
    }
    const whose = whoseTitle(this.scope, showing);
    if (whose === "shared") {
      throw new Refusal(
        this.scope.otherTitles
          ? `Messages is showing "${showing}", a title another conversation has too, so it cannot be told apart from ${describeConversation(mine)}. Nothing was done.`
          : `Messages is showing "${showing}", but the list of conversations could not be read to tell it apart from any other. Nothing was done.`,
      );
    }
    if (whose !== "own") {
      throw new Refusal(
        `Messages is showing "${showing || "no conversation"}", which is not ${describeConversation(mine)}. Nothing was done. Open this conversation first by clicking its row in the sidebar.`,
      );
    }
    return { messages_showing: own };
  }

  private async gateNote(
    target: PointOwner | null,
    at: Point | null,
  ): Promise<Record<string, string>> {
    const inspection = await this.native.inspect(NOTES, [IDS.noteBody, IDS.noteList]);
    const window = at ? windowAt(inspection, at) : keyWindow(inspection, target, openNoteTitle);
    if (!window?.frame || !window.found[IDS.noteBody]) {
      throw new Refusal(
        "Notes did not say which note is open (its windows cannot be read right now), so nothing was done. Take a screenshot and try again.",
      );
    }
    const open = openNoteTitle(window);
    const row = rowAt(window, IDS.noteList, at);
    if (row) {
      if (this.policy.tier === "contact" && !isOwnNote(this.scope, row.text)) {
        throw new Refusal(
          `"${row.text}" is not this household's list, so it cannot be opened from this conversation. Nothing was done.`,
        );
      }
      return { note_open: this.whoseNote(open), note_clicked: this.whoseNote(row.text) };
    }
    const refusal = noteRefusal(this.scope, this.policy.tier, open);
    if (refusal) throw new Refusal(`${refusal} Nothing was done.`);
    return { note_open: this.whoseNote(open) };
  }

  /** A note title with whose it is, as the scope gate established. */
  private whoseNote(title: string): string {
    if (!title) return "(no note open)";
    if (isOwnNote(this.scope, title)) return `${title}: the requester's household list`;
    if (this.scope.otherNotes.some((n) => n.trim().toLowerCase() === title.trim().toLowerCase())) {
      return `${title}: another household's list`;
    }
    return `${title}: the owner's own note, not a household list`;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private isGranted(bundleId: string): boolean {
    return this.grants.has(bundleId);
  }

  /**
   * What a capture may show. The operator sees everything but ungranted
   * apps, so a system dialog in the way is visible. Anyone else sees only
   * granted apps' windows (a notification banner can carry someone's
   * message), with every conversation and list that is not theirs blacked
   * out of Messages and Notes. An app whose windows cannot be read is left
   * out of their capture altogether, since nothing in it can be redacted.
   */
  private async view(running: RunningApp[]): Promise<View> {
    if (this.policy.tier !== "contact") {
      return { ...this.captureFilter(running), redact: [], withheld: [], lists: [] };
    }
    const redact: Rect[] = [];
    const lists: Rect[] = [];
    const left: RunningApp[] = [];
    for (const app of [MESSAGES, NOTES]) {
      const shown = running.find((r) => r.bundleId === app && !r.hidden);
      if (!this.isGranted(app) || !shown) continue;
      const list = app === MESSAGES ? IDS.conversationList : IDS.noteList;
      const ids = app === MESSAGES ? [list] : [list, IDS.noteBody, IDS.noteBodyScroll];
      const inspection = await this.native.inspect(app, ids);
      const rects = redactions(this.scope, app, inspection);
      if (!rects) {
        left.push(shown);
        continue;
      }
      redact.push(...rects);
      for (const w of inspection.windows) {
        const frame = w.found[list]?.frame;
        if (w.frame && frame) lists.push(frame);
      }
    }
    const include = [...this.grants.keys()].filter((id) => !left.some((a) => a.bundleId === id));
    return { exclude: [], include, redact, withheld: left.map((a) => a.name), lists };
  }

  /**
   * One capture of what this session may see. A contact's black-outs go
   * where the accessibility tree put everyone else's conversations and lists
   * just before the capture, and a message arriving in between moves another
   * conversation into the sidebar slot left clear for theirs. So the tree is
   * read again after the capture, and the image is kept only if the
   * black-outs are still where they belong. Otherwise it is taken again, up
   * to CAPTURE_TRIES times, then once more with every list blacked out whole
   * (`moved`). If even that did not hold, Messages and Notes are left out.
   */
  private async scopedCapture(
    running: RunningApp[],
    shape: { display: number; width: number; height: number; rect?: Rect },
  ): Promise<{ shot: Capture; withheld: string[]; moved: boolean }> {
    const take = ({ withheld: _w, lists: _l, ...v }: View) =>
      this.native.capture({ ...shape, ...v });
    let view = await this.view(running);
    if (this.policy.tier !== "contact") {
      return { shot: await take(view), withheld: view.withheld, moved: false };
    }
    const seen = [view];
    for (let i = 0; i < CAPTURE_TRIES; i++) {
      const shot = await take(view);
      const after = await this.view(running);
      if (sameView(view, after)) return { shot, withheld: view.withheld, moved: false };
      seen.push(after);
      view = after;
    }
    const strict = strictest(seen);
    const shot = await take(strict);
    if (covers(strict, await this.view(running))) {
      return { shot, withheld: strict.withheld, moved: true };
    }
    const out = running.filter(
      (r) => SCOPED_APPS.has(r.bundleId) && !r.hidden && !!strict.include?.includes(r.bundleId),
    );
    const withheld = [...strict.withheld, ...out.map((r) => r.name)];
    const include = (strict.include ?? []).filter((id) => !SCOPED_APPS.has(id));
    const bare = await take({ exclude: [], include, redact: [], withheld, lists: [] });
    return { shot: bare, withheld, moved: false };
  }

  /**
   * Whose windows a capture takes: the operator's leaves out ungranted apps,
   * anyone else's takes only granted ones.
   */
  private captureFilter(running: RunningApp[]): { exclude: string[]; include?: string[] } {
    if (this.policy.tier === "contact") return { exclude: [], include: [...this.grants.keys()] };
    const exclude = running
      .filter((a) => a.regular && a.bundleId && !this.isGranted(a.bundleId))
      .map((a) => a.bundleId);
    return { exclude };
  }

  private pickDisplay(displays: Display[]): Display {
    if (displays.length === 0)
      throw new Error("No display is attached, so there is nothing to capture.");
    if (this.display !== "auto") {
      const chosen = displays.find((d) => d.name === this.display);
      if (chosen) return chosen;
      this.display = "auto";
    }
    return displays.find((d) => d.main) ?? displays[0]!;
  }

  /** An image coordinate from the reference screenshot, in screen points. */
  private point(ref: Frame | null, c: number[] | undefined): Point {
    if (!c || c.length !== 2) throw new Refusal("coordinate must be [x, y]");
    const [x, y] = c as [number, number];
    if (!ref) {
      throw new Refusal(
        "Take a screenshot first; coordinates are pixels in the latest screenshot.",
      );
    }
    if (!inFrame(ref, x, y)) {
      throw new Refusal(
        `(${x}, ${y}) is outside the last screenshot (${ref.width}x${ref.height}).`,
      );
    }
    return toScreen(ref, x, y);
  }

  private async respond(fn: () => Promise<string>): Promise<ToolResult> {
    try {
      return { content: [{ type: "text", text: await fn() }] };
    } catch (err) {
      return { content: [{ type: "text", text: message(err) }], isError: true };
    }
  }
}

const rectKey = (r: Rect) => `${r.x},${r.y},${r.width},${r.height}`;

/** Whether two readings black out the same places and leave out the same apps. */
function sameView(a: View, b: View): boolean {
  const key = (v: View) =>
    JSON.stringify([
      v.redact.map(rectKey).sort(),
      [...v.withheld].sort(),
      [...(v.include ?? [])].sort(),
    ]);
  return key(a) === key(b);
}

/**
 * Everything any reading blacked out or left out, and every list whole: an
 * image taken with this hides what each reading said to hide.
 */
function strictest(seen: View[]): View {
  const unique = (rects: Rect[]) => [...new Map(rects.map((r) => [rectKey(r), r])).values()];
  return {
    exclude: [],
    include: seen
      .map((v) => v.include ?? [])
      .reduce((kept, next) => kept.filter((id) => next.includes(id))),
    redact: unique(seen.flatMap((v) => [...v.redact, ...v.lists])),
    withheld: [...new Set(seen.flatMap((v) => v.withheld))],
    lists: unique(seen.flatMap((v) => v.lists)),
  };
}

/** Whether an image taken with `taken` hides everything a later reading says to. */
function covers(taken: View, now: View): boolean {
  const hidden = new Set(taken.redact.map(rectKey));
  return (
    [...now.redact, ...now.lists].every((r) => hidden.has(rectKey(r))) &&
    now.withheld.every((name) => taken.withheld.includes(name))
  );
}

/**
 * A never-saved document's window title: "Untitled", "Untitled 2",
 * "Silhouette Studio: Untitled-1", "Untitled — Edited". A saved file that
 * merely starts with the word ("Untitled Design") is not one.
 */
const UNTITLED = /(?:^|:\s)Untitled(?:[- ]\d+)?(?:\s+—\s+Edited)?$/i;

export function isUntitled(title: string): boolean {
  return UNTITLED.test(title.trim());
}

function withheldNote(apps: string[]): string {
  return `${apps.join(" and ")} could not be checked for other people's conversations and lists right now, so ${apps.length === 1 ? "it was" : "they were"} left out of this image.`;
}

const PASSWORD_FIELD =
  "The focused field is a password field. Edmund never types or pastes into one; nothing was sent. Ask the person to enter it themselves.";

/** Notes' edit menu items that replace or remove the selection. */
const NOTE_EDIT_ITEM = /^(Paste|Cut|Delete)\b/i;

const WHOLE_NOTE =
  "Everything in the note is selected, so this would replace or delete the whole note. Edmund never rewrites a whole note: every other device puts its own copy of each removed line back, and the list ends up with every line several times. Nothing was done. Click in the note or press an arrow key to drop the selection, then change only the lines that need changing.";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
