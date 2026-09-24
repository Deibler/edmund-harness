/**
 * One conversation's hold on the screen: its grants, the screenshot its
 * coordinates refer to, and every action behind the gates.
 *
 * The gates, in the order an action meets them:
 *  1. something is granted at all;
 *  2. this conversation holds the screen lock (waiting while another
 *     conversation finishes), and the Mac is not locked;
 *  3. the frontmost app is granted, and its tier allows the action;
 *  4. for anything aimed at a point, the app that owns that point is granted
 *     too, since a click reaches whatever is under it, not the frontmost app.
 *     The desktop and the Dock count as Finder;
 *  5. fixed refusals that need no judgment: session-ending shortcuts,
 *     quitting Messages, typing into a password field;
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
import { clip, deletedText, describeElement, quoted } from "./describe.ts";
import { type Frame, frameFor, inFrame, toImage, toScreen, zoomRegion } from "./geometry.ts";
import { type Guard, refusalText } from "./guard.ts";
import { blockedChord, chordMeaning, isSystemCombo, modifierFlags, parseChord } from "./keys.ts";
import type { ScreenLock } from "./lock.ts";
import type {
  Button,
  Display,
  InstalledApp,
  Native,
  PointOwner,
  QuitResult,
  Rect,
  RunningApp,
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
  isConversation,
  isConversationRow,
  isOwnNote,
  keyWindow,
  noteRefusal,
  openNoteTitle,
  redactions,
  rowAt,
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
/** Never quit at the end of a hold, whoever launched them: the bridge lives in Messages. */
const NEVER_QUIT = new Set([MESSAGES, FINDER]);

export type SessionDeps = {
  native: Native;
  policy: Policy;
  scope: Scope;
  guard: Guard;
  lock: ScreenLock | null;
  /**
   * The apps this conversation may be granted, as the config has them right
   * now. Read on every request_access, so an edit to [computer_use] reaches a
   * session that is already running. Defaults to `policy.apps`.
   */
  approvedApps?: () => string[];
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
  /**
   * Set while this conversation holds the screen: the pids already running
   * when it took the screen (never quit when it lets go) and when it last
   * acted.
   */
  private hold: { before: Set<number>; lastActed: number } | null = null;
  /** Apps this hold launched, by pid, to quit when it ends. */
  private readonly launched = new Map<number, RunningApp>();
  private installed: InstalledApp[] | null = null;
  private readonly native: Native;
  private readonly policy: Policy;
  private readonly scope: Scope;
  private readonly guard: Guard;
  private readonly lock: ScreenLock | null;
  private readonly approvedApps: () => string[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(deps: SessionDeps) {
    this.native = deps.native;
    this.policy = deps.policy;
    this.scope = deps.scope;
    this.guard = deps.guard;
    this.lock = deps.lock;
    this.approvedApps = deps.approvedApps ?? (() => deps.policy.apps);
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
  }

  // ─── Access ────────────────────────────────────────────────────────────

  async requestAccess(req: {
    apps: string[];
    reason: string;
    clipboardRead?: boolean;
    clipboardWrite?: boolean;
    systemKeyCombos?: boolean;
  }): Promise<string> {
    this.installed ??= await this.native.installedApps();
    const approvedNow = this.approvedApps();
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
    const ask = (flag: boolean | undefined) => Boolean(flag);
    this.flags = {
      clipboardRead: this.flags.clipboardRead || (ask(req.clipboardRead) && this.policy.clipboard),
      clipboardWrite:
        this.flags.clipboardWrite || (ask(req.clipboardWrite) && this.policy.clipboard),
      systemKeyCombos:
        this.flags.systemKeyCombos || (ask(req.systemKeyCombos) && this.policy.systemKeyCombos),
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
    return JSON.stringify({
      allowedApps: [...this.grants.values()],
      grantFlags: this.flags,
      approvedApps: this.approvedApps(),
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
    this.hold = null;
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
      case "wait": {
        const secs = Math.min(Math.max(a.duration ?? 1, 0), MAX_WAIT_SECONDS);
        await this.sleep(secs * 1000);
        return { text: `Waited ${secs}s.` };
      }
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
    const { withheld, ...view } = await this.view(running);
    const shot = await this.native.capture({
      display: display.id,
      ...view,
      width: frame.width,
      height: frame.height,
    });
    const notes = [`Screenshot of ${display.name} (${shot.width}x${shot.height}).`];
    if (withheld.length) notes.push(withheldNote(withheld));
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
    const { withheld, ...view } = await this.view(await this.native.running());
    const shot = await this.native.capture({
      display: ref.display.id,
      ...view,
      width,
      height,
      rect,
    });
    return {
      text: `Zoomed (${shot.width}x${shot.height}). Coordinates still refer to the full screenshot.${withheld.length ? ` ${withheldNote(withheld)}` : ""}`,
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
    await this.native.click(at.x, at.y, button, count, flags);
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
    await this.native.scroll(at.x, at.y, dx, dy, flags);
    return { text: `Scrolled ${dir} ${amount}.` };
  }

  // ─── Keyboard ──────────────────────────────────────────────────────────

  private async key(a: Action): Promise<Step> {
    const repeat = Math.min(Math.max(a.repeat ?? 1, 1), 100);
    const { chord, focus, front, words } = await this.prepareChord(a);
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
    );
    await this.native.chord(chord, { repeat });
    return { text: "Key pressed." };
  }

  private async holdKey(a: Action): Promise<Step> {
    const secs = Math.min(Math.max(a.duration ?? 0, 0), MAX_WAIT_SECONDS);
    const { chord, focus, front, words } = await this.prepareChord(a);
    await this.approve(a, front, focus, `hold ${words} for ${secs}s`);
    await this.native.chord(chord, { holdMs: secs * 1000 });
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
    if (focus?.secure && meaning === "Paste") throw new Refusal(PASSWORD_FIELD);
    const words = `key chord ${a.text}${meaning ? ` (macOS shortcut: ${meaning})` : ""}${focus ? ` with focus on ${describeElement(focus)}` : ""}`;
    return { chord, focus, front, words };
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
    if (this.grants.size === 0)
      throw new Refusal("No apps are granted yet. Call request_access first.");
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
    else this.hold = { before: new Set(running.map((a) => a.pid)), lastActed: this.now() };
    this.hold.lastActed = this.now();
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
    return owner;
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
  ) {
    const facts = await this.gateScope(front, target, at);
    await this.check(a.action, a.explanation ?? "", front, target, words, facts);
  }

  private async check(
    tool: string,
    explanation: string,
    front: RunningApp | null,
    target: PointOwner | null,
    action: string,
    facts: Record<string, string> = {},
  ): Promise<void> {
    const verdict = await this.guard.check({
      tool,
      action,
      app: front?.name ?? "",
      window: target?.window ?? "",
      explanation,
      facts,
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
    front: RunningApp,
    target: PointOwner | null,
    at: Point | null,
  ): Promise<Record<string, string>> {
    const app = target?.bundleId || front.bundleId;
    if (app === MESSAGES) return this.gateConversation(target, at);
    if (app === NOTES) return this.gateNote(target, at);
    return {};
  }

  private async gateConversation(
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
    const window = at
      ? windowAt(inspection, at)
      : keyWindow(inspection, target, IDS.conversationList);
    const showing = window?.title ?? "";
    const own = `${showing}: the requester's own conversation, checked against chat.db`;
    const row = rowAt(window, IDS.conversationList, at);
    if (row) {
      if (isConversationRow(mine, row.text)) {
        return {
          messages_showing: showing || "(no conversation open)",
          row_clicked: "the requester's own conversation, in the sidebar",
        };
      }
      throw new Refusal(
        `That row is a different conversation. Only ${describeConversation(mine)} can be opened from here; nothing was done.`,
      );
    }
    if (target?.subrole === "AXSearchField") {
      return { messages_showing: showing || "(no conversation open)", focus: "the search field" };
    }
    if (!isConversation(mine, showing)) {
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
    const window = at ? windowAt(inspection, at) : keyWindow(inspection, target, IDS.noteBody);
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
  private async view(
    running: RunningApp[],
  ): Promise<{ exclude: string[]; include?: string[]; redact: Rect[]; withheld: string[] }> {
    if (this.policy.tier !== "contact") {
      const exclude = running
        .filter((a) => a.regular && a.bundleId && !this.isGranted(a.bundleId))
        .map((a) => a.bundleId);
      return { exclude, redact: [], withheld: [] };
    }
    const redact: Rect[] = [];
    const left: RunningApp[] = [];
    for (const app of [MESSAGES, NOTES]) {
      const shown = running.find((r) => r.bundleId === app && !r.hidden);
      if (!this.isGranted(app) || !shown) continue;
      const ids =
        app === MESSAGES
          ? [IDS.conversationList]
          : [IDS.noteList, IDS.noteBody, IDS.noteBodyScroll];
      const rects = redactions(this.scope, app, await this.native.inspect(app, ids));
      if (rects) redact.push(...rects);
      else left.push(shown);
    }
    const include = [...this.grants.keys()].filter((id) => !left.some((a) => a.bundleId === id));
    return { exclude: [], include, redact, withheld: left.map((a) => a.name) };
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

function withheldNote(apps: string[]): string {
  return `${apps.join(" and ")} could not be checked for other people's conversations and lists right now, so ${apps.length === 1 ? "it was" : "they were"} left out of this image.`;
}

const PASSWORD_FIELD =
  "The focused field is a password field. Edmund never types or pastes into one; nothing was sent. Ask the person to enter it themselves.";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
