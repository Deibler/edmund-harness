import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type GrokCaller, SHARED_CALLER } from "./caller.ts";

/**
 * The MCP surface Grok sees: four tools.
 *
 * The descriptions are the whole interface. Grok decides which tool to call from
 * them alone, by voice, and caches the list until the connector is re-added, so
 * they are written to be told apart by the words a person actually says:
 *
 *   "ask Edmund ..."                       -> ask_edmund   (waits, answer read aloud)
 *   "tell Edmund ..." / "have Edmund ..."  -> tell_edmund  (returns at once, answer texted)
 *   "did Edmund finish" / "any word"       -> check_edmund (no model turn)
 *   a Grok Bot with a finished task        -> report_to_edmund
 *
 * Nothing in them names a person or a number (this file is tracked): the
 * connector is configured for one owner, so "the user" is exact.
 */
export const ASK_TOOL_DESCRIPTION =
  "Ask Edmund, the user's personal AI assistant, a question or give him something to do, and WAIT for his answer to read aloud. " +
  'Call this when the user says "ask Edmund ...", "hey Edmund, ...", "Edmund, ..." or wants an answer from Edmund right now: ' +
  "a question, something to look up or check, their calendar or reminders, the weather, a fact about them or their life. " +
  "Do not answer those requests yourself, and do not guess what Edmund would say. " +
  'Pass what the user wants as `message`, in their own words and as a complete sentence, dropping only the "ask Edmund" part. ' +
  "Edmund knows the user, can search the web, see their calendar and reminders, and can text them links or files. " +
  "The result is Edmund's reply, already written to be spoken: read it to the user as it is, without adding to it. " +
  "If it says Edmund is working on it, tell the user that; he will text the answer. " +
  'For "tell Edmund ..." or "have Edmund ..." use tell_edmund instead; for "did Edmund finish" or "any word from Edmund" use check_edmund.';

export const TELL_TOOL_DESCRIPTION =
  "Tell Edmund, the user's personal AI assistant, something or have him do something, and move on: this returns immediately with \"Got it, Edmund's on it\" and he works in the background. " +
  'Call this when the user says "tell Edmund ...", "have Edmund ...", "let Edmund know ...", "get Edmund to ...", "remind Edmund ...", ' +
  "or hands off a task that takes a while or needs no answer right now: text someone, book or order something, research something, remember something. " +
  "Edmund's answer is NOT spoken: he texts it to the user's phone when it is done. " +
  'Pass what the user wants as `message`, in their own words and as a complete sentence, dropping only the "tell Edmund" part. ' +
  "Do not wait for, make up, or guess an answer: just tell the user Edmund is on it. " +
  "To ask Edmund a question and hear the answer now, use ask_edmund. To find out whether he has finished, use check_edmund.";

export const CHECK_TOOL_DESCRIPTION =
  "Check on Edmund, the user's personal AI assistant, without giving him anything to do. Instant: it starts no work. " +
  'Call this when the user asks "did Edmund finish", "any word from Edmund", "what did Edmund say", "is Edmund done", "is Edmund still working", ' +
  '"what is Edmund up to", or how the 3D print is going. ' +
  "It says whether Edmund is working right now, repeats the latest answers he texted the user after a slow request, and gives the 3D printer's progress if it is printing. " +
  "The result is written to be spoken: read it to the user as it is. Takes no arguments.";

export const REPORT_TOOL_DESCRIPTION =
  "FOR GROK BOTS, NOT FOR VOICE: hand Edmund, the user's personal AI assistant, the finished result of a task he gave you. " +
  "Call this exactly once when you finish a task that came from Edmund with a `reply_id` in its payload (the task says to report back with it). " +
  "Pass that `reply_id` exactly as received and your result in `result`. If you could not do the task, still call it and say why in `result`. " +
  "Never call it with an id you were not given, and never for a request from the user. " +
  'Returns "Thanks, delivered" once Edmund has it; an unknown or expired id is refused.';

export type ReportOutcome = { ok: true; text?: string } | { ok: false; error: string };

export type ConnectorOptions = {
  /** Who is calling, resolved from the key by the server. Every tool passes it
   *  on, so what reaches Edmund names the caller. Defaults to the shared key. */
  caller?: GrokCaller;
  maxMessageChars: number;
  /** Longest report_to_edmund result accepted, in characters. */
  maxResultChars: number;
  /** Count one turn-starting call against the rate limit; false when over it. */
  allowAsk: () => boolean;
  /** Count one report against its own, more generous limit. */
  allowReport: () => boolean;
  ask: (message: string, caller: GrokCaller) => Promise<string>;
  tell: (message: string, caller: GrokCaller) => void;
  check: (caller: GrokCaller) => Promise<string>;
  report: (
    replyId: string,
    result: string,
    caller: GrokCaller,
  ) => Promise<ReportOutcome> | ReportOutcome;
  /** How often to send MCP progress while ask waits. Default 10 s. */
  progressIntervalMs?: number;
};

const RATE_LIMITED = "Edmund is getting a lot of requests right now. Try again in a minute.";
export const TELL_REPLY = "Got it, Edmund's on it.";
export const REPORT_REPLY = "Thanks, delivered.";

const text = (body: string, isError = false) => ({
  content: [{ type: "text" as const, text: body }],
  ...(isError ? { isError: true } : {}),
});

/** A fresh MCP server exposing the connector tools. One per HTTP request (stateless). */
export function createConnectorServer(opts: ConnectorOptions): McpServer {
  const server = new McpServer({ name: "edmund", version: "1.1.0" });
  const caller = opts.caller ?? SHARED_CALLER;

  server.registerTool(
    "ask_edmund",
    {
      title: "Ask Edmund",
      description: ASK_TOOL_DESCRIPTION,
      inputSchema: {
        message: z
          .string()
          .min(1)
          .max(opts.maxMessageChars)
          .describe(
            `What the user wants Edmund to answer or do, in their words, as a full sentence (at most ${opts.maxMessageChars} characters).`,
          ),
      },
      annotations: { openWorldHint: true },
    },
    async ({ message }, extra) => {
      if (!opts.allowAsk()) return text(RATE_LIMITED, true);
      // A client that sent a progress token is told, every ~10 s, that work is
      // still going. Grok Bot treats progress as a sign of life and lets the
      // call run longer; the answer timeout inside `ask` is unchanged.
      const token = extra._meta?.progressToken;
      let ticks = 0;
      const timer =
        token === undefined
          ? undefined
          : setInterval(() => {
              ticks += 1;
              void extra
                .sendNotification({
                  method: "notifications/progress",
                  params: {
                    progressToken: token,
                    progress: ticks,
                    message: "Edmund is working on it",
                  },
                })
                .catch(() => {});
            }, opts.progressIntervalMs ?? 10_000);
      try {
        return text(await opts.ask(message, caller));
      } finally {
        if (timer) clearInterval(timer);
      }
    },
  );

  server.registerTool(
    "tell_edmund",
    {
      title: "Tell Edmund",
      description: TELL_TOOL_DESCRIPTION,
      inputSchema: {
        message: z
          .string()
          .min(1)
          .max(opts.maxMessageChars)
          .describe(
            `What the user wants Edmund to know or do, in their words, as a full sentence (at most ${opts.maxMessageChars} characters).`,
          ),
      },
      annotations: { openWorldHint: true },
    },
    async ({ message }) => {
      if (!opts.allowAsk()) return text(RATE_LIMITED, true);
      opts.tell(message, caller);
      return text(TELL_REPLY);
    },
  );

  server.registerTool(
    "check_edmund",
    {
      title: "Check on Edmund",
      description: CHECK_TOOL_DESCRIPTION,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => text(await opts.check(caller)),
  );

  server.registerTool(
    "report_to_edmund",
    {
      title: "Report a finished task to Edmund",
      description: REPORT_TOOL_DESCRIPTION,
      inputSchema: {
        reply_id: z
          .string()
          .min(1)
          .max(100)
          .describe(
            "The reply_id from the task Edmund sent you, exactly as given (like gb-1a2b3c4d5e).",
          ),
        result: z
          .string()
          .min(1)
          .max(opts.maxResultChars)
          .describe(
            `What you found or did, or why you could not do it (at most ${opts.maxResultChars} characters; be concise).`,
          ),
      },
      annotations: { openWorldHint: true },
    },
    async ({ reply_id, result }) => {
      if (!opts.allowReport()) return text(RATE_LIMITED, true);
      const outcome = await opts.report(reply_id, result, caller);
      return outcome.ok ? text(outcome.text ?? REPORT_REPLY) : text(outcome.error, true);
    },
  );

  return server;
}
