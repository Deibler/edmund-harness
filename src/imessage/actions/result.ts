import type { SendResult } from "../types.ts";
import { describeError } from "./classify.ts";

/**
 * Runs an operation and reports it as a `SendResult`.
 *
 * The action wrappers hand callers `{ ok }` rather than raising, because that is
 * the shape the harness already branches on. The error text keeps the class and
 * code so `isPermanentSendError` can still tell a retryable failure from one
 * that will fail the same way forever.
 */
export async function asSendResult(run: () => Promise<unknown>): Promise<SendResult> {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}
