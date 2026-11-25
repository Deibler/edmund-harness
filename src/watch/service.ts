/**
 * The watch: asleep until a turn starts to look like an attack.
 *
 * Every tool call a worker makes arrives here twice, before it runs and
 * after (address.ts). Each is added to that turn's flight record, and the
 * tripwires (security/watch/tripwires.ts) are run over it. Nearly every
 * call trips nothing, costs about a millisecond and is let through. When
 * one trips:
 *
 *   block   the call is refused. No judgment is needed for a canary on its
 *           way out or a real credential in a message to a stranger.
 *   hold    the call waits for the judge, a few seconds, because what it
 *           does cannot be taken back. Benign runs; anything else does not.
 *   watch   the call runs, and the judge looks afterwards. Serious is
 *           contained: the turn is stopped and the chat paused until the
 *           operator answers.
 *
 * Three rules about the watch itself. It fails open: no verdict in time, or
 * any error in here, and the call runs, flagged in the log. The watch must
 * never be why real work stopped. It only does what can be undone, and says
 * how in the incident. And in `observe` mode it does everything except stop
 * anything, which is how it is tried on a new machine.
 */
import { readFileSync, statSync } from "node:fs";
import type { Config } from "../config/config.ts";
import { type OutgoingVerdict, listenToPipeline } from "../security/watch/bus.ts";
import { loadSecrets } from "../security/watch/canary.ts";
import { type Meaning, meaningOf } from "../security/watch/classify.ts";
import { KnownHosts, isLocalHost, siteOf } from "../security/watch/hosts.ts";
import { type SecretScanner, keyShapesIn } from "../security/watch/secrets.ts";
import { readWatchState, updateWatchState } from "../security/watch/state.ts";
import {
  type Asker,
  type Flight,
  type Trip,
  type TripContext,
  describeFlight,
  newFlight,
  recordCall,
  recordResult,
  tripsBefore,
} from "../security/watch/tripwires.ts";
import { log } from "../util/log.ts";
import {
  type Incident,
  IncidentLog,
  type UndoStep,
  alertText,
  newIncidentId,
} from "./incidents.ts";
import type { Verdict } from "./judge.ts";

export type WatchMode = "off" | "observe" | "enforce";

export type ToolCall = { tool: string; input: Record<string, unknown>; id?: string };
export type Decision = { allow: true } | { allow: false; reason: string };

export type WatchDeps = {
  config: Config;
  dataDir: string;
  repoRoot: string;
  mode: WatchMode;
  /** Ask the judge about a flagged turn. Null when there is no verdict to be had. */
  judge: (record: string, flagged: string) => Promise<Verdict | null>;
  /** How long a held call waits for the judge before it is let through. */
  holdMs: number;
  /** Text the operator. Returns whether it was sent. */
  notify: (incident: Incident, text: string) => Promise<boolean>;
  /** Stop the turn running in a chat. */
  stopTurn: (session: string, reason: string) => Promise<boolean>;
  /** Who is in a chat, by handle. */
  membersOf: (session: string) => string[];
  /** True for a chat that is the operator's own. */
  isOperatorChat: (session: string) => boolean;
  /** A name for a chat that a person recognises. */
  labelOf: (session: string) => string;
  knownHostsFile: string | null;
  now?: () => number;
};

const ALLOW: Decision = { allow: true };
/** A flight nobody has added to for this long is over. */
const FLIGHT_IDLE_MS = 20 * 60_000;
/** A shape the judge called benign is not asked about again for this long. */
const BENIGN_FOR_MS = 24 * 3_600_000;
/** Files larger than this are not read by the publish check. */
const MAX_PUBLISH_SCAN_BYTES = 5 * 1024 * 1024;

const BROWSER_TOOL =
  /^mcp__(?:chrome-devtools|computer-use)__|^(?:WebFetch|WebSearch)$|^mcp__edmund-harness__(?:web_|cf_)/;

function responseText(response: unknown): string {
  if (typeof response === "string") return response;
  if (response === null || response === undefined) return "";
  try {
    const text = JSON.stringify(response);
    return text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
  } catch {
    return "";
  }
}

export class Watch {
  readonly incidents: IncidentLog;
  private secrets: SecretScanner;
  private readonly known: KnownHosts;
  private readonly flights = new Map<string, Flight>();
  private readonly lastTouched = new Map<string, number>();
  private readonly benignUntil = new Map<string, number>();
  private readonly silent = new Map<string, number[]>();
  private readonly background = new Set<Promise<void>>();
  private stopListening: (() => void) | null = null;
  private readonly now: () => number;
  /** Calls seen and trips raised since start, for `status`. */
  readonly counts = { calls: 0, trips: 0, held: 0, refused: 0, judged: 0 };

  constructor(private readonly deps: WatchDeps) {
    this.now = deps.now ?? Date.now;
    this.incidents = new IncidentLog(deps.dataDir);
    this.secrets = loadSecrets(deps.config, deps.dataDir, deps.repoRoot);
    this.known = new KnownHosts(deps.knownHostsFile);
  }

  get mode(): WatchMode {
    return this.deps.mode;
  }

  /** Start listening to the pipeline: turns starting and ending, replies going out, a quiet hook. */
  start(): void {
    this.stopListening = listenToPipeline({
      turnStarted: (session, turn, ask, asker) => this.turnStarted(session, turn, ask, asker),
      turnEnded: (session) => this.turnEnded(session),
      hookSilent: (session, id, timedOut) => this.hookSilent(session, id, timedOut),
      outgoing: (session, text) => this.outgoing(session, text),
    });
    log.info("watch", `watching in ${this.deps.mode} mode`, {
      secrets: this.secrets.names.length,
      canaries: this.secrets.names.filter((n) => n.startsWith("canary:")).length,
      known_sites: this.known.size,
    });
  }

  async stop(): Promise<void> {
    this.stopListening?.();
    this.stopListening = null;
    await Promise.allSettled([...this.background]);
    this.known.flush();
  }

  /** Read the secrets again, after the config or a token file changed. */
  reloadSecrets(): void {
    this.secrets = loadSecrets(this.deps.config, this.deps.dataDir, this.deps.repoRoot);
  }

  // --- turns -------------------------------------------------------------------

  turnStarted(session: string, turn: string, ask: string, asker: Asker): void {
    this.flights.set(session, newFlight(session, turn, ask, asker, this.now()));
    this.lastTouched.set(session, this.now());
  }

  turnEnded(session: string): void {
    const flight = this.flights.get(session);
    if (!flight) return;
    if (flight.entries.length > 0) {
      log.event("flight", "turn", `turn ended: ${flight.entries.length + flight.dropped} calls`, {
        session,
        turn: flight.turn,
        calls: flight.entries.length + flight.dropped,
        new_sites: flight.newHosts.length > 0 ? flight.newHosts : undefined,
        read_outside: flight.untrusted.length || undefined,
        trips: flight.trips.length > 0 ? flight.trips.map((t) => t.kind) : undefined,
      });
    }
    this.flights.delete(session);
    this.lastTouched.delete(session);
  }

  /** The record a call belongs to. A call with no turn announced is a scheduled or background one. */
  private flightFor(session: string): Flight {
    const now = this.now();
    const last = this.lastTouched.get(session) ?? 0;
    let flight = this.flights.get(session);
    if (!flight || now - last > FLIGHT_IDLE_MS) {
      const tier =
        this.deps.isOperatorChat(session) || !/^(?:imessage|sms):/.test(session)
          ? "operator"
          : "contact";
      flight = newFlight(session, `bg_${now}`, "", { handle: null, tier, label: undefined }, now);
      this.flights.set(session, flight);
    }
    this.lastTouched.set(session, now);
    if (this.flights.size > 200) {
      for (const [key, at] of this.lastTouched) {
        if (now - at > FLIGHT_IDLE_MS) {
          this.flights.delete(key);
          this.lastTouched.delete(key);
        }
      }
    }
    return flight;
  }

  private context(session: string): TripContext {
    const state = readWatchState(this.deps.dataDir);
    return {
      secrets: this.secrets,
      known: this.known,
      allowed: (pattern) => pattern in state.allowed,
      secretSentBefore: (secret, site) => state.sent.includes(`${secret}>${site}`),
      operatorChat: this.deps.isOperatorChat(session),
    };
  }

  // --- a call, before it runs -----------------------------------------------------

  async before(session: string, call: ToolCall): Promise<Decision> {
    if (this.deps.mode === "off") return ALLOW;
    this.counts.calls++;
    const flight = this.flightFor(session);
    const meaning = meaningOf(call.tool, call.input, {
      downloaded: flight.downloads,
      chatMembers: this.deps.membersOf(session),
    });

    const locked = this.lockdownRefusal(session, call.tool, meaning);
    if (locked) return this.refuse(locked);

    const unfit = this.publishProblem(call, meaning);
    if (unfit) {
      recordCall(flight, call.tool, meaning, [], this.now());
      log.event(
        "security",
        "watch",
        `publish refused: ${unfit}`,
        { session, tool: call.tool },
        "warn",
      );
      return this.refuse(`Not published: ${unfit} Take it out and publish again.`);
    }

    const ctx = this.context(session);
    const trips = tripsBefore(flight, call.tool, meaning, ctx, this.now());
    recordCall(flight, call.tool, meaning, trips, this.now());
    this.logCall(flight, call.tool, meaning, trips);
    if (trips.length === 0) {
      this.rememberDestinations(meaning);
      return ALLOW;
    }
    this.counts.trips += trips.length;
    const decision = await this.decide(flight, trips);
    if (decision.allow) this.rememberDestinations(meaning);
    return decision;
  }

  private refuse(reason: string): Decision {
    if (this.deps.mode !== "enforce") return ALLOW;
    this.counts.refused++;
    return { allow: false, reason };
  }

  /** While locked down: no browser, and no message to anyone but the operator. */
  private lockdownRefusal(session: string, tool: string, meaning: Meaning): string | null {
    if (!readWatchState(this.deps.dataDir).lockdown) return null;
    if (BROWSER_TOOL.test(tool)) {
      return "The machine is in lockdown: browsing is off until the operator runs `edmund lockdown off`.";
    }
    if (meaning.message && (meaning.message.outsideChat || !this.deps.isOperatorChat(session))) {
      return "The machine is in lockdown: only the operator can be messaged until `edmund lockdown off`.";
    }
    return null;
  }

  /**
   * What stops a file from being published with the harness's own tools: it
   * holds a canary, a real credential, or something shaped like a vendor's
   * key. Null when it may go, or when it cannot be read as text.
   */
  private publishProblem(call: ToolCall, meaning: Meaning): string | null {
    if (meaning.door?.kind !== "publish") return null;
    const path = typeof call.input.file_path === "string" ? call.input.file_path : "";
    if (!path) return null;
    let text: string;
    try {
      if (statSync(path).size > MAX_PUBLISH_SCAN_BYTES) return null;
      text = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    const hits = this.secrets.find(text);
    if (hits.length > 0) {
      return `the file contains ${hits.map((h) => h.name).join(", ")}, which would be readable by anyone with the link.`;
    }
    const shapes = keyShapesIn(text);
    return shapes.length > 0
      ? `the file contains something shaped like a ${shapes.join(", ")} key, which would be readable by anyone with the link.`
      : null;
  }

  /** A credential that was allowed to go somewhere has now been there. */
  private rememberDestinations(meaning: Meaning): void {
    if (meaning.message) return;
    const remote = meaning.hosts.filter((h) => !isLocalHost(h));
    if (remote.length === 0) return;
    const pairs = this.secrets
      .find(meaning.outbound)
      .filter((h) => h.kind === "secret")
      .flatMap((h) => remote.map((host) => `${h.name}>${siteOf(host)}`));
    if (pairs.length === 0) return;
    const known = readWatchState(this.deps.dataDir).sent;
    const fresh = pairs.filter((p) => !known.includes(p));
    if (fresh.length === 0) return;
    updateWatchState(this.deps.dataDir, (s) => {
      s.sent = [...new Set([...s.sent, ...fresh])];
    });
  }

  private logCall(flight: Flight, tool: string, meaning: Meaning, trips: Trip[]): void {
    const remote = meaning.hosts.filter((h) => !isLocalHost(h));
    if (
      remote.length === 0 &&
      trips.length === 0 &&
      !meaning.door &&
      meaning.persistence.length === 0
    ) {
      return;
    }
    log.event("flight", "call", meaning.summary, {
      session: flight.session,
      turn: flight.turn,
      tool,
      hosts: remote.length > 0 ? remote : undefined,
      sends: meaning.canSend || undefined,
      new_sites: remote.filter((h) => !this.known.has(h)).map(siteOf),
      tripped: trips.length > 0 ? trips.map((t) => `${t.kind}:${t.action}`) : undefined,
    });
  }

  /** Decide what happens to a call that tripped. The most cautious action among its trips wins. */
  private async decide(flight: Flight, trips: Trip[]): Promise<Decision> {
    const enforcing = this.deps.mode === "enforce";
    const blocked = trips.find((t) => t.action === "block");
    if (blocked) {
      const hunting = blocked.kind === "canary-out";
      const incident = await this.raise(flight, blocked, "rule", "", "serious", hunting);
      if (!enforcing) return ALLOW;
      this.counts.refused++;
      return {
        allow: false,
        reason:
          `Stopped by the security watch: ${blocked.why}. It was not run` +
          `${hunting ? ", this chat is paused" : ""} and the operator has been told (incident ${incident.id}).`,
      };
    }

    const held = trips.find((t) => t.action === "hold");
    for (const trip of trips) if (trip !== held) this.later(this.judgeAfter(flight, trip));
    if (!held) return ALLOW;
    if (!enforcing) {
      this.later(this.judgeAfter(flight, held));
      return ALLOW;
    }

    this.counts.held++;
    const verdict = this.recentlyBenign(held.pattern)
      ? ({
          verdict: "benign",
          why: "the same shape was reviewed as benign earlier today",
        } as Verdict)
      : await this.judgeWithin(flight, held);
    if (!verdict) {
      // No verdict in time: the call runs, and the judge is asked again behind it.
      log.event(
        "security",
        "watch",
        `held call let through without a verdict: ${held.why}`,
        {
          session: flight.session,
          kind: held.kind,
        },
        "warn",
      );
      this.later(this.judgeAfter(flight, held));
      return ALLOW;
    }
    if (verdict.verdict === "benign") {
      this.benignUntil.set(held.pattern, this.now() + BENIGN_FOR_MS);
      log.event("security", "watch", `held and released: ${held.why}`, {
        session: flight.session,
        kind: held.kind,
        verdict: "benign",
        why: verdict.why,
      });
      return ALLOW;
    }
    const serious = verdict.verdict === "serious";
    const incident = await this.raise(
      flight,
      held,
      verdict.verdict,
      verdict.why,
      "serious",
      serious,
    );
    this.counts.refused++;
    return {
      allow: false,
      reason: serious
        ? `Stopped by the security watch: ${held.why}. A reviewer judged it serious: ${verdict.why} It was not run, this chat is paused and the operator has been told (incident ${incident.id}).`
        : `Held by the security watch: ${held.why}. A reviewer could not tie it to what was asked: ${verdict.why} It was not run. Say what you were trying to do; the operator can allow it by replying OK ${incident.id} to the alert.`,
    };
  }

  private recentlyBenign(pattern: string): boolean {
    return (this.benignUntil.get(pattern) ?? 0) > this.now();
  }

  private async judgeWithin(flight: Flight, trip: Trip): Promise<Verdict | null> {
    this.counts.judged++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.deps.holdMs);
    });
    try {
      return await Promise.race([this.deps.judge(describeFlight(flight), trip.why), late]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Judge a call that has already run, and contain it if it was serious. */
  private async judgeAfter(flight: Flight, trip: Trip): Promise<void> {
    if (this.recentlyBenign(trip.pattern)) return;
    this.counts.judged++;
    let verdict: Verdict | null = null;
    try {
      verdict = await this.deps.judge(describeFlight(flight), trip.why);
    } catch {}
    if (!verdict) {
      log.event(
        "security",
        "watch",
        `tripped, no verdict: ${trip.why}`,
        {
          session: flight.session,
          kind: trip.kind,
        },
        "warn",
      );
      return;
    }
    if (verdict.verdict === "benign") {
      this.benignUntil.set(trip.pattern, this.now() + BENIGN_FOR_MS);
      log.event("security", "watch", `tripped and reviewed as benign: ${trip.why}`, {
        session: flight.session,
        kind: trip.kind,
        verdict: "benign",
        why: verdict.why,
      });
      return;
    }
    const serious = verdict.verdict === "serious";
    await this.raise(
      flight,
      trip,
      verdict.verdict,
      verdict.why,
      serious ? "serious" : "notable",
      serious,
    );
  }

  private later(work: Promise<void>): void {
    const tracked = work.catch(() => {}).finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  /** Let everything started in the background finish. For tests and shutdown. */
  async settled(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  // --- raising an incident ---------------------------------------------------------

  /**
   * Write an incident down, contain it when asked to, and tell the operator
   * when it is serious. `contain` stops the turn and pauses the chat.
   */
  private async raise(
    flight: Flight,
    trip: Trip,
    verdict: Incident["verdict"],
    judged: string,
    tier: Incident["tier"],
    contain: boolean,
  ): Promise<Incident> {
    const enforcing = this.deps.mode === "enforce";
    const incident: Incident = {
      id: newIncidentId(),
      at: this.now(),
      where: `${this.deps.labelOf(flight.session)} (${trip.tool})`,
      kind: trip.kind,
      tier,
      what: trip.why,
      verdict,
      judged,
      pattern: trip.kind === "canary-out" || trip.kind === "canary-read" ? "" : trip.pattern,
      did: [],
      undo: [],
      status: "open",
    };
    if (trip.action !== "watch" && enforcing) incident.did.push("refused the call");
    if (contain && enforcing) {
      const stopped = await this.deps
        .stopTurn(flight.session, `security watch: ${trip.kind}`)
        .catch(() => false);
      if (stopped) incident.did.push("stopped the turn");
      updateWatchState(this.deps.dataDir, (s) => {
        s.paused[flight.session] = { since: this.now(), why: trip.why, incident: incident.id };
      });
      incident.did.push("paused this chat");
      incident.undo.push({ kind: "resume-session", session: flight.session });
    }
    await this.record(incident);
    return incident;
  }

  /** Save an incident, log it, and text the operator if it is serious. */
  async record(incident: Incident): Promise<void> {
    this.incidents.save(incident);
    log.event(
      "security",
      "watch",
      `${incident.tier} ${incident.id}: ${incident.what}`,
      {
        incident: incident.id,
        kind: incident.kind,
        where: incident.where,
        verdict: incident.verdict,
        why: incident.judged || undefined,
        did: incident.did.length > 0 ? incident.did : undefined,
      },
      incident.tier === "serious" ? "error" : "warn",
    );
    if (incident.tier !== "serious") return;
    try {
      await this.deps.notify(incident, alertText(incident, this.deps.mode !== "enforce"));
    } catch (err) {
      log.warn("watch", "could not text the operator", { err: (err as Error).message });
    }
  }

  // --- a call, after it ran ----------------------------------------------------------

  async after(session: string, call: ToolCall, response: unknown): Promise<void> {
    if (this.deps.mode === "off") return;
    const flight = this.flightFor(session);
    const meaning = meaningOf(call.tool, call.input, {
      downloaded: flight.downloads,
      chatMembers: this.deps.membersOf(session),
    });
    const before = flight.newHosts.length;
    const trips = recordResult(
      flight,
      call.tool,
      meaning,
      responseText(response),
      this.context(session),
      this.now(),
    );
    for (const host of flight.newHosts.slice(before)) {
      log.event("security", "watch", `first contact with ${siteOf(host)}`, {
        session,
        kind: "first-seen-host",
        host,
        tool: call.tool,
        after_outside_content: flight.untrusted.length > 0 || undefined,
      });
    }
    this.counts.trips += trips.length;
    for (const trip of trips) this.later(this.judgeAfter(flight, trip));
  }

  // --- the pipeline's own reports -------------------------------------------------------

  /** A reply the daemon is about to send for the model: checked for what must never be in a message. */
  outgoing(session: string, text: string): OutgoingVerdict {
    if (this.deps.mode === "off") return { allow: true };
    const state = readWatchState(this.deps.dataDir);
    const own = this.deps.isOperatorChat(session);
    if (state.lockdown && !own) {
      return { allow: false, reason: "the machine is in lockdown: only the operator is messaged" };
    }
    const hits = this.secrets.find(text);
    const canary = hits.find((h) => h.kind === "canary");
    const secret = hits.find((h) => h.kind === "secret");
    const bad = canary ?? (own ? undefined : secret);
    if (!bad) return { allow: true };
    const flight = this.flightFor(session);
    const trip: Trip = {
      kind: canary ? "canary-out" : "secret-out",
      action: "block",
      at: this.now(),
      session,
      turn: flight.turn,
      tool: "reply",
      why: canary
        ? `the canary ${bad.name} was in a reply about to be sent`
        : `the credential ${bad.name} was in a reply to someone other than the operator`,
      pattern: "",
      target: bad.name,
    };
    this.later(this.raise(flight, trip, "rule", "", "serious", Boolean(canary)).then(() => {}));
    return this.deps.mode === "enforce"
      ? { allow: false, reason: `the reply contained ${bad.name}` }
      : { allow: true };
  }

  /**
   * A tool call ran without the watch's answer. One is a blip. Several in a
   * minute means the watch is not answering while a worker is busy, which is
   * exactly what switching it off would look like.
   */
  hookSilent(session: string, _toolUseId: string, timedOut: boolean): void {
    if (this.deps.mode === "off") return;
    const now = this.now();
    const recent = (this.silent.get(session) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    this.silent.set(session, recent);
    if (recent.length !== 3) return;
    this.later(
      this.record({
        id: newIncidentId(),
        at: now,
        where: this.deps.labelOf(session),
        kind: "watch-silent",
        tier: "serious",
        what: `the watch did not answer ${recent.length} tool calls in a minute${timedOut ? " (it was too slow)" : ""}, so they ran unchecked`,
        verdict: "rule",
        judged: "",
        pattern: "",
        did: [],
        undo: [],
        status: "open",
      }),
    );
  }

  // --- the operator's answer ---------------------------------------------------------------

  /** Reverse what was done for an incident. `learn` also allows its shape from now on. */
  async resolve(
    incident: Incident,
    learn: boolean,
    reverse: (step: UndoStep) => Promise<string>,
  ): Promise<string[]> {
    const done: string[] = [];
    for (const step of incident.undo) {
      try {
        done.push(await reverse(step));
      } catch (err) {
        done.push(`could not reverse ${step.kind}: ${(err as Error).message}`);
      }
    }
    if (learn && incident.pattern) {
      updateWatchState(this.deps.dataDir, (s) => {
        s.allowed[incident.pattern] = this.now();
      });
      done.push("will not raise this again here");
    }
    incident.status = learn ? "ok" : "undone";
    this.incidents.save(incident);
    log.event("security", "watch", `incident ${incident.id} answered ${learn ? "OK" : "UNDO"}`, {
      incident: incident.id,
      did: done,
    });
    return done;
  }
}
