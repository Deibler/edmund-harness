/**
 * stdout protection for stdio MCP servers.
 *
 * In a stdio MCP server, **stdout IS the JSON-RPC transport**. Every byte
 * written there is parsed as protocol framing. A single `console.log` in a tool
 * handler injects a non-JSON line into the stream — which, depending on where
 * it lands relative to a frame boundary, either gets skipped or desynchronizes
 * the reader and kills the session mid-turn. The failure is intermittent and
 * looks like a model or network problem, which is the worst kind.
 *
 * This is easy to reintroduce: `console.log` is the obvious thing to type, and
 * `src/util/log.ts` routes info/debug through it too — so even "use the logger"
 * would not have been safe. Rather than police ~20 call sites and every future
 * one, redirect the whole console at the process boundary.
 *
 * stderr is the correct destination: the harness captures it into daemon.log
 * (see `installLogSinkFromEnv`), so nothing is lost — the lines just stop
 * sharing a pipe with the protocol.
 *
 * Call this ONCE, at the top of an MCP server entry point, before the
 * transport connects. It is a no-op for anything that is not a stdio server.
 */
export function protectStdout(): void {
  const toStderr =
    (label: string) =>
    (...args: unknown[]): void => {
      const line = args
        .map((a) => (typeof a === "string" ? a : safeStringify(a)))
        .join(" ")
        .trimEnd();
      process.stderr.write(`${label}${line}\n`);
    };

  console.log = toStderr("");
  console.info = toStderr("");
  console.debug = toStderr("");
  console.warn = toStderr("");
  // console.error already goes to stderr; leave it alone so its formatting
  // (stack traces, %-substitution) keeps working as-is.
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return value.stack ?? String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Circular or otherwise unserializable — a lossy label beats throwing
    // inside a logging call.
    return String(value);
  }
}
