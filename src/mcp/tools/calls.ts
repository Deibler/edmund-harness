import { z } from "zod";
import { CallPolicy, mayRequestCall } from "../../calls/policy.ts";
import { CallStore } from "../../calls/store.ts";
import { ownVoices } from "../../calls/voice-settings.ts";
import { dmKeyFor, normalizeHandle } from "../../sessions/key.ts";
import { genId } from "../../util/ids.ts";
import { kokoroVoices } from "../../voice/speech-sidecar.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef, ToolResult } from "./types.ts";

/**
 * FaceTime tools. They run in the turn's own MCP process, which cannot reach
 * the daemon's call manager, so they queue requests in data/calls.db and the
 * daemon acts on them within a fraction of a second. The daemon re-checks
 * every rule before dialling: the checks here are for a fast, clear answer to
 * the model, not the boundary.
 */

const CallInput = z.object({
  who: z
    .string()
    .describe(
      "The person to call: a name from your contacts, or their phone number / Apple ID email.",
    ),
  reason: z
    .string()
    .describe(
      "Why you are calling, in a sentence. You are reminded of it when they pick up, so write it for yourself.",
    ),
});

const NoInput = z.object({});

function text(body: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

function looksLikeHandle(value: string): boolean {
  return value.includes("@") || /^\+?[\d\s().-]{7,}$/.test(value.trim());
}

/** Goes back to the voice tuned in the voice lab. */
const USUAL = "usual";

/** `installedVoices` is for tests; it defaults to Kokoro's voices file. */
export function callTools(
  ctx: ToolContext,
  installedVoices: () => string[] = () => kokoroVoices(),
): ToolDef[] {
  if (!ctx.config.facetime.enabled) return [];
  const voices = ownVoices(installedVoices());

  const withStore = <T>(run: (store: CallStore) => T): T => {
    const store = new CallStore(ctx.dataDir);
    try {
      return run(store);
    } finally {
      store.close();
    }
  };

  return [
    {
      name: "facetime_call",
      description:
        "Call someone on FaceTime (audio). The call runs inside your conversation with them: what you say there and here is one conversation. End your turn after calling; you are told when they pick up (and why you called), or that they did not.",
      inputSchema: CallInput,
      handler: async (args) => {
        let handle: string;
        if (looksLikeHandle(args.who)) {
          handle = normalizeHandle(args.who);
        } else {
          const people = ctx.contacts.peopleNamed(args.who);
          if (people.length === 0)
            return text(`No one in your contacts is called "${args.who}".`, true);
          if (people.length > 1) {
            const options = people.map((p) => `${p.name}: ${p.handles.join(", ")}`).join("\n");
            return text(
              `More than one contact matches "${args.who}". Call again with the handle of the one you mean:\n${options}`,
              true,
            );
          }
          handle = people[0]!.handles[0]!;
        }
        const canon = ctx.contacts.canon(handle);
        const callee = dmKeyFor(canon);
        const allowed = new CallPolicy(ctx.config, ctx.contacts).permits({
          kind: "person",
          handle,
        });
        if (!allowed.allowed) return text(`Can't call them: ${allowed.reason}.`, true);
        const mayAsk = mayRequestCall(ctx.config, ctx.sessionKey, callee);
        if (!mayAsk.allowed) return text(`Can't call them: ${mayAsk.reason}.`, true);

        withStore((store) =>
          store.addRequest({
            id: genId("call_request"),
            requestedBy: ctx.sessionKey,
            sessionKey: callee,
            handle,
            reason: args.reason,
            createdAtMs: Date.now(),
          }),
        );
        const who = ctx.contacts.label(canon) ?? canon;
        return text(
          `Calling ${who} on FaceTime now. End your turn; you'll be told when they pick up.`,
        );
      },
    },
    {
      name: "end_call",
      description:
        "Hang up the FaceTime call this conversation is on, once what you have already said has finished playing. Say goodbye first, in the same reply.",
      inputSchema: NoInput,
      handler: async () => {
        withStore((store) => store.addCommand(genId("call_command"), ctx.sessionKey, "hangup"));
        return text("Hanging up.");
      },
    },
    ...(voices.length === 0
      ? []
      : [
          {
            name: "call_voice",
            description:
              'Change the voice you speak with on the FaceTime call this conversation is on, from your next sentence until the call ends. am_ voices are American, bm_ British. "usual" goes back to your normal voice.',
            inputSchema: z.object({
              voice: z.enum([USUAL, ...voices] as [string, ...string[]]),
            }),
            handler: async (args: { voice: string }) => {
              const voice = args.voice === USUAL ? null : args.voice;
              const set = withStore((store) => {
                const call = store.liveCall(ctx.sessionKey);
                return call !== null && store.setVoice(call.id, voice);
              });
              if (!set) return text("This conversation is not on a call.", true);
              return text(
                voice
                  ? `Speaking as ${voice} from your next sentence until this call ends.`
                  : "Back to your usual voice from your next sentence.",
              );
            },
          } satisfies ToolDef,
        ]),
    {
      name: "call_status",
      description:
        "Whether this conversation is on a FaceTime call right now, and its recent calls (when, how long, notes).",
      inputSchema: NoInput,
      handler: async () => {
        const calls = withStore((store) =>
          store.callsInConversation(ctx.sessionKey, 5).map((call) => {
            const notes = store.notes(call.id);
            return { call, notes, voice: call.endedAtMs === null ? store.voice(call.id) : null };
          }),
        );
        if (calls.length === 0) return text("No FaceTime calls in this conversation yet.");
        const lines = calls.map(({ call, notes, voice }) => {
          const when = new Date(call.startedAtMs).toLocaleString();
          const state =
            call.endedAtMs === null
              ? `in progress${voice ? `, speaking as ${voice}` : ""}`
              : call.answeredAtMs === null
                ? `not connected (${call.endReason})`
                : `${Math.round((call.endedAtMs - call.answeredAtMs) / 60_000)} min (${call.endReason})`;
          return `${when}, ${call.direction}: ${state}${notes ? `\n  notes: ${notes}` : ""}`;
        });
        return text(lines.join("\n"));
      },
    },
  ];
}
