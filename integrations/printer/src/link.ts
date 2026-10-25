import { type MqttSession, openMqtt } from "./mqtt.ts";
import { type PrinterState, type Raw, mergeReport, normalize } from "./report.ts";

/**
 * One MQTT conversation with the printer: the merged report, the parsed
 * state, and request/reply pairing by `sequence_id`.
 *
 * The daemon keeps one of these open for as long as it runs (`persistent`),
 * reconnecting with backoff; a tool that cannot reach the daemon opens one
 * for a single call. Sequence ids start at a random point in 20000-29999,
 * the window Bambu's own software uses: firmware remembers recent ids and
 * rejects a repeat.
 */

export type CommandSection = "print" | "system" | "pushing" | "info" | "camera" | "xcam";

export type LinkOptions = {
  host: string;
  accessCode: string;
  serial: string;
  persistent?: boolean;
  onState?: (state: PrinterState, prev: PrinterState | null) => void;
  onLog?: (msg: string) => void;
};

type Pending = {
  section: string;
  command: string;
  resolve: (r: Raw) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class PrinterLink {
  raw: Raw = {};
  state: PrinterState | null = null;
  updatedMs = 0;
  modules: Raw[] = [];
  connected = false;
  lastError = "";
  private session: MqttSession | null = null;
  private seq = 20000 + Math.floor(Math.random() * 9000);
  private pending = new Map<string, Pending>();
  private stateWaiters = new Set<() => void>();
  private stopped = false;
  private retryMs = 2_000;
  private resync: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: LinkOptions) {}

  private get reportTopic() {
    return `device/${this.opts.serial}/report`;
  }
  private get requestTopic() {
    return `device/${this.opts.serial}/request`;
  }

  async connect(): Promise<void> {
    this.session = await openMqtt({
      host: this.opts.host,
      username: "bblp",
      password: this.opts.accessCode,
      expectCn: this.opts.serial,
      topic: this.reportTopic,
      onMessage: (_t, payload) => this.onMessage(payload),
      onClose: (why) => this.onDrop(why),
    });
    this.connected = true;
    this.lastError = "";
    this.retryMs = 2_000;
    this.send("pushing", { command: "pushall", version: 1, push_target: 1 });
    this.send("info", { command: "get_version" });
    if (this.opts.persistent && !this.resync) {
      // P-series printers send deltas; a periodic full report repairs any drift.
      this.resync = setInterval(() => {
        if (this.connected)
          this.send("pushing", { command: "pushall", version: 1, push_target: 1 });
      }, 10 * 60_000);
    }
  }

  /** Connect, retrying forever with backoff. For the daemon. */
  start(): void {
    this.stopped = false;
    const attempt = () => {
      if (this.stopped) return;
      this.connect().catch((e: Error) => {
        this.connected = false;
        this.lastError = e.message;
        this.opts.onLog?.(
          `printer connect failed: ${e.message}; retrying in ${this.retryMs / 1000}s`,
        );
        setTimeout(attempt, this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 5 * 60_000);
      });
    };
    attempt();
  }

  private onDrop(why: string) {
    this.connected = false;
    this.lastError = why;
    this.session = null;
    if (this.opts.persistent && !this.stopped) {
      this.opts.onLog?.(`printer connection dropped (${why}); reconnecting`);
      setTimeout(() => this.start(), this.retryMs);
    }
  }

  private onMessage(payload: string) {
    let msg: Raw;
    try {
      msg = JSON.parse(payload) as Raw;
    } catch {
      return;
    }
    for (const [section, body] of Object.entries(msg)) {
      if (typeof body !== "object" || body === null) continue;
      const b = body as Raw;
      const command = String(b.command ?? "");
      if (section === "print" && command === "push_status") {
        const prev = this.state;
        this.raw = mergeReport(this.raw, b);
        this.state = normalize(this.raw);
        this.updatedMs = Date.now();
        this.opts.onState?.(this.state, prev);
        for (const w of this.stateWaiters) w();
        continue;
      }
      if (section === "info" && command === "get_version" && Array.isArray(b.module)) {
        this.modules = b.module as Raw[];
      }
      const id = String(b.sequence_id ?? "");
      const p = this.pending.get(id);
      if (p && p.section === section && (!command || command === p.command)) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.resolve(b);
      }
    }
  }

  private send(section: CommandSection, body: Raw): string {
    const id = String(this.seq);
    this.seq = this.seq >= 29999 ? 20000 : this.seq + 1;
    this.session?.publish(
      this.requestTopic,
      JSON.stringify({ [section]: { sequence_id: id, ...body } }),
    );
    return id;
  }

  /**
   * Send a command and wait for the printer's reply to it. `qos1` asks the
   * broker to acknowledge receipt first, as Bambu's software does for stop.
   */
  async command(
    section: CommandSection,
    body: Raw & { command: string },
    opts: { timeoutMs?: number; qos1?: boolean } = {},
  ): Promise<Raw> {
    // Pausing is not something Edmund does, from any path. Stopping and resuming
    // go through the approval gate in the runtime; pausing has no gate because
    // it has no caller.
    if (section === "print" && body.command === "pause")
      throw new Error("Edmund does not pause prints.");
    if (!this.session || !this.connected)
      throw new Error(this.lastError || "printer not connected");
    const id = String(this.seq);
    this.seq = this.seq >= 29999 ? 20000 : this.seq + 1;
    const reply = new Promise<Raw>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`printer did not answer ${body.command}`));
      }, opts.timeoutMs ?? 15_000);
      this.pending.set(id, { section, command: body.command, resolve, timer });
    });
    const text = JSON.stringify({ [section]: { sequence_id: id, ...body } });
    if (opts.qos1) await this.session.publishAcked(this.requestTopic, text);
    else this.session.publish(this.requestTopic, text);
    return reply;
  }

  /** Resolve with the state once `pred` holds, or reject after the timeout. */
  waitFor(pred: (s: PrinterState) => boolean, timeoutMs: number): Promise<PrinterState> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.state && pred(this.state)) {
          clearTimeout(timer);
          this.stateWaiters.delete(check);
          resolve(this.state);
        }
      };
      const timer = setTimeout(() => {
        this.stateWaiters.delete(check);
        reject(new Error("the printer did not get there in time"));
      }, timeoutMs);
      this.stateWaiters.add(check);
      check();
    });
  }

  close(): void {
    this.stopped = true;
    if (this.resync) clearInterval(this.resync);
    this.resync = null;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.session?.close();
    this.session = null;
    this.connected = false;
  }
}

/** A link for one call: connect, wait for the first full report, hand it over. */
export async function openLink(opts: Omit<LinkOptions, "persistent">): Promise<PrinterLink> {
  const link = new PrinterLink(opts);
  await link.connect();
  await link
    .waitFor((s) => s.gcodeState !== "UNKNOWN", 8_000)
    .catch(() => {
      link.close();
      throw new Error("the printer connected but sent no status");
    });
  return link;
}
