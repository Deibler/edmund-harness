import { createHash } from "node:crypto";
import { type TLSSocket, connect } from "node:tls";

/**
 * The printer's file service on TLS port 6000: what Bambu Studio's Device ->
 * Files tab and Send to Printer use. On the P2S it lists and serves the
 * timelapse videos and the model cache in internal storage, and takes
 * uploads into that cache, all without Developer Mode.
 *
 * Wire format, verified against this printer (2026-10-25) and documented by
 * the open-bamboo-networking project: every frame is a 16-byte little-endian
 * header (payload length, magic, frame sequence, 0) and a payload. Login is
 * subchannel 1 (`bblp` and the access code, 8 bytes each); everything after
 * is subchannel 2: a setup message, then JSON requests whose replies carry
 * the same `sequence`, with any binary after the JSON and a blank line.
 */

const MAGIC_LOGIN = 0x0101013f;
const MAGIC_CTRL = 0x0102013f;
const MTYPE_CTRL = 12289;
const MTYPE_SETUP = 12291;

export const RESULT = { OK: 0, CONTINUE: 1, FILE_EXISTS: 19, STORAGE_UNAVAILABLE: 17 } as const;

export type CtrlFile = {
  name: string;
  path: string;
  size: number;
  /** Unix seconds. */
  time: number;
  modelName: string;
  durationMs: number;
};

export type CtrlReply = { json: Record<string, unknown>; binary: Buffer };

export function frameHeader(payloadLen: number, magic: number, seq: number): Buffer {
  const h = Buffer.alloc(16);
  h.writeUInt32LE(payloadLen >>> 0, 0);
  h.writeUInt32LE(magic >>> 0, 4);
  h.writeUInt32LE(seq >>> 0, 8);
  return h;
}

/** Where a payload's leading JSON object ends, respecting strings; null if it has none. */
export function jsonPrefixEnd(data: Buffer): number | null {
  if (data[0] !== 0x7b) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < data.length; i++) {
    const b = data[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (b === 0x5c) esc = true;
      else if (b === 0x22) inStr = false;
      continue;
    }
    if (b === 0x22) inStr = true;
    else if (b === 0x7b) depth++;
    else if (b === 0x7d && --depth === 0) return i + 1;
  }
  return null;
}

/** Split a reply payload into its JSON and the binary that follows the blank line. */
export function splitPayload(payload: Buffer): CtrlReply | null {
  const end = jsonPrefixEnd(payload);
  if (end === null) return null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(payload.subarray(0, end).toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  let i = end;
  if (payload[i] === 0x0a && payload[i + 1] === 0x0a) i += 2;
  else if (payload.subarray(i, i + 4).toString("latin1") === "\r\n\r\n") i += 4;
  return { json, binary: payload.subarray(i) };
}

const decodeEntities = (s: string) =>
  s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

export function parseFileList(json: Record<string, unknown>): CtrlFile[] {
  const reply = (json.reply ?? {}) as { file_lists?: unknown };
  const list = Array.isArray(reply.file_lists) ? reply.file_lists : [];
  return list.map((raw) => {
    const f = raw as Record<string, unknown>;
    return {
      name: decodeEntities(String(f.name ?? "")),
      path: String(f.path ?? ""),
      size: Number(f.size ?? 0),
      time: Number(f.time ?? 0),
      modelName: decodeEntities(String(f.model_name ?? "")),
      durationMs: Number(f.duration_ms ?? 0),
    };
  });
}

export class CtrlSession {
  private socket: TLSSocket;
  private buf = Buffer.alloc(0);
  private frames: Buffer[] = [];
  private waiters: Array<() => void> = [];
  private frameSeq = Math.floor(Math.random() * 0x7fffffff);
  private cmdSeq = 1;
  private closed = false;
  private closeReason = "";

  private constructor(socket: TLSSocket) {
    this.socket = socket;
    socket.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      while (this.buf.length >= 16) {
        const len = this.buf.readUInt32LE(0);
        if (this.buf.length < 16 + len) break;
        this.frames.push(Buffer.from(this.buf.subarray(16, 16 + len)));
        this.buf = this.buf.subarray(16 + len);
      }
      this.wake();
    });
    const end = (why: string) => {
      this.closed = true;
      this.closeReason ||= why;
      this.wake();
    };
    socket.on("close", () => end("printer closed the file connection"));
    socket.on("error", (e) => end(e.message));
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  static async open(opts: {
    host: string;
    accessCode: string;
    expectCn?: string;
    timeoutMs?: number;
  }): Promise<CtrlSession> {
    const socket = connect({ host: opts.host, port: 6000, rejectUnauthorized: false });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        socket.destroy();
        reject(new Error("printer file service did not answer"));
      }, opts.timeoutMs ?? 10_000);
      socket.once("secureConnect", () => {
        clearTimeout(t);
        resolve();
      });
      socket.once("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    const cn = socket.getPeerCertificate()?.subject?.CN;
    if (opts.expectCn && cn !== opts.expectCn) {
      socket.destroy();
      throw new Error(`unexpected printer certificate (${cn ?? "none"})`);
    }
    const s = new CtrlSession(socket);
    const login = Buffer.alloc(16);
    login.write("bblp", 0, "ascii");
    login.write(opts.accessCode.slice(0, 8), 8, "ascii");
    s.send(MAGIC_LOGIN, login);
    await s.nextFrame(5_000);
    const pid = (s.frameSeq >>> 0).toString(16).padStart(8, "0");
    s.send(
      MAGIC_CTRL,
      Buffer.from(
        JSON.stringify({
          sequence: 0,
          mtype: MTYPE_SETUP,
          req: { t_av: 1, mtype: MTYPE_CTRL, peer_t: 3, pid, ver: "02.03.00.00" },
        }),
      ),
    );
    const setup = splitPayload(await s.nextFrame(5_000));
    if (!setup || setup.json.result !== 0) {
      s.close();
      throw new Error("printer refused the file session (check the access code)");
    }
    return s;
  }

  private send(magic: number, payload: Buffer) {
    this.socket.write(frameHeader(payload.length, magic, this.frameSeq++));
    if (payload.length) this.socket.write(payload);
  }

  private async nextFrame(timeoutMs: number): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    while (this.frames.length === 0) {
      if (this.closed) throw new Error(this.closeReason || "file connection closed");
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("printer file service timed out");
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
    return this.frames.shift()!;
  }

  /** The next reply for `cmdtype`/`sequence`; stale replies from earlier requests are dropped. */
  private async reply(cmdtype: number, sequence: number, timeoutMs: number): Promise<CtrlReply> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = await this.nextFrame(Math.max(1, deadline - Date.now()));
      const r = splitPayload(frame);
      if (r && r.json.cmdtype === cmdtype && r.json.sequence === sequence) return r;
    }
  }

  private request(cmdtype: number, req: Record<string, unknown>, binary?: Buffer, seq?: number) {
    const sequence = seq ?? this.cmdSeq++;
    const json = Buffer.from(JSON.stringify({ mtype: MTYPE_CTRL, cmdtype, sequence, req }));
    this.send(MAGIC_CTRL, binary ? Buffer.concat([json, Buffer.from("\n\n"), binary]) : json);
    return sequence;
  }

  async list(type: "timelapse" | "model" | "video", storage = "internal"): Promise<CtrlFile[]> {
    const seq = this.request(1, { type, api_version: 2, notify: "DETAIL", storage });
    const r = await this.reply(1, seq, 30_000);
    const result = r.json.result;
    if (result === RESULT.STORAGE_UNAVAILABLE) return [];
    if (result !== RESULT.OK && result !== RESULT.CONTINUE) {
      throw new Error(`printer could not list ${type} files (result ${String(result)})`);
    }
    return parseFileList(r.json);
  }

  /** Download a file by its absolute printer path, checking size and md5 when the printer gives them. */
  async download(path: string, timeoutMs = 300_000): Promise<Buffer> {
    const seq = this.request(4, { path, offset: 0 });
    const parts: Buffer[] = [];
    const md5 = createHash("md5");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.reply(4, seq, Math.max(1, deadline - Date.now()));
      const reply = (r.json.reply ?? {}) as Record<string, unknown>;
      if (r.binary.length && !reply.mem_dl_param_size) {
        parts.push(r.binary);
        md5.update(r.binary);
      }
      if (r.json.result === RESULT.CONTINUE) continue;
      if (r.json.result !== RESULT.OK) {
        throw new Error(`printer could not send ${path} (result ${String(r.json.result)})`);
      }
      const data = Buffer.concat(parts);
      const total = reply.total === undefined ? null : Number(reply.total);
      if (total !== null && data.length !== total) {
        throw new Error(`download of ${path} came back short (${data.length} of ${total} bytes)`);
      }
      const want = String(reply.file_md5 ?? "").toLowerCase();
      if (want && md5.digest("hex") !== want)
        throw new Error(`download of ${path} failed its checksum`);
      return data;
    }
  }

  /**
   * Upload into the printer's model cache. Chunks go back to back with no
   * wait between them: the P2S answers a per-chunk wait with -9203.
   */
  async upload(data: Buffer, remoteName: string, storage = "emmc"): Promise<void> {
    const seq = this.request(5, { type: "model", storage, path: remoteName, total: data.length });
    const init = await this.reply(5, seq, 30_000);
    if (init.json.result !== RESULT.CONTINUE && init.json.result !== RESULT.FILE_EXISTS) {
      throw new Error(`printer refused the upload (result ${String(init.json.result)})`);
    }
    const reply = (init.json.reply ?? {}) as Record<string, unknown>;
    const chunk = Number(reply.chunk_size ?? 0) * 1024;
    if (!chunk) throw new Error("printer did not give an upload chunk size");
    const md5 = createHash("md5").update(data).digest("hex");
    let offset = Number(reply.offset ?? 0);
    for (let frag = 0; offset < data.length; frag++) {
      const end = Math.min(offset + chunk, data.length);
      const req: Record<string, unknown> = { frag_id: frag, offset, size: end - offset };
      if (end >= data.length) req.file_md5 = md5;
      this.request(5, req, data.subarray(offset, end), seq);
      offset = end;
    }
    const done = await this.reply(5, seq, 180_000);
    if (done.json.result !== RESULT.OK && done.json.result !== RESULT.FILE_EXISTS) {
      throw new Error(`upload did not complete (result ${String(done.json.result)})`);
    }
  }

  close() {
    this.closed = true;
    this.socket.destroy();
  }
}
