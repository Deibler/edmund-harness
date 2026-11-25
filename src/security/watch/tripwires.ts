/**
 * The flight record of a turn, and the rules that say when one starts to
 * look like an attack.
 *
 * Nothing here restricts a turn. A turn that trips nothing, which is nearly
 * all of them, is recorded and otherwise left alone. A rule fires on a shape:
 * a canary on its way out, a credential going somewhere it has never been,
 * fetched code run unseen, a text to someone outside the conversation just
 * after the turn read what a stranger wrote. Whether the shape is an attack
 * or what the person asked for is a question for the judge, who is handed
 * this record. The rules only decide what to do in the meantime:
 *
 *  - `block`: refused here. Only for what is never legitimate: a canary
 *    leaving, or a real credential in a message to someone who is not the
 *    operator.
 *  - `hold`: the call waits for the judge, because once it has run it cannot
 *    be taken back.
 *  - `watch`: the call runs, and the judge looks at it afterwards; what it
 *    did can be undone.
 *
 * Everything is a pure function of the record and the call, so the same
 * rules replay over a month of real transcripts to count what they would
 * have done (scripts/watch-replay.ts) before they are trusted to do it.
 */
import type { Meaning } from "./classify.ts";
import { type KnownHosts, isDropSite, isLocalHost, siteOf } from "./hosts.ts";
import { type SecretHit, type SecretScanner, keyShapesIn } from "./secrets.ts";

type TripKind =
  | "canary-out"
  | "canary-read"
  | "secret-out"
  | "key-out"
  | "secret-then-new-host"
  | "send-after-untrusted"
  | "fetched-code"
  | "hidden-command"
  | "persistence"
  | "new-door"
  | "message-outside-chat";

type TripAction = "block" | "hold" | "watch";

export type Trip = {
  kind: TripKind;
  action: TripAction;
  at: number;
  session: string;
  turn: string;
  tool: string;
  /** One sentence saying what was seen. Names of secrets, never their values. */
  why: string;
  /** What an OK from the operator would allow again: this kind, this target, this chat. */
  pattern: string;
  target: string;
};

type FlightEntry = {
  at: number;
  tool: string;
  summary: string;
  hosts?: string[];
  untrusted?: true;
  tripped?: TripKind[];
};

export type Asker = { handle: string | null; tier: string; label?: string };

/** What one turn was asked, read, and did. */
export type Flight = {
  session: string;
  turn: string;
  startedAt: number;
  /** What the person asked for, as the turn received it. Empty for a scheduled turn. */
  ask: string;
  asker: Asker;
  entries: FlightEntry[];
  /** Content the turn read that someone else wrote. */
  untrusted: { at: number; source: string }[];
  /** Credentials whose value the turn has had in front of it. */
  secretsSeen: { at: number; name: string }[];
  /** Places credentials live that the turn read from. */
  secretPaths: { at: number; what: string }[];
  /** Files the turn brought in from the network. */
  downloads: string[];
  /** Sites the turn reached that this machine had not reached before. */
  newHosts: string[];
  trips: Trip[];
  /** (kind, target) pairs already raised this turn. */
  raised: Set<string>;
  dropped: number;
};

const MAX_ENTRIES = 120;
const MAX_LIST = 40;

export function newFlight(
  session: string,
  turn: string,
  ask: string,
  asker: Asker,
  at: number,
): Flight {
  return {
    session,
    turn,
    startedAt: at,
    ask: ask.replace(/\s+/g, " ").trim().slice(0, 1200),
    asker,
    entries: [],
    untrusted: [],
    secretsSeen: [],
    secretPaths: [],
    downloads: [],
    newHosts: [],
    trips: [],
    raised: new Set(),
    dropped: 0,
  };
}

function pushBounded<T>(list: T[], item: T, max = MAX_LIST): void {
  list.push(item);
  if (list.length > max) list.shift();
}

export type TripContext = {
  secrets: SecretScanner;
  known: KnownHosts;
  /** True when the operator has said this pattern is fine. */
  allowed: (pattern: string) => boolean;
  /** True when a destination has been sent this credential before. */
  secretSentBefore: (secret: string, site: string) => boolean;
  /** True when the turn's chat is the operator's own and nobody else is in it. */
  operatorChat: boolean;
};

const outside = (hosts: string[]) => hosts.filter((h) => !isLocalHost(h));

function unseen(hosts: string[], known: KnownHosts): string[] {
  return outside(hosts).filter((h) => !known.has(h));
}

const list = (items: string[], n = 3) =>
  items.length <= n
    ? items.join(", ")
    : `${items.slice(0, n).join(", ")} and ${items.length - n} more`;

/**
 * The trips a call raises before it runs. Recorded on the flight, and
 * returned for the caller to act on. A pattern the operator has allowed, and
 * one already raised this turn, raises nothing.
 */
export function tripsBefore(
  flight: Flight,
  tool: string,
  meaning: Meaning,
  ctx: TripContext,
  at: number,
): Trip[] {
  const found: Trip[] = [];
  const raise = (kind: TripKind, action: TripAction, target: string, why: string) => {
    const pattern = `${kind}|${target}|${flight.session}`;
    const once = `${kind}|${target}`;
    if (flight.raised.has(once) || ctx.allowed(pattern)) return;
    flight.raised.add(once);
    found.push({
      kind,
      action,
      at,
      session: flight.session,
      turn: flight.turn,
      tool,
      why,
      pattern,
      target,
    });
  };

  const remote = outside(meaning.hosts);
  const fresh = unseen(meaning.hosts, ctx.known);
  const toPeople = meaning.message !== null;
  const beyondOperator = toPeople && (meaning.message!.outsideChat || !ctx.operatorChat);
  const leavesMachine = remote.length > 0 || toPeople || meaning.door !== null;

  // What the call would send or write, read for credentials by value.
  const hits = ctx.secrets.find(meaning.outbound);
  const canaries = hits.filter((h) => h.kind === "canary");
  const secrets = hits.filter((h) => h.kind === "secret");

  if (canaries.length > 0) {
    const names = list(canaries.map((c) => c.name));
    if (leavesMachine) {
      const target = toPeople
        ? "a message"
        : remote.length > 0
          ? list(remote)
          : meaning.door!.detail;
      const going = toPeople
        ? "out in a message"
        : remote.length > 0
          ? `to ${target}`
          : `out through ${target}`;
      raise("canary-out", "block", target, `the canary ${names} was about to go ${going}`);
    } else {
      raise("canary-read", "watch", names, `the canary ${names} was used in a command`);
    }
  }

  for (const secret of secrets) {
    if (toPeople) {
      if (beyondOperator) {
        raise(
          "secret-out",
          "block",
          `message:${secret.name}`,
          `the credential ${secret.name} was about to be sent in a message to someone other than the operator`,
        );
      }
      continue;
    }
    const newTo = remote.filter((h) => !ctx.secretSentBefore(secret.name, siteOf(h)));
    if (newTo.length > 0) {
      raise(
        "secret-out",
        "hold",
        `${secret.name}>${siteOf(newTo[0]!)}`,
        `the credential ${secret.name}${secret.encoded ? " (encoded)" : ""} would go to ${list(newTo)}, which has not been sent it before`,
      );
    }
  }

  // A vendor-format key that is not one of ours: an unknown credential, or bait.
  if (hits.length === 0 && (beyondOperator || fresh.length > 0)) {
    const shapes = keyShapesIn(meaning.outbound);
    if (shapes.length > 0) {
      const where = beyondOperator ? "a message" : list(fresh);
      raise(
        "key-out",
        "hold",
        `${shapes[0]}>${beyondOperator ? "message" : siteOf(fresh[0]!)}`,
        `something shaped like a ${list(shapes)} key would go out in ${where}`,
      );
    }
  }

  const sending = meaning.canSend ? fresh : [];
  const holdsSecret = flight.secretsSeen.length > 0 || flight.secretPaths.length > 0;
  if (sending.length > 0 && holdsSecret) {
    const read = [
      ...flight.secretsSeen.map((s) => s.name),
      ...flight.secretPaths.map((s) => s.what),
    ];
    raise(
      "secret-then-new-host",
      "hold",
      siteOf(sending[0]!),
      `after reading ${list([...new Set(read)])}, the turn would send data to ${list(sending)}, which this machine has never contacted`,
    );
  } else if (sending.length > 0 && flight.untrusted.length > 0) {
    raise(
      "send-after-untrusted",
      "watch",
      siteOf(sending[0]!),
      `after reading ${flight.untrusted.at(-1)!.source}, the turn sends data to ${list(sending)}, which this machine has never contacted`,
    );
  } else if (meaning.canSend) {
    const drops = remote.filter(isDropSite);
    if (drops.length > 0) {
      raise(
        "send-after-untrusted",
        "watch",
        siteOf(drops[0]!),
        `the turn sends data to ${list(drops)}, a place that passes on whatever it is sent`,
      );
    }
  }

  if (meaning.exec.pipeToShell) {
    raise(
      "fetched-code",
      fresh.length > 0 ? "hold" : "watch",
      remote.length > 0 ? siteOf(remote[0]!) : "a download",
      fresh.length > 0
        ? `code fetched from ${list(fresh)}, which this machine has never contacted, would run without being read`
        : `code fetched from ${list(remote) || "the network"} runs without being read`,
    );
  }
  if (meaning.exec.ran.length > 0) {
    raise(
      "fetched-code",
      "watch",
      meaning.exec.ran[0]!.split("/").pop() ?? "a download",
      `the turn runs ${list(meaning.exec.ran)}, which it downloaded earlier`,
    );
  }
  if (meaning.exec.decoded) {
    raise(
      "hidden-command",
      "hold",
      "decoded",
      "a command hidden in an encoding would be decoded and run",
    );
  }

  for (const what of meaning.persistence) {
    raise(
      "persistence",
      "watch",
      what,
      `the turn changes ${what}, which stays in effect after it ends`,
    );
  }

  // Publishing through the harness's own tools is checked by the publish
  // gate, which reads the file. A tunnel or listener started by hand is not.
  if (meaning.door && meaning.door.kind !== "publish") {
    raise(
      "new-door",
      "watch",
      meaning.door.detail,
      `the turn opens a ${meaning.door.kind}: ${meaning.door.detail}`,
    );
  }

  if (meaning.message?.outsideChat && flight.untrusted.length > 0) {
    raise(
      "message-outside-chat",
      "hold",
      meaning.message.recipients.join(","),
      `after reading ${flight.untrusted.at(-1)!.source}, the turn would text someone who is not in this conversation`,
    );
  }

  for (const trip of found) pushBounded(flight.trips, trip);
  return found;
}

/** Add a call to the record as it is made. */
export function recordCall(
  flight: Flight,
  tool: string,
  meaning: Meaning,
  trips: Trip[],
  at: number,
): void {
  const entry: FlightEntry = { at, tool, summary: meaning.summary };
  const remote = outside(meaning.hosts);
  if (remote.length > 0) entry.hosts = remote.slice(0, 6);
  if (trips.length > 0) entry.tripped = trips.map((t) => t.kind);
  flight.entries.push(entry);
  if (flight.entries.length > MAX_ENTRIES) {
    flight.entries.shift();
    flight.dropped++;
  }
  for (const what of meaning.secretPaths) {
    if (!flight.secretPaths.some((s) => s.what === what))
      pushBounded(flight.secretPaths, { at, what });
  }
}

/**
 * What a finished call adds to the record: what it read that someone else
 * wrote, which credentials its result put in front of the model, what it
 * downloaded, and which sites are now known. Returns the trips raised by
 * what came back, which can only be watched: the call has run.
 */
export function recordResult(
  flight: Flight,
  tool: string,
  meaning: Meaning,
  response: string,
  ctx: TripContext,
  at: number,
): Trip[] {
  const found: Trip[] = [];
  // The operator's own conversation is not outside content; anyone else's is.
  if (meaning.readsUntrusted || (meaning.readsMessages && !ctx.operatorChat)) {
    pushBounded(flight.untrusted, { at, source: meaning.summary });
    for (let i = flight.entries.length - 1; i >= 0; i--) {
      const entry = flight.entries[i]!;
      if (entry.tool === tool && entry.summary === meaning.summary) {
        entry.untrusted = true;
        break;
      }
    }
  }
  for (const file of meaning.downloads) {
    if (!flight.downloads.includes(file)) pushBounded(flight.downloads, file);
  }
  for (const host of outside(meaning.hosts)) {
    if (ctx.known.note(host, at)) pushBounded(flight.newHosts, host);
  }

  const hits: SecretHit[] = response ? ctx.secrets.find(response) : [];
  for (const hit of hits) {
    if (hit.kind === "secret") {
      if (!flight.secretsSeen.some((s) => s.name === hit.name)) {
        pushBounded(flight.secretsSeen, { at, name: hit.name });
      }
      continue;
    }
    const once = `canary-read|${hit.name}`;
    const pattern = `${once}|${flight.session}`;
    if (flight.raised.has(once) || ctx.allowed(pattern)) continue;
    flight.raised.add(once);
    found.push({
      kind: "canary-read",
      action: "watch",
      at,
      session: flight.session,
      turn: flight.turn,
      tool,
      why: `the turn read the canary ${hit.name}, which nothing has a reason to read`,
      pattern,
      target: hit.name,
    });
  }
  if (response && keyShapesIn(response).includes("private-key")) {
    if (!flight.secretPaths.some((s) => s.what === "a private key")) {
      pushBounded(flight.secretPaths, { at, what: "a private key" });
    }
  }
  for (const trip of found) pushBounded(flight.trips, trip);
  return found;
}

/** The record as text for the judge and for an alert: what was asked, read, and done. */
export function describeFlight(flight: Flight, max = 60): string {
  const who = flight.asker.label ?? flight.asker.handle ?? "nobody (a scheduled turn)";
  const lines = [
    `Conversation: ${flight.session}`,
    `Asked by: ${who} (trust: ${flight.asker.tier})`,
    `What was asked: ${flight.ask || "(no message: a scheduled or background turn)"}`,
    "",
    "What the turn did, in order:",
  ];
  if (flight.dropped > 0) lines.push(`  (${flight.dropped} earlier steps not shown)`);
  const shown = flight.entries.slice(-max);
  shown.forEach((e, i) => {
    const marks = [
      e.untrusted ? "READ OUTSIDE CONTENT" : "",
      e.hosts ? `hosts: ${e.hosts.join(", ")}` : "",
      e.tripped ? `TRIPPED: ${e.tripped.join(", ")}` : "",
    ].filter(Boolean);
    lines.push(`  ${i + 1}. ${e.summary}${marks.length > 0 ? `  [${marks.join("; ")}]` : ""}`);
  });
  if (flight.secretsSeen.length + flight.secretPaths.length > 0) {
    const read = [
      ...flight.secretsSeen.map((s) => s.name),
      ...flight.secretPaths.map((s) => s.what),
    ];
    lines.push("", `Credentials the turn has read: ${[...new Set(read)].join(", ")}`);
  }
  if (flight.newHosts.length > 0) {
    lines.push(`Sites contacted for the first time: ${flight.newHosts.join(", ")}`);
  }
  return lines.join("\n");
}
