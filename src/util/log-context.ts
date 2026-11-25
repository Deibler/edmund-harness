/**
 * Which conversation and which turn a log record belongs to.
 *
 * A record that says what happened is half of an answer; the other half is
 * what it happened for. Work started inside `withLogContext` carries the
 * session and turn to every record written while it runs, including an
 * outbound request three awaits down that has no idea a turn exists.
 *
 * Lines that arrive from outside that flow (a worker's output stream, a tool
 * call in another process) usually name their session in a field. The turn is
 * then looked up from the session: one conversation runs one turn at a time.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type LogContext = { session?: string; turn?: string };

const storage = new AsyncLocalStorage<LogContext>();
let processContext: LogContext = {};
const turnBySession = new Map<string, string>();

/** Run `fn` with a session and turn attached to every record it causes. */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, fn);
}

/** The context for a whole process: an MCP server serves one conversation. */
export function setProcessLogContext(context: LogContext): void {
  processContext = { ...context };
}

/** Sessions are logged with and without the channel prefix; match either. */
function bare(session: string): string {
  return session.replace(/^imessage:/, "");
}

/** Note that a conversation's turn has started, for records that only name the conversation. */
export function beginTurn(session: string, turn: string): void {
  turnBySession.set(bare(session), turn);
}

/** Forget a turn once it is over. A later turn that has already started stays. */
export function endTurn(session: string, turn: string): void {
  if (turnBySession.get(bare(session)) === turn) turnBySession.delete(bare(session));
}

/**
 * The session and turn for a record. `named` is the session the record itself
 * names in a field, which wins over the surrounding context: a scheduler line
 * about one conversation can be written while another's turn is running.
 */
export function resolveLogContext(named?: string): LogContext {
  const ambient = storage.getStore();
  const session = named ?? ambient?.session ?? processContext.session;
  if (!session) return {};
  const sameAsAmbient = ambient?.session !== undefined && bare(ambient.session) === bare(session);
  const turn =
    (sameAsAmbient ? ambient?.turn : undefined) ??
    turnBySession.get(bare(session)) ??
    (named ? undefined : processContext.turn);
  return turn ? { session, turn } : { session };
}
