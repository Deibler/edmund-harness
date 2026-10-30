/**
 * The daemon's end of the native helpers' socket: newline-delimited JSON,
 * requests with ids and replies, plus unsolicited events.
 *
 * The daemon listens and the helpers dial in (and keep redialling), so either
 * side can restart without the other. One helper connection at a time: a new
 * one replaces the old, which is what a relaunched helper looks like.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { dirname } from "node:path";

export type JsonMessage = Record<string, unknown>;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class JsonLinesServer {
  private server: Server | null = null;
  private socket: Socket | null = null;
  private buffer = "";
  private sequence = 0;
  private readonly pending = new Map<string, Pending>();

  constructor(
    readonly path: string,
    private readonly name: string,
    private readonly onMessage: (message: JsonMessage) => void,
  ) {}

  listen(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    if (existsSync(this.path)) rmSync(this.path);
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.adopt(socket));
      server.once("error", reject);
      server.listen(this.path, () => resolve());
      this.server = server;
    });
  }

  connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  request(method: string, params: JsonMessage = {}, timeoutMs = 10_000): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error(`${this.name} is not connected`));
    }
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
    this.server?.close();
    this.server = null;
    this.failPending(`${this.name} closed`);
    if (existsSync(this.path)) rmSync(this.path);
  }

  private adopt(socket: Socket): void {
    this.socket?.destroy();
    this.failPending(`${this.name} reconnected`);
    this.socket = socket;
    this.buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.read(chunk));
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
        this.failPending(`${this.name} disconnected`);
      }
    });
    socket.on("error", () => socket.destroy());
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    for (let i = this.buffer.indexOf("\n"); i >= 0; i = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      let message: JsonMessage;
      try {
        message = JSON.parse(line) as JsonMessage;
      } catch {
        continue;
      }
      const id = typeof message.id === "string" ? message.id : null;
      const waiting = id ? this.pending.get(id) : undefined;
      if (waiting && id) {
        this.pending.delete(id);
        clearTimeout(waiting.timer);
        if (message.ok === true) waiting.resolve(message.result);
        else waiting.reject(new Error(String(message.error ?? "request failed")));
      } else {
        this.onMessage(message);
      }
    }
  }

  private failPending(reason: string): void {
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
