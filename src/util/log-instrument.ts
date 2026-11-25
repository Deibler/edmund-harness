/**
 * What a process does that no call site logs: the requests it makes, the
 * programs it starts, and the exception that ends it.
 *
 * Each is hooked in one place. The harness makes outbound requests from 39
 * files and starts child processes from about 60, and a log line added at
 * each would be forgotten at the next one written. Measured on Bun 1.4.5
 * (2026-11-25): `node:child_process` runs on `Bun.spawn` and `Bun.spawnSync`,
 * so wrapping those two sees every spawn however it was written, and
 * `tests/log-instrument.test.ts` fails if a later Bun stops routing them there.
 *
 * What these cannot see: requests made by a child process (the model CLI
 * talking to its API, a browser, a script the model wrote). The `model` and
 * `browse` channels cover those from what the model reports it did.
 */
import { basename } from "node:path";
import type { Channel } from "./log-channels.ts";

type Write = (entry: {
  level: "info" | "warn" | "error";
  channel: Channel;
  tag: string;
  msg: string;
  fields?: Record<string, unknown>;
  text: null;
}) => void;

let installed = false;
let quiet = 0;

/**
 * The measuring tools themselves, while they run: `ps` is a child of the
 * daemon at the moment it lists the daemon's children, and would be in every
 * sample of the tree it is taking.
 */
const measuring = new Set<number>();

export function isMeasuringProcess(pid: number): boolean {
  return measuring.has(pid);
}

/** Start child processes without a record each: for the sampler, which runs four a minute. */
export function withoutProcessLog<T>(fn: () => T): T {
  quiet++;
  try {
    return fn();
  } finally {
    quiet--;
  }
}

export function instrumentProcess(write: Write): void {
  if (installed) return;
  installed = true;
  instrumentFetch(write);
  instrumentSpawn(write);
  monitorExit(write);
}

/**
 * A URL path that is safe to keep: no query string, and long opaque segments
 * (share tokens, signed ids, keys in a path) cut to their first six characters.
 */
export function safePath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) =>
      segment.length >= 20 && /\d/.test(segment) && /^[\w.~%-]+$/.test(segment)
        ? `${segment.slice(0, 6)}…`
        : segment,
    )
    .join("/");
}

function describeRequest(
  input: unknown,
  init: { method?: string } | undefined,
): { method: string; host: string; path: string } {
  let url = "";
  let method = init?.method;
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.href;
  else if (input && typeof input === "object") {
    const request = input as { url?: string; method?: string };
    url = request.url ?? "";
    method ??= request.method;
  }
  try {
    const parsed = new URL(url);
    return {
      method: (method ?? "GET").toUpperCase(),
      host: parsed.host || parsed.protocol,
      path: safePath(parsed.pathname),
    };
  } catch {
    return { method: (method ?? "GET").toUpperCase(), host: "?", path: "" };
  }
}

function instrumentFetch(write: Write): void {
  const original = globalThis.fetch;
  const wrapped = function fetch(this: unknown, ...args: unknown[]): Promise<Response> {
    const started = performance.now();
    const target = describeRequest(args[0], args[1] as { method?: string } | undefined);
    const done = (status: number | null, error: unknown, bytes: string | null) => {
      const ms = Math.round(performance.now() - started);
      write({
        level: error !== null || (status !== null && status >= 400) ? "warn" : "info",
        channel: "net-out",
        tag: "net-out",
        msg: `${target.method} ${target.host}${target.path}`,
        fields: {
          method: target.method,
          host: target.host,
          path: target.path,
          ...(status !== null ? { status } : {}),
          ms,
          ...(bytes ? { bytes: Number(bytes) } : {}),
          ...(error !== null ? { err: (error as Error)?.message ?? String(error) } : {}),
        },
        text: null,
      });
    };
    // The caller gets a promise that settles exactly as the original does: a
    // rejection nobody handles is still a rejection nobody handles.
    return (original as (...a: unknown[]) => Promise<Response>).apply(globalThis, args).then(
      (response) => {
        done(response.status, null, response.headers.get("content-length"));
        return response;
      },
      (error) => {
        done(null, error, null);
        throw error;
      },
    );
  };
  try {
    globalThis.fetch = Object.assign(wrapped, original) as typeof fetch;
  } catch {
    // A runtime that will not let fetch be replaced keeps its own.
  }
}

const SECRET_ARG = /(key|token|secret|password|passwd|authorization|bearer|cookie)/i;

/** A command line short enough to log: the program, and its first arguments with anything secret-looking hidden. */
export function describeCommand(argv: readonly unknown[]): { cmd: string; args: string } {
  const words = argv.map((a) => (typeof a === "string" ? a : String(a)));
  const shown: string[] = [];
  for (let i = 1; i < words.length && shown.length < 4; i++) {
    const word = words[i]!;
    const afterSecretFlag =
      i > 1 && words[i - 1]!.startsWith("-") && SECRET_ARG.test(words[i - 1]!);
    if (afterSecretFlag || /^(sk-|Bearer\s)/.test(word) || /=[A-Za-z0-9_\-]{24,}$/.test(word)) {
      shown.push("***");
      continue;
    }
    const flat = word.replace(/\s+/g, " ");
    shown.push(flat.length > 60 ? `${flat.slice(0, 60)}…` : flat);
  }
  const more = words.length - 1 - shown.length;
  return {
    cmd: basename(words[0] ?? "?"),
    args: shown.join(" ") + (more > 0 ? ` (+${more} more)` : ""),
  };
}

function argvOf(args: unknown[]): readonly unknown[] {
  const first = args[0];
  if (Array.isArray(first)) return first;
  if (first && typeof first === "object" && Array.isArray((first as { cmd?: unknown }).cmd)) {
    return (first as { cmd: unknown[] }).cmd;
  }
  return ["?"];
}

/**
 * A child that ended with a non-zero status failed, unless it was asked to
 * stop: the daemon lets the embedder go with SIGTERM every time it has been
 * idle for a minute, and that is not a warning. A kill, a crash or an abort is.
 */
function failed(code: number | null, signal: string | undefined): boolean {
  if (signal === "SIGTERM" || signal === "SIGINT" || signal === "SIGHUP") return false;
  return code !== 0;
}

/** A child still running after this long gets a line of its own, so a hung one is on record. */
const LONG_RUNNING_MS = 10_000;

function instrumentSpawn(write: Write): void {
  const record = (
    what: "exit" | "running",
    described: { cmd: string; args: string },
    fields: Record<string, unknown>,
    failed: boolean,
  ) =>
    write({
      level: failed ? "warn" : "info",
      channel: "proc",
      tag: "proc",
      msg: `${what} ${described.cmd}`,
      fields: { cmd: described.cmd, args: described.args, ...fields },
      text: null,
    });

  const spawn = Bun.spawn;
  const spawnSync = Bun.spawnSync;
  try {
    (Bun as { spawn: unknown }).spawn = function (this: unknown, ...args: unknown[]) {
      const child = (spawn as (...a: unknown[]) => ReturnType<typeof Bun.spawn>).apply(Bun, args);
      if (quiet > 0) {
        const pid = child.pid;
        measuring.add(pid);
        void child.exited.then(
          () => measuring.delete(pid),
          () => measuring.delete(pid),
        );
        return child;
      }
      try {
        const started = Date.now();
        const described = describeCommand(argvOf(args));
        const stillRunning = setTimeout(
          () => record("running", described, { pid: child.pid, ms: Date.now() - started }, false),
          LONG_RUNNING_MS,
        );
        stillRunning.unref?.();
        void child.exited.then(
          (code) => {
            clearTimeout(stillRunning);
            const signal = child.signalCode ?? undefined;
            record(
              "exit",
              described,
              { pid: child.pid, code, ...(signal ? { signal } : {}), ms: Date.now() - started },
              failed(code, signal),
            );
          },
          () => clearTimeout(stillRunning),
        );
      } catch {}
      return child;
    };
    (Bun as { spawnSync: unknown }).spawnSync = function (this: unknown, ...args: unknown[]) {
      const started = Date.now();
      const result = (spawnSync as (...a: unknown[]) => ReturnType<typeof Bun.spawnSync>).apply(
        Bun,
        args,
      );
      if (quiet > 0) return result;
      try {
        const signal = (result as { signalCode?: string | null }).signalCode ?? undefined;
        record(
          "exit",
          describeCommand(argvOf(args)),
          {
            pid: (result as { pid?: number }).pid,
            code: result.exitCode,
            ...(signal ? { signal } : {}),
            ms: Date.now() - started,
            sync: true,
          },
          failed(result.exitCode, signal),
        );
      } catch {}
      return result;
    };
  } catch {
    // A runtime that will not let these be replaced keeps its own.
  }
}

function monitorExit(write: Write): void {
  // A monitor sees the exception and leaves what happens next alone: the
  // process still ends, launchd still restarts it. An `uncaughtException`
  // handler here would keep a broken process running.
  process.on("uncaughtExceptionMonitor", (error: unknown, origin: string) => {
    const err = error as Error;
    write({
      level: "error",
      channel: "error",
      tag: "fatal",
      msg: `${origin}: ${err?.message ?? String(error)}`,
      fields: { origin, stack: err?.stack },
      text: null,
    });
  });
  process.on("exit", (code) => {
    write({
      level: code === 0 ? "info" : "warn",
      channel: "system",
      tag: "exit",
      msg: `process exit code=${code}`,
      fields: { code, uptime_s: Math.round(process.uptime()) },
      text: null,
    });
  });
}
