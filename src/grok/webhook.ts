/**
 * The client for a Grok Bot routine's webhook trigger.
 *
 * A routine with a webhook trigger is started by `POST <webhook_url>` with
 * `Authorization: Bearer <key>` and an optional JSON body, which the Bot gets
 * along with the routine's instruction. A 200 means the run STARTED, not that it
 * finished; the Bot hands the result back by calling `report_to_edmund`.
 *
 * Neither the URL nor the key is ever logged or returned: errors here are fixed
 * sentences (a `fetch` failure message can carry the URL), and the caller gets
 * the bot's name, not its address.
 */

export type GrokBot = { webhook_url: string; key: string };

export type WebhookPayload = {
  task: string;
  reply_id: string;
  from: "Edmund";
  reply_instructions: string;
};

export type WebhookResult = { ok: true } | { ok: false; error: string };

export const REPLY_INSTRUCTIONS =
  "When done, call the report_to_edmund tool on the Edmund connector with this reply_id and your result. If you can't, say why in the result.";

export function webhookPayload(task: string, replyId: string): WebhookPayload {
  return { task, reply_id: replyId, from: "Edmund", reply_instructions: REPLY_INSTRUCTIONS };
}

const TIMEOUT_MS = 15_000;

/** Explains a non-200 in terms of what the owner can fix. Never echoes the response body. */
function describeStatus(status: number, botName: string): string {
  if (status === 401 || status === 403)
    return `Grok rejected the key for bot "${botName}" (HTTP ${status}). The key under [grok.bots.${botName}] in config.toml is wrong or the routine's webhook was regenerated.`;
  if (status === 404 || status === 410)
    return `Grok has no routine at bot "${botName}"'s webhook (HTTP ${status}). It was deleted or its trigger was turned off; check webhook_url under [grok.bots.${botName}].`;
  if (status === 429)
    return `Grok is rate limiting bot "${botName}" (HTTP 429; a routine takes 200 runs an hour). Try again later.`;
  if (status >= 500)
    return `Grok had a server error starting bot "${botName}" (HTTP ${status}). Try again in a minute.`;
  return `Grok did not accept the task for bot "${botName}" (HTTP ${status}).`;
}

export async function postToBot(
  bot: GrokBot,
  botName: string,
  payload: WebhookPayload,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<WebhookResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(bot.webhook_url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bot.key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
      redirect: "error",
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    if (name === "TimeoutError" || name === "AbortError")
      return {
        ok: false,
        error: `Grok did not answer for bot "${botName}" within ${(opts.timeoutMs ?? TIMEOUT_MS) / 1000} seconds. The task may or may not have started.`,
      };
    return {
      ok: false,
      error: `Could not reach Grok for bot "${botName}" (${name}). Check the network and webhook_url under [grok.bots.${botName}].`,
    };
  }
  // Drain so the connection is released; the body is not trusted or surfaced.
  void res.arrayBuffer().catch(() => {});
  if (res.status >= 200 && res.status < 300) return { ok: true };
  return { ok: false, error: describeStatus(res.status, botName) };
}
