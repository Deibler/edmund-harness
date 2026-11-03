/**
 * The voice lab's web server: the page, its WebSocket, and the voice
 * settings, on the local network.
 *
 * Whoever holds this page talks to Edmund as the operator, so it is locked
 * three ways: a secret key (opened once as ?key=..., then kept as an
 * HttpOnly cookie), private network addresses only, and same-origin requests
 * only. HTTPS with a self-signed certificate, because a browser gives a page
 * its microphone only in a secure context; the browser warns once.
 */

import { execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server, ServerWebSocket } from "bun";
import { log } from "../../../util/log.ts";
import { type VoiceSettingsStore, validVoiceSettings, voiceNames } from "../../voice-settings.ts";
import type { LabLink, PageMessage, WebProvider } from "./provider.ts";

const COOKIE = "edmund_lab";
const PAGE = resolve(dirname(fileURLToPath(import.meta.url)), "page.html");
/** Longest preview text: a sentence or two. */
const MAX_PREVIEW_CHARS = 400;

export type LabServerOptions = {
  port: number;
  hostname: string;
  /** Holds the key and the certificate. */
  dir: string;
  provider: WebProvider;
  settings: VoiceSettingsStore;
  voices: () => Promise<string[] | null>;
  synthesize: (
    text: string,
    voice: string,
    speed: number,
  ) => Promise<{ pcm: Uint8Array; sampleRate: number } | null>;
  /** Plain HTTP, for tests on loopback only. */
  insecure?: boolean;
};

/** Loopback, RFC 1918, link-local and unique-local addresses, v4 or v6. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^::ffff:/, "");
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  return ip === "::1" || /^fe[89ab][0-9a-f]:/.test(ip) || /^f[cd][0-9a-f]{2}:/.test(ip);
}

/** The lab's key, made once and kept. */
export function labKey(dir: string): string {
  const path = join(dir, "key");
  if (existsSync(path)) {
    const key = readFileSync(path, "utf8").trim();
    if (key.length >= 32) return key;
  }
  mkdirSync(dir, { recursive: true });
  const key = randomBytes(24).toString("hex");
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

/** This Mac's addresses on the local network: only those the lab admits (not a VPN's 100.64/10). */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal && isPrivateAddress(i.address))
    .map((i) => i!.address);
}

/** A self-signed certificate for this Mac's name and addresses, made once. */
function certificate(dir: string): { cert: string; key: string } {
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    mkdirSync(dir, { recursive: true });
    const host = hostname().replace(/\.local$/, "");
    const names = [`DNS:${host}.local`, "DNS:localhost", "IP:127.0.0.1"];
    for (const ip of lanAddresses()) names.push(`IP:${ip}`);
    execFileSync(
      "/usr/bin/openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        "825",
        "-subj",
        "/CN=Edmund voice lab",
        "-addext",
        `subjectAltName=${names.join(",")}`,
        "-keyout",
        keyPath,
        "-out",
        certPath,
      ],
      { stdio: "ignore" },
    );
    chmodSync(keyPath, 0o600);
  }
  return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieValue(req: Request): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return null;
}

/** 24 kHz mono 16-bit PCM as a WAV file. */
function wav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

type SocketData = { link: LabLink | null };
type Socket = ServerWebSocket<SocketData>;

export class LabServer {
  private readonly options: LabServerOptions;
  private readonly key: string;
  private server: Server<SocketData> | null = null;

  constructor(options: LabServerOptions) {
    this.options = options;
    this.key = labKey(options.dir);
  }

  /** Where to open it from another computer, key included. */
  urls(): string[] {
    const scheme = this.options.insecure ? "http" : "https";
    const port = this.server?.port ?? this.options.port;
    const host = hostname().replace(/\.local$/, "");
    return [`${host}.local`, ...lanAddresses()].map(
      (h) => `${scheme}://${h}:${port}/?key=${this.key}`,
    );
  }

  port(): number | null {
    return this.server?.port ?? null;
  }

  start(): void {
    const { provider } = this.options;
    this.server = Bun.serve<SocketData>({
      port: this.options.port,
      hostname: this.options.hostname,
      ...(this.options.insecure ? {} : { tls: certificate(this.options.dir) }),
      fetch: (req, server) => this.handle(req, server),
      websocket: {
        // Mic audio is 640 bytes every 20 ms; anything far bigger is not ours.
        maxPayloadLength: 1 << 20,
        open: (ws: Socket) => {
          const link: LabLink = {
            send: (message) => ws.send(JSON.stringify(message)),
            sendAudio: (pcm) => ws.send(pcm),
            close: () => ws.close(4000, "replaced"),
          };
          ws.data.link = link;
          provider.attach(link);
        },
        message: (ws: Socket, data) => {
          const link = ws.data.link;
          if (!link) return;
          if (typeof data !== "string") {
            const bytes = data.byteLength - (data.byteLength % 2);
            const samples = new Int16Array(bytes / 2);
            new Uint8Array(samples.buffer).set(new Uint8Array(data.buffer, data.byteOffset, bytes));
            provider.audio(link, samples);
            return;
          }
          let message: PageMessage;
          try {
            message = JSON.parse(data);
          } catch {
            return;
          }
          if (
            message &&
            (message.type === "call" ||
              message.type === "hangup" ||
              message.type === "ready" ||
              (message.type === "played" && typeof message.id === "string"))
          )
            provider.message(link, message);
        },
        close: (ws: Socket) => {
          if (ws.data.link) provider.detach(ws.data.link);
          ws.data.link = null;
        },
      },
    });
    log.info("voice-lab", "listening", {
      urls: this.urls().map((u) => u.replace(/key=.*/, "key=…")),
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  private async handle(req: Request, server: Server<SocketData>): Promise<Response | undefined> {
    const remote = server.requestIP(req)?.address ?? "";
    if (!isPrivateAddress(remote)) return new Response("not on this network", { status: 403 });
    const url = new URL(req.url);

    // The key in the link becomes a cookie, and leaves the address bar.
    const offered = url.searchParams.get("key");
    if (offered !== null && url.pathname === "/") {
      if (!same(offered, this.key)) return new Response("wrong key", { status: 403 });
      const secure = this.options.insecure ? "" : " Secure;";
      return new Response(null, {
        status: 303,
        headers: {
          location: "/",
          "set-cookie": `${COOKIE}=${this.key}; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=31536000`,
        },
      });
    }
    const cookie = cookieValue(req);
    if (!cookie || !same(cookie, this.key))
      return new Response("Open the voice lab with the link that has its key.", { status: 401 });
    // Same origin only: a page elsewhere cannot drive the lab with this cookie.
    const origin = req.headers.get("origin");
    if (origin && new URL(origin).host !== url.host)
      return new Response("cross-origin", { status: 403 });

    if (url.pathname === "/ws") {
      return server.upgrade(req, { data: { link: null } })
        ? undefined
        : new Response("expected a WebSocket", { status: 400 });
    }
    if (url.pathname === "/" && req.method === "GET") {
      return new Response(Bun.file(PAGE), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/api/voices" && req.method === "GET") {
      return Response.json({
        voices: (await this.options.voices()) ?? [],
        current: this.options.settings.get(),
      });
    }
    if (url.pathname === "/api/voice" && req.method === "PUT") {
      const parsed = validVoiceSettings(await req.json().catch(() => null));
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
      const known = await this.options.voices();
      const unknown = voiceNames(parsed.settings.voice).filter((v) => known && !known.includes(v));
      if (unknown.length > 0)
        return Response.json({ error: `no such voice: ${unknown.join(", ")}` }, { status: 400 });
      this.options.settings.set(parsed.settings);
      log.info("voice-lab", "voice saved", parsed.settings);
      return Response.json({ current: parsed.settings });
    }
    if (url.pathname === "/api/preview" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
      const parsed = validVoiceSettings(body);
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
      const text =
        typeof body?.text === "string" ? body.text.trim().slice(0, MAX_PREVIEW_CHARS) : "";
      if (!text) return Response.json({ error: "nothing to say" }, { status: 400 });
      const audio = await this.options.synthesize(
        text,
        parsed.settings.voice,
        parsed.settings.speed,
      );
      if (!audio) return Response.json({ error: "the voice could not say that" }, { status: 502 });
      return new Response(wav(audio.pcm, audio.sampleRate), {
        headers: { "content-type": "audio/wav", "cache-control": "no-store" },
      });
    }
    return new Response("not found", { status: 404 });
  }
}
