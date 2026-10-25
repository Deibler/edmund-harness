import { type TLSSocket, connect } from "node:tls";

/**
 * The smallest MQTT 3.1.1 client the printer needs: connect with a username
 * and password over TLS, subscribe at QoS 0, publish at QoS 0 or 1, keep
 * alive. A Bambu printer in LAN mode runs its own broker on 8883 with a
 * self-signed certificate whose CN is the printer's serial, so certificate
 * checks are replaced by pinning that CN.
 */

export function encodeLength(length: number): Buffer {
  const out: number[] = [];
  let n = length;
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
}

function str(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

function packet(type: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([type]), encodeLength(body.length), body]);
}

export function connectPacket(
  clientId: string,
  username: string,
  password: string,
  keepAliveS = 60,
): Buffer {
  const header = Buffer.concat([
    str("MQTT"),
    Buffer.from([4, 0xc2]),
    Buffer.from([keepAliveS >> 8, keepAliveS & 0xff]),
  ]);
  return packet(0x10, Buffer.concat([header, str(clientId), str(username), str(password)]));
}

export function subscribePacket(id: number, topic: string): Buffer {
  return packet(
    0x82,
    Buffer.concat([Buffer.from([id >> 8, id & 0xff]), str(topic), Buffer.from([0])]),
  );
}

/** QoS 0 publish, or QoS 1 when a packet id is given (the printer acks it). */
export function publishPacket(topic: string, payload: string, packetId?: number): Buffer {
  if (packetId === undefined) {
    return packet(0x30, Buffer.concat([str(topic), Buffer.from(payload, "utf8")]));
  }
  return packet(
    0x32,
    Buffer.concat([
      str(topic),
      Buffer.from([packetId >> 8, packetId & 0xff]),
      Buffer.from(payload, "utf8"),
    ]),
  );
}

/** Split a byte stream into complete MQTT packets; returns the leftover. */
export function readPackets(buf: Buffer): {
  packets: Array<{ type: number; flags: number; body: Buffer }>;
  rest: Buffer;
} {
  const packets: Array<{ type: number; flags: number; body: Buffer }> = [];
  let i = 0;
  while (i < buf.length) {
    let mult = 1;
    let len = 0;
    let j = i + 1;
    let complete = false;
    while (j < buf.length) {
      const b = buf[j]!;
      len += (b & 0x7f) * mult;
      mult *= 128;
      j++;
      if ((b & 0x80) === 0) {
        complete = true;
        break;
      }
    }
    if (!complete || j + len > buf.length) break;
    packets.push({ type: buf[i]! & 0xf0, flags: buf[i]! & 0x0f, body: buf.subarray(j, j + len) });
    i = j + len;
  }
  return { packets, rest: buf.subarray(i) };
}

/** Topic and payload of a PUBLISH body; QoS 1/2 bodies carry a packet id after the topic. */
export function parsePublish(body: Buffer, flags = 0): { topic: string; payload: string } {
  const tlen = body.readUInt16BE(0);
  const qos = (flags >> 1) & 0x03;
  const start = 2 + tlen + (qos > 0 ? 2 : 0);
  return {
    topic: body.subarray(2, 2 + tlen).toString("utf8"),
    payload: body.subarray(start).toString("utf8"),
  };
}

export type MqttSession = {
  /** QoS 0: fire and forget. */
  publish(topic: string, payload: string): void;
  /** QoS 1: resolves when the broker acknowledges, rejects after a timeout. */
  publishAcked(topic: string, payload: string, timeoutMs?: number): Promise<void>;
  close(): void;
};

/**
 * Connect, subscribe to `topic`, and call `onMessage` for each publish until
 * `close()`. Resolves once the broker has accepted the connection. `onClose`
 * runs once if the connection drops after it was established.
 */
export function openMqtt(opts: {
  host: string;
  port?: number;
  username: string;
  password: string;
  expectCn?: string;
  topic: string;
  onMessage: (topic: string, payload: string) => void;
  onClose?: (why: string) => void;
  timeoutMs?: number;
}): Promise<MqttSession> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let closedByUs = false;
    // Assigned once below; declared first so the failure path can reach it.
    const holder: { socket?: TLSSocket } = {};
    const acks = new Map<number, () => void>();
    let nextId = 1;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      holder.socket?.destroy();
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new Error("printer did not answer (MQTT timeout)")),
      opts.timeoutMs ?? 10_000,
    );
    const socket = connect(
      { host: opts.host, port: opts.port ?? 8883, rejectUnauthorized: false },
      () => {
        const cn = socket.getPeerCertificate()?.subject?.CN;
        if (opts.expectCn && cn !== opts.expectCn) {
          fail(
            new Error(
              `unexpected printer certificate (${cn ?? "none"}), expected ${opts.expectCn}`,
            ),
          );
          return;
        }
        socket.write(
          connectPacket(
            `edmund-${process.pid}-${Date.now() % 100000}`,
            opts.username,
            opts.password,
          ),
        );
      },
    );
    holder.socket = socket;
    let buf = Buffer.alloc(0);
    let ping: ReturnType<typeof setInterval> | null = null;
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const { packets, rest } = readPackets(buf);
      buf = Buffer.from(rest);
      for (const p of packets) {
        if (p.type === 0x20) {
          const code = p.body[1];
          if (code !== 0) {
            fail(
              new Error(
                code === 4 || code === 5
                  ? "printer refused the access code"
                  : `printer refused the connection (${code})`,
              ),
            );
            return;
          }
          socket.write(subscribePacket(1, opts.topic));
          ping = setInterval(() => socket.write(Buffer.from([0xc0, 0])), 30_000);
          clearTimeout(timer);
          settled = true;
          resolve({
            publish: (topic, payload) => socket.write(publishPacket(topic, payload)),
            publishAcked: (topic, payload, timeoutMs = 10_000) =>
              new Promise<void>((ok, no) => {
                const id = nextId;
                nextId = nextId >= 0xffff ? 1 : nextId + 1;
                const t = setTimeout(() => {
                  acks.delete(id);
                  no(new Error("printer did not acknowledge the command"));
                }, timeoutMs);
                acks.set(id, () => {
                  clearTimeout(t);
                  ok();
                });
                socket.write(publishPacket(topic, payload, id));
              }),
            close: () => {
              closedByUs = true;
              if (ping) clearInterval(ping);
              socket.end(Buffer.from([0xe0, 0]));
              socket.destroy();
            },
          });
        } else if (p.type === 0x30) {
          const m = parsePublish(p.body, p.flags);
          opts.onMessage(m.topic, m.payload);
        } else if (p.type === 0x40 && p.body.length >= 2) {
          const id = p.body.readUInt16BE(0);
          acks.get(id)?.();
          acks.delete(id);
        }
      }
    });
    socket.on("error", (err) => fail(err));
    socket.on("close", () => {
      if (ping) clearInterval(ping);
      if (!settled) fail(new Error("printer closed the connection"));
      else if (!closedByUs) opts.onClose?.("connection closed");
    });
  });
}
