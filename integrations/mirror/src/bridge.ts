import type { Config } from "../../../src/config/config.ts";
import { mirrorConfig } from "../config.ts";
import { contractDigest } from "./contract.ts";
import {
  type AgentFrame,
  AgentFrameSchema,
  type MirrorConversationMessage,
  type PiEvent,
  PiEventSchema,
  mirrorFrameId,
} from "./protocol.ts";
import type { MirrorOutboxRow, MirrorStore } from "./store.ts";

export type MirrorDelivery = {
  delivered: boolean;
  suppressed?: boolean;
  error?: string;
};

type MirrorEventHandlers = {
  onWake?: (detection?: { score?: number; label?: string }) => void;
  onUtterance?: (wavBase64: string, eventId: string) => void | Promise<void>;
  onAudioDone?: (error: boolean, requestId: string, detail?: string) => void;
  onListenTimeout?: () => void;
  onScreenStatus?: (connected: boolean) => void;
  onSpeakText?: (text: string, requestId: string) => Promise<MirrorDelivery>;
  onCloseConversation?: (requestId: string) => void;
};

const OUTBOX_DRAIN_MS = 300;
const OUTBOX_RETRY_MS = 2_000;
const EXPIRY_SWEEP_MS = 15_000;
const HEARTBEAT_MS = 15_000;
const LIVENESS_TIMEOUT_MS = 45_000;
const ACK_TIMEOUT_MS = 8_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const MAX_INFLIGHT = 32;

type PendingAck = {
  timer: ReturnType<typeof setTimeout>;
  resolve: (delivery: MirrorDelivery) => void;
};

/**
 * The single authenticated Mac → Pi transport.
 *
 * A reconnect first converges the Pi with a full snapshot. Durable deltas are
 * then retried with stable message ids until acknowledged. The Pi deduplicates
 * those ids, making an acknowledgement lost in transit safe to retry.
 */
export class MirrorBridge {
  private readonly config: Config;
  private readonly store: MirrorStore;
  private readonly handlers: MirrorEventHandlers;
  private ws: WebSocket | null = null;
  private reconnectMs = RECONNECT_MIN_MS;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private expiryTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAcks = new Map<string, PendingAck>();
  private inflightOutbox = new Set<string>();
  private generation = 0;
  private lastInboundAt = 0;
  private snapshotId: string | null = null;
  private synced = false;
  private stopped = false;

  constructor(config: Config, store: MirrorStore, handlers: MirrorEventHandlers) {
    this.config = config;
    this.store = store;
    this.handlers = handlers;
  }

  start(): void {
    if (!this.stopped && (this.ws || this.drainTimer)) return;
    this.stopped = false;
    this.connect();
    this.drainTimer = setInterval(() => void this.drainOutbox(), OUTBOX_DRAIN_MS);
    this.drainTimer.unref?.();
    this.expiryTimer = setInterval(() => this.store.pruneExpired(), EXPIRY_SWEEP_MS);
    this.expiryTimer.unref?.();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.drainTimer) clearInterval(this.drainTimer);
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.drainTimer = null;
    this.expiryTimer = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.rejectPending("mirror bridge stopped");
    try {
      this.ws?.close();
    } catch {
      // already closing
    }
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async setOverlay(
    overlay: {
      phase: "idle" | "listening" | "thinking" | "working" | "responding" | "speaking" | "showing";
      userText?: string;
      userFinal?: boolean;
      botText?: string;
      messages?: MirrorConversationMessage[];
      detail?: string;
      /** Sub-agents in flight; drives the delegating presence on the glass. */
      agents?: number;
    },
    id = mirrorFrameId("overlay"),
  ): Promise<MirrorDelivery> {
    return this.sendTransient({
      v: 2,
      id,
      type: "overlay_set",
      overlay,
    });
  }

  async playAudio(
    data: {
      base64: string;
      format: "mp3" | "wav" | "aac" | "ogg";
      text?: string;
      messageId?: string;
    },
    id = mirrorFrameId("audio"),
  ): Promise<MirrorDelivery> {
    return this.sendTransient({
      v: 2,
      id,
      type: "audio_play",
      data: data.base64,
      format: data.format,
      ...(data.text ? { text: data.text } : {}),
      ...(data.messageId ? { messageId: data.messageId } : {}),
    });
  }

  async requestFollowup(id = mirrorFrameId("followup")): Promise<MirrorDelivery> {
    return this.sendTransient({ v: 2, id, type: "followup_listen" });
  }

  /** Undo a duck when the wake that caused it turned out to be our own voice. */
  async resumeAudio(id = mirrorFrameId("resume")): Promise<MirrorDelivery> {
    return this.sendTransient({ v: 2, id, type: "audio_resume" });
  }

  /** Abandon the current and queued utterances — a real interruption. */
  async stopAudio(reason?: string, id = mirrorFrameId("stopaudio")): Promise<MirrorDelivery> {
    return this.sendTransient({
      v: 2,
      id,
      type: "audio_stop",
      ...(reason ? { reason: reason.slice(0, 120) } : {}),
    });
  }

  /** Queue a command from an MCP subprocess. */
  queueOverlay(overlay: Parameters<MirrorBridge["setOverlay"]>[0]): string {
    const id = mirrorFrameId("overlay");
    this.store.enqueueCommand({ v: 2, id, type: "overlay_set", overlay });
    return id;
  }

  private url(): string {
    const { host, port } = mirrorConfig(this.config);
    return `ws://${host}:${port}/agent`;
  }

  private protocols(): string[] {
    const token = Buffer.from(mirrorConfig(this.config).token, "utf8").toString("base64url");
    return ["constellation-mirror-v2", `bearer.${token}`];
  }

  private connect(): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url(), this.protocols());
    } catch (err) {
      console.error("[mirror] websocket construct failed", err);
      this.scheduleReconnect(generation);
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => {
      if (generation !== this.generation || this.ws !== ws) {
        ws.close();
        return;
      }
      this.reconnectMs = RECONNECT_MIN_MS;
      this.lastInboundAt = Date.now();
      this.synced = false;
      console.log(
        `[mirror] connected to ${mirrorConfig(this.config).host}:${mirrorConfig(this.config).port}`,
      );
      void this.pushSnapshot();
    });
    ws.addEventListener("close", () => {
      if (generation !== this.generation) return;
      if (this.ws === ws) this.ws = null;
      this.handlers.onScreenStatus?.(false);
      this.synced = false;
      this.snapshotId = null;
      this.inflightOutbox.clear();
      this.rejectPending("mirror disconnected");
      this.scheduleReconnect(generation);
    });
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        // close path performs cleanup
      }
    });
    ws.addEventListener("message", (event) => {
      if (generation !== this.generation || this.ws !== ws) return;
      this.lastInboundAt = Date.now();
      this.handleRaw(event.data);
    });
  }

  private scheduleReconnect(generation: number): void {
    if (this.stopped || generation !== this.generation || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectMs);
    this.reconnectTimer.unref?.();
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
  }

  private handleRaw(raw: unknown): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      console.warn("[mirror] ignored malformed Pi event");
      return;
    }
    const parsed = PiEventSchema.safeParse(decoded);
    if (!parsed.success) {
      console.warn(
        `[mirror] ignored invalid Pi event: ${parsed.error.issues[0]?.message ?? "schema"}`,
      );
      return;
    }
    this.handle(parsed.data);
  }

  private handle(event: PiEvent): void {
    switch (event.type) {
      case "hello":
        this.checkContract(event.contract);
        if (!this.synced && !this.snapshotId) void this.pushSnapshot();
        break;
      case "ack": {
        if (event.replyTo === this.snapshotId) {
          this.snapshotId = null;
          if (event.status === "rejected") {
            console.warn(`[mirror] snapshot rejected: ${event.error ?? "unknown"}`);
            this.synced = false;
            setTimeout(() => void this.pushSnapshot(), OUTBOX_RETRY_MS).unref?.();
          } else {
            this.synced = true;
          }
        }
        this.inflightOutbox.delete(event.replyTo);
        if (event.status !== "rejected") this.store.acknowledgeOutbox(event.replyTo);
        const pending = this.pendingAcks.get(event.replyTo);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingAcks.delete(event.replyTo);
          pending.resolve(
            event.status === "rejected"
              ? { delivered: false, error: event.error ?? "mirror rejected message" }
              : { delivered: true },
          );
        }
        if (event.status === "rejected" && event.error === "revision_gap") {
          this.synced = false;
          void this.pushSnapshot();
        }
        break;
      }
      case "wake":
        this.handlers.onWake?.({ score: event.score, label: event.label });
        break;
      case "utterance":
        void this.handlers.onUtterance?.(event.data, event.id);
        break;
      case "audio_done":
        this.handlers.onAudioDone?.(event.status === "error", event.replyTo, event.error);
        break;
      case "wake_timeout":
      case "followup_timeout":
        this.handlers.onListenTimeout?.();
        break;
      case "screen_status":
        this.handlers.onScreenStatus?.(event.connected);
        break;
      case "pong":
        break;
    }
  }

  /**
   * Warn when the screen validates a different vocabulary than we speak.
   *
   * The two sides keep separate schemas in separate repositories, and the
   * screen's strips unknown keys rather than rejecting them -- so a field we
   * added and it never learned about is accepted, dropped, and never drawn.
   * Nothing errors; the feature just does nothing. The digests are generated
   * from the schemas, so comparing them here names that situation the moment a
   * screen attaches instead of leaving it to be discovered on the glass.
   *
   * Deliberately a warning and not a disconnect: a mismatch means some frames
   * may be ignored, which is far better than a dark mirror, and an older screen
   * that sends no digest at all must keep working.
   */
  private checkContract(reported: string | undefined): void {
    if (!reported) {
      console.warn("[mirror] screen reports no contract digest; cannot verify wire compatibility");
      return;
    }
    const ours = contractDigest();
    if (reported === ours) return;
    console.warn(
      `[mirror] CONTRACT MISMATCH: screen speaks ${reported}, agent speaks ${ours}. Frames using newer fields will be silently dropped. Re-run \`bun integrations/mirror/scripts/emit-mirror-contract.ts --to <screen>/src/mirror\` and redeploy.`,
    );
  }

  private async pushSnapshot(): Promise<void> {
    if (!this.connected || this.snapshotId) return;
    const snapshot = this.store.snapshot();
    const frame: AgentFrame = {
      v: 2,
      id: mirrorFrameId("snapshot"),
      type: "snapshot",
      revision: snapshot.revision,
      page: snapshot.page,
      rotation: snapshot.rotation,
      contents: snapshot.contents,
    };
    this.snapshotId = frame.id;
    const delivery = await this.sendTransient(frame);
    if (!delivery.delivered && this.snapshotId === frame.id) {
      this.snapshotId = null;
      this.synced = false;
    }
  }

  private async drainOutbox(): Promise<void> {
    if (!this.connected || !this.synced || this.inflightOutbox.size >= MAX_INFLIGHT) return;
    const available = MAX_INFLIGHT - this.inflightOutbox.size;
    const rows = this.store.listReadyOutbox(Date.now(), OUTBOX_RETRY_MS, available);
    for (const row of rows) {
      if (this.inflightOutbox.has(row.messageId)) continue;
      if (await this.handleLocalRow(row)) continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(row.payload);
      } catch {
        console.warn(`[mirror] dropping corrupt outbox row ${row.messageId}`);
        this.store.acknowledgeOutbox(row.messageId);
        continue;
      }
      const parsed = AgentFrameSchema.safeParse(decoded);
      if (!parsed.success) {
        console.warn(`[mirror] dropping invalid outbox row ${row.messageId}`);
        this.store.acknowledgeOutbox(row.messageId);
        continue;
      }
      this.inflightOutbox.add(row.messageId);
      this.store.noteOutboxAttempt(row.messageId);
      void this.sendTransient(parsed.data).then((delivery) => {
        this.inflightOutbox.delete(row.messageId);
        if (delivery.delivered) this.store.acknowledgeOutbox(row.messageId);
      });
    }
  }

  private async handleLocalRow(row: MirrorOutboxRow): Promise<boolean> {
    let decoded: { type?: unknown; text?: unknown; id?: unknown };
    try {
      decoded = JSON.parse(row.payload);
    } catch {
      return false;
    }
    if (decoded.type !== "local_speak" && decoded.type !== "local_close") return false;
    if (typeof decoded.id !== "string") {
      this.store.acknowledgeOutbox(row.messageId);
      return true;
    }
    if (decoded.type === "local_close") {
      this.handlers.onCloseConversation?.(decoded.id);
      this.store.acknowledgeOutbox(row.messageId);
      return true;
    }
    if (typeof decoded.text !== "string") {
      this.store.acknowledgeOutbox(row.messageId);
      return true;
    }
    if (this.inflightOutbox.has(row.messageId)) return true;
    this.inflightOutbox.add(row.messageId);
    this.store.noteOutboxAttempt(row.messageId);
    try {
      const delivery = await this.handlers.onSpeakText?.(decoded.text, decoded.id);
      if (delivery?.delivered || delivery?.suppressed) {
        this.store.acknowledgeOutbox(row.messageId);
      }
    } finally {
      this.inflightOutbox.delete(row.messageId);
    }
    return true;
  }

  private sendTransient(frame: AgentFrame): Promise<MirrorDelivery> {
    const parsed = AgentFrameSchema.safeParse(frame);
    if (!parsed.success) {
      return Promise.resolve({
        delivered: false,
        error: parsed.error.issues[0]?.message ?? "invalid mirror frame",
      });
    }
    if (!this.connected) {
      return Promise.resolve({ delivered: false, error: "mirror is offline" });
    }
    return new Promise((resolve) => {
      const prior = this.pendingAcks.get(parsed.data.id);
      if (prior) {
        clearTimeout(prior.timer);
        prior.resolve({
          delivered: false,
          error: "mirror message id reused before acknowledgement",
        });
      }
      const timer = setTimeout(() => {
        this.pendingAcks.delete(parsed.data.id);
        resolve({ delivered: false, error: "mirror acknowledgement timed out" });
      }, ACK_TIMEOUT_MS);
      timer.unref?.();
      this.pendingAcks.set(parsed.data.id, { timer, resolve });
      try {
        this.ws!.send(JSON.stringify(parsed.data));
      } catch (err) {
        clearTimeout(timer);
        this.pendingAcks.delete(parsed.data.id);
        resolve({ delivered: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  private async heartbeat(): Promise<void> {
    if (!this.connected) return;
    if (Date.now() - this.lastInboundAt > LIVENESS_TIMEOUT_MS) {
      console.warn("[mirror] liveness timeout; reconnecting");
      this.ws?.close();
      return;
    }
    await this.sendTransient({
      v: 2,
      id: mirrorFrameId("ping"),
      type: "ping",
      at: Date.now(),
    });
  }

  private rejectPending(error: string): void {
    for (const pending of this.pendingAcks.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ delivered: false, error });
    }
    this.pendingAcks.clear();
  }
}
