/**
 * The voice lab: a call with Edmund from a web page, under the same manager,
 * conversation, model, voice and turn-taking as a FaceTime call. Only the
 * ends differ: the caller's microphone arrives over a WebSocket instead of
 * FaceTime's audio tap, and Edmund's voice goes back the same way instead of
 * into the virtual mic.
 *
 * Hearing is the Ear (calls/ear.ts) fed with the page's audio, so what is
 * tuned here is what a call runs. The page is the operator's, authenticated
 * by the lab server; a lab call is always from the operator.
 */

import { genId } from "../../../util/ids.ts";
import { log } from "../../../util/log.ts";
import { Ear, type EarDeps } from "../../ear.ts";
import type { CallProvider, Peer, ProviderCall, ProviderEvent } from "../../types.ts";

export const LAB_PROVIDER = "voice lab";

/** One connected page: JSON control messages and binary audio. */
export interface LabLink {
  send(message: Record<string, unknown>): void;
  sendAudio(pcm: Uint8Array): void;
  close(): void;
}

/** What the page sends. */
export type PageMessage =
  | { type: "call" }
  | { type: "hangup" }
  /** Its speaker is playing and its microphone is open. */
  | { type: "ready" }
  /** A chunk of Edmund's speech finished playing. */
  | { type: "played"; id: string };

export type WebProviderOptions = {
  /** Who a lab caller is: the operator. Null when no operator is configured. */
  peer: () => Peer | null;
  transcribe: EarDeps["transcribe"];
  turnVerdict: EarDeps["turnVerdict"];
  /** Why a call cannot start now (Edmund is on another call), or null. */
  busy: () => string | null;
  /** How long a call rings before the page is told Edmund did not pick up. */
  ringTimeoutMs?: number;
  /** How long after pick-up the page has to say its audio is running. */
  readyTimeoutMs?: number;
};

type LabCall = {
  id: string;
  state: "ringing" | "active";
  peer: Peer;
  ringTimer: ReturnType<typeof setTimeout> | null;
  ready: Promise<{ ok: true } | { ok: false; detail: string }>;
  markReady: () => void;
};

export class WebProvider implements CallProvider {
  readonly name = LAB_PROVIDER;
  private readonly options: WebProviderOptions;
  private readonly ear: Ear;
  private onEvent: (event: ProviderEvent) => void = () => {};
  private link: LabLink | null = null;
  private call: LabCall | null = null;
  /** Chunks sent to the page and not yet reported played or dropped. */
  private readonly unplayed = new Set<string>();

  constructor(options: WebProviderOptions) {
    this.options = options;
    this.ear = new Ear({
      transcribe: options.transcribe,
      turnVerdict: options.turnVerdict,
      emit: (event) => {
        this.onEvent(event);
        // The page shows what the ear made of the caller, as it happens.
        this.link?.send({ type: "ear", event });
      },
    });
  }

  // ── The page ──────────────────────────────────────────────────────────

  /** A page connected. One at a time: a newer page takes over. */
  attach(link: LabLink): void {
    if (this.link && this.link !== link) {
      this.link.send({ type: "state", state: "ended", reason: "opened in another tab" });
      this.endCall("the page was replaced");
      this.link.close();
    }
    this.link = link;
    link.send({ type: "state", state: "idle" });
  }

  detach(link: LabLink): void {
    if (this.link !== link) return;
    this.link = null;
    this.endCall("the page closed");
  }

  message(link: LabLink, message: PageMessage): void {
    if (this.link !== link) return;
    switch (message.type) {
      case "call":
        this.ring(link);
        break;
      case "hangup":
        this.endCall("they hung up");
        break;
      case "ready":
        this.call?.markReady();
        break;
      case "played":
        if (this.unplayed.delete(message.id))
          this.onEvent({ type: "spoken", chunkId: message.id, played: true });
        break;
    }
  }

  /** The caller's microphone, 16 kHz mono 16-bit. */
  audio(link: LabLink, samples: Int16Array): void {
    if (this.link === link && this.call?.state === "active") this.ear.feed(samples);
  }

  private ring(link: LabLink): void {
    if (this.call) return;
    const peer = this.options.peer();
    if (!peer) {
      link.send({ type: "state", state: "ended", reason: "no operator handle is configured" });
      return;
    }
    const busy = this.options.busy();
    if (busy) {
      link.send({ type: "state", state: "ended", reason: busy });
      return;
    }
    let markReady = () => {};
    const readyTimeoutMs = this.options.readyTimeoutMs ?? 10_000;
    const ready = new Promise<{ ok: true } | { ok: false; detail: string }>((resolve) => {
      markReady = () => resolve({ ok: true });
      setTimeout(
        () =>
          resolve({ ok: false, detail: `the page's audio did not start in ${readyTimeoutMs} ms` }),
        readyTimeoutMs,
      ).unref?.();
    });
    const call: LabCall = {
      id: genId("lab"),
      state: "ringing",
      peer,
      ringTimer: null,
      ready,
      markReady,
    };
    // Turned away (not on the allow list) or never ready: the page is told
    // rather than left ringing.
    call.ringTimer = setTimeout(() => {
      if (this.call !== call || call.state !== "ringing") return;
      this.link?.send({ type: "state", state: "ended", reason: "Edmund did not pick up" });
      this.endCall("not answered");
    }, this.options.ringTimeoutMs ?? 30_000);
    this.call = call;
    link.send({ type: "state", state: "ringing", callId: call.id });
    this.report(call, "ringing");
  }

  /** The call is over from the page's side (or the page went away). */
  private endCall(reason: string): void {
    const call = this.call;
    if (!call) return;
    this.call = null;
    if (call.ringTimer) clearTimeout(call.ringTimer);
    this.ear.end();
    this.dropUnplayed();
    log.info("voice-lab", "call ended from the page", { reason });
    this.report(call, "ended");
  }

  private report(call: LabCall, state: ProviderCall["state"]): void {
    this.onEvent({
      type: "call",
      call: { id: call.id, direction: "incoming", state, peer: call.peer },
    });
  }

  private dropUnplayed(): void {
    for (const id of this.unplayed) this.onEvent({ type: "spoken", chunkId: id, played: false });
    this.unplayed.clear();
  }

  // ── CallProvider ──────────────────────────────────────────────────────

  async start(onEvent: (event: ProviderEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    this.onEvent({ type: "readiness", ready: true, detail: "voice lab page calls" });
  }

  async stop(): Promise<void> {
    this.link?.send({ type: "state", state: "ended", reason: "Edmund shut down" });
    this.endCall("Edmund shut down");
    this.link?.close();
    this.link = null;
  }

  async dial(): Promise<ProviderCall> {
    throw new Error("the voice lab takes calls; it does not place them");
  }

  async answer(callId: string): Promise<void> {
    const call = this.call;
    if (!call || call.id !== callId) throw new Error("that lab call is gone");
    if (call.ringTimer) clearTimeout(call.ringTimer);
    call.ringTimer = null;
    call.state = "active";
    this.link?.send({ type: "state", state: "active", callId });
    this.report(call, "active");
  }

  async hangup(callId: string): Promise<void> {
    const call = this.call;
    if (!call || call.id !== callId) return;
    this.link?.send({ type: "state", state: "ended", reason: "Edmund hung up" });
    this.endCall("Edmund hung up");
  }

  /** The page opens its microphone before it rings, so a ringing page can be heard. */
  async canHear(): Promise<{ ok: true } | { ok: false; detail: string }> {
    return this.link ? { ok: true } : { ok: false, detail: "no lab page is open" };
  }

  async listen(): Promise<void> {
    this.ear.begin();
  }

  audioReady(): Promise<{ ok: true } | { ok: false; detail: string }> {
    return this.call?.ready ?? Promise.resolve({ ok: false, detail: "no lab call" });
  }

  async stopListening(): Promise<void> {
    this.ear.end();
  }

  async say(chunkId: string, pcm: Uint8Array, sampleRate: number): Promise<void> {
    const link = this.link;
    if (!link || this.call?.state !== "active") throw new Error("no lab page is on the call");
    this.unplayed.add(chunkId);
    link.send({ type: "chunk", id: chunkId, sampleRate });
    link.sendAudio(pcm);
  }

  async flush(): Promise<void> {
    this.dropUnplayed();
    this.link?.send({ type: "flush" });
  }

  /** Something for the page only: an exchange's timings, a line of the transcript. */
  tell(message: Record<string, unknown>): void {
    this.link?.send(message);
  }
}
