import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { peekPending } from "../../bridge/session-queue.ts";
import { markdownToPlaintext, sanitizeOutbound } from "../../channels/sanitize-outbound.ts";
import {
  type ResolvedMessage,
  chatRowIdForGuids,
  findRecentMessageByText,
  latestMessageInGuids,
  resolveMessageGuid,
} from "../../imessage/participants.ts";
import { EXPRESSIVE_EFFECTS, sendMessage, sendTapback } from "../../imessage/send.ts";
import type {
  MirrorComponentForAsset,
  MirrorStoreCtor,
  PublishMirrorAsset,
} from "../../integrations/mirror-contracts.ts";
import { integrationExport } from "../../integrations/optional.ts";
import * as intSettings from "../../integrations/settings.ts";
import { maybeResizeImage } from "../../media/image-resize.ts";
import { maybePrepareVideoForSend } from "../../media/video-transcode.ts";
import { viewerForSession } from "../../orchestrators/visibility.ts";
import { isMirrorSession } from "../../sessions/key.ts";
import { chatIdFromKey, isGroupSession } from "../../sessions/key.ts";
import { StateStore } from "../../sessions/store.ts";
import { assertPathSafe } from "../../util/path-safety.ts";
import { appleMapsLink } from "../../imessage/maps-link.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

/**
 * The model sometimes hands `send_attachment` a path that points at a stale
 * harness root (e.g. an old `~/Documents/edmund-harness/...` location preserved
 * in session memory) when the actual file was written by the bg runner under
 * the *current* sandbox. We can recover from this without bothering the model:
 *
 *   1. If the given path exists, use it.
 *   2. Else, if the path contains `/<currentSandboxBaseName>/<rest>`, rebase
 *      that suffix onto the live `ctx.sandboxPath`.
 *   3. Else, search the live sandbox for a unique basename match.
 *
 * Returns the original path if nothing better is found — caller surfaces the
 * downstream "not found" error as before.
 */
function resolveAttachmentPath(filePath: string, sandboxPath: string): string {
  if (existsSync(filePath)) return filePath;

  const slug = basename(sandboxPath);
  const marker = `/${slug}/`;
  const idx = filePath.indexOf(marker);
  if (idx !== -1) {
    const rebased = join(sandboxPath, filePath.slice(idx + marker.length));
    if (existsSync(rebased)) {
      console.warn(`[send_attachment] rebased stale path → ${rebased}`);
      return rebased;
    }
  }

  const want = basename(filePath);
  const matches: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || matches.length > 1) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(p, depth + 1);
      else if (e === want) matches.push(p);
    }
  };
  walk(sandboxPath, 0);
  if (matches.length === 1 && matches[0]) {
    console.warn(`[send_attachment] resolved by basename → ${matches[0]}`);
    return matches[0];
  }
  return filePath;
}

const AttachmentInput = z.object({
  file_path: z
    .string()
    .describe("Absolute path to any file — image, audio, video, PDF, doc, zip, html, etc."),
  caption: z.string().optional().describe("Optional short caption sent before the attachment."),
});

const MessageInput = z.object({
  text: z.string().min(1).describe("The message text to send."),
  reply_to: z
    .string()
    .optional()
    .describe(
      "OPTIONAL — thread this as an inline reply to a SPECIFIC earlier message: pass a snippet of that message's text. Useful in a busy group to answer something three messages back without ambiguity. (Needs the IMCore bridge; if it's unavailable the message still sends, just not threaded.)",
    ),
  effect: z
    .string()
    .optional()
    .describe(
      `OPTIONAL — send with an expressive effect. Bubble effects: impact (slam), loud, gentle, invisibleink. Screen effects: confetti, lasers, fireworks, balloons, love, spotlight, echo, celebration. Use sparingly and only when it genuinely fits the moment (a real congrats → confetti; a dramatic reveal → invisibleink). One of: ${EXPRESSIVE_EFFECTS.join(", ")}. (Needs the IMCore bridge + effects enabled in config; otherwise it's ignored and the plain text sends.)`,
    ),
  subject: z
    .string()
    .optional()
    .describe(
      "OPTIONAL — a bold subject-line header above the message body. (Needs the bridge + subject_lines enabled in config; otherwise ignored.)",
    ),
});

const ReactInput = z.object({
  reaction: z
    .string()
    .min(1)
    .describe(
      "One of: love, like, dislike, laugh, emphasis, question — OR a single emoji character for a custom reaction. " +
        "love=❤️ like=👍 dislike=👎 laugh=😂 emphasis=‼️ question=❓",
    ),
  target: z
    .string()
    .optional()
    .describe(
      "OPTIONAL — react to a SPECIFIC earlier message instead of the latest one. Pass a snippet of that message's text (a few distinctive words is plenty); the most recent message in the thread containing it gets the tapback. Candidate messages show up in the envelope's 'Recent thread' / 'Since you last replied' blocks. Omit to react to the most recent message.",
    ),
  target_guid: z
    .string()
    .optional()
    .describe(
      "OPTIONAL — alternative to `target`: the exact msg_guid of the message to react to (e.g. one returned by search_history). Takes precedence over `target`.",
    ),
});

/** Map common phrasings the model might pick to imsg's expected keywords.
 *  Pass-through for anything else (e.g. a literal emoji). */
const REACTION_ALIASES: Record<string, string> = {
  heart: "love",
  loved: "love",
  "❤️": "love",
  "❤": "love",
  thumbsup: "like",
  "thumbs up": "like",
  liked: "like",
  "👍": "like",
  thumbsdown: "dislike",
  "thumbs down": "dislike",
  disliked: "dislike",
  "👎": "dislike",
  haha: "laugh",
  laughed: "laugh",
  lol: "laugh",
  "😂": "laugh",
  "😆": "laugh",
  emphasize: "emphasis",
  emphasized: "emphasis",
  "‼️": "emphasis",
  "!!": "emphasis",
  questioned: "question",
  "?": "question",
  "❓": "question",
};

function normalizeReaction(input: string): string {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  return (
    REACTION_ALIASES[lower] ??
    REACTION_ALIASES[trimmed] ??
    (/^[a-z]+$/.test(lower) ? lower : trimmed)
  );
}

/**
 * Post-send bookkeeping for tool-driven sends into the CURRENT chat. The
 * daemon's session store only learned about outbounds at end-of-turn
 * (sendDeliver / the tool-only branch in channels/turn.ts), so a turn that
 * died after a send_message/send_attachment left the session looking
 * eternally unanswered — the recovery sweeper and stale-retry guard then
 * re-invoked the model on a burst the user had already seen answered.
 * Recording the outbound at send time (same on-demand state.db handle
 * pattern as contacts.ts/history.ts) closes that gap. The attribution row
 * mirrors what deliverReply-path sends record, so per-orchestrator history
 * filtering attributes tool sends the same way.
 *
 * Pure bookkeeping: this never suppresses anything the model chooses to say
 * — whether to also produce a final text reply stays entirely its call.
 * Failures are logged, not surfaced: the message is already on the wire, and
 * a failed ledger write must not make a successful send look failed.
 */
/** A place to drop into the chat as a Maps card. */
const SendLocationInput = z.object({
  name: z.string().optional().describe('Place name — "Sabrina\'s Cafe". Becomes the card title.'),
  address: z.string().optional().describe("Street address. Shown as-is, not searched."),
  latitude: z.number().optional().describe("Preferred over address when known — cannot geocode wrong."),
  longitude: z.number().optional(),
  note: z
    .string()
    .optional()
    .describe("Optional context, sent as its own message BEFORE the card so the preview still renders."),
});

export function recordToolSend(
  deps: Pick<ToolContext, "dataDir" | "sessionKey" | "chatGuids">,
  sentText: string,
  chatGuid?: string,
): void {
  let state: StateStore | null = null;
  try {
    state = new StateStore(deps.dataDir);
    state.noteToolSend(deps.sessionKey);
    const guid = chatGuid ?? deps.chatGuids[0];
    if (guid && sentText.trim().length > 0) {
      state.recordSentAttribution(guid, viewerForSession(deps.sessionKey) ?? "main", [sentText]);
    }
  } catch (err) {
    console.warn(
      `[send] outbound bookkeeping failed (message already sent): ${String(err).slice(0, 200)}`,
    );
  } finally {
    try {
      state?.close();
    } catch {}
  }
}

/**
 * Normal text replies flow back via the `result` of `claude -p` — Claude
 * doesn't need a send_text tool. This tool exists for *out-of-band* sends:
 * any file the assistant has produced or is referencing.
 */
export function messageTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "check_incoming",
      description:
        "Returns any messages that arrived in this chat SINCE this turn started — follow-ups queued while you're already working. Call this before beginning any long task (>10s: image gen, video, research, agent spawn) and at natural breakpoints during one, to see if the user added context or pivoted — so you can adjust, cancel inflight agents, or ack before burning time. (Blunt cancels — a bare 'stop'/'never mind' — abort your turn harness-side before you could even peek; this tool is for the softer follow-ups that don't.) Peeking does NOT consume them: when this turn ends you'll get one more pass with these message(s) + the reply you drafted, so you can fold everything into a single coherent response (or keep your draft). If a follow-up is queued and your remaining work is >30s, prefer handoff_current_work over making them wait. Returns 'no pending messages' if nothing is queued.",
      inputSchema: z.object({}),
      handler: async () => {
        const entries = peekPending(ctx.sessionKey, ctx.dataDir);
        if (entries.length === 0) {
          return { content: [{ type: "text", text: "no pending messages" }] };
        }
        const lines = entries.map((e) => {
          const ts = new Date(e.timestampMs).toLocaleTimeString();
          const text = e.text ?? "(no text)";
          const atts = e.attachments.length > 0 ? ` [+${e.attachments.length} attachment(s)]` : "";
          return `[${ts}] ${e.fromHandle}: ${text}${atts}`;
        });
        console.log(`[check_incoming] ${ctx.sessionKey} found ${entries.length} pending`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    },
    {
      name: "send_message",
      description:
        "Send a text iMessage to THIS conversation right now. Three uses: " +
        "(1) a mid-turn heads-up before a slow task ('on it, gimme a sec') so the user sees life on the other end — then let your FINAL reply be the actual result; " +
        "(2) reply inline to a specific earlier message in a busy thread (pass `reply_to`); " +
        "(3) a standalone message with a send `effect` (confetti for a real congrats, etc.) — note the auto-sent final reply can't carry an effect, so if you want flair, send it here and then return no text (tool-only turn). " +
        "Don't double up: if you send the whole reply here, end the turn with no text reply. Keep it short and in-character; never meta-commentary about tooling.",
      inputSchema: MessageInput,
      handler: async (args) => {
        // Mid-turn sends bypass deliverReply, so run the same sanitation here
        // — em-dashes / smart quotes / markdown get stripped before hitting
        // the chat. Otherwise the model's text leaks AI tells.
        const cleaned = markdownToPlaintext(sanitizeOutbound(args.text)).trim();
        if (!cleaned)
          return { content: [{ type: "text", text: "empty after sanitize" }], isError: true };

        if (isMirrorSession(ctx.sessionKey)) {
          const MirrorStore = await integrationExport<MirrorStoreCtor>(
            "mirror",
            "src/store.ts",
            "MirrorStore",
          );
          if (!MirrorStore) {
            return { content: [{ type: "text", text: "mirror integration not installed" }] };
          }
          const store = new MirrorStore(ctx.dataDir);
          try {
            store.upsertContent(
              {
                id: "system:midturn-message",
                page: "home",
                zone: "lower_third",
                presentation: "widget",
                component: "text_block",
                props: { eyebrow: "Edmund", text: cleaned, tone: "default" },
                lifespan: "ephemeral",
                priority: 85,
                expiresAtMs:
                  Date.now() + intSettings.mirror(ctx.config).default_ttl_seconds * 1_000,
              },
              "channel.send_message",
            );
          } finally {
            store.close();
          }
          recordToolSend(ctx, cleaned);
          return {
            content: [
              {
                type: "text",
                text:
                  args.effect || args.subject || args.reply_to
                    ? "rendered on mirror (iMessage-only threading/effect/subject omitted)"
                    : "rendered on mirror",
              },
            ],
          };
        }

        const isGroup = isGroupSession(ctx.sessionKey);
        const to = chatIdFromKey(ctx.sessionKey);

        // Resolve an inline-reply target from a text snippet → message guid.
        let replyTo: string | undefined;
        let chatGuid: string | undefined = ctx.chatGuids[0];
        if (args.reply_to?.trim()) {
          const hit = findRecentMessageByText(ctx.chatDb, ctx.chatGuids, args.reply_to);
          if (!hit) {
            return {
              content: [
                {
                  type: "text",
                  text: `couldn't find a recent message containing "${args.reply_to}" to reply to — sending un-threaded would be confusing, so try a different snippet or send without reply_to`,
                },
              ],
              isError: true,
            };
          }
          replyTo = hit.messageGuid;
          chatGuid = hit.chatGuid;
        }

        // Honor the per-action whitelist: drop effect/subject if disabled.
        const effect = ctx.config.imessage_actions.effects
          ? args.effect?.trim() || undefined
          : undefined;
        const subject = ctx.config.imessage_actions.subject_lines
          ? args.subject?.trim() || undefined
          : undefined;

        console.log(
          `[send_message] ${ctx.sessionKey} len=${cleaned.length}${replyTo ? " +reply_to" : ""}${effect ? ` +effect=${effect}` : ""}${subject ? " +subject" : ""}`,
        );
        const res = await sendMessage({
          to,
          isGroup,
          text: cleaned,
          chatGuid,
          replyTo,
          effect,
          subject,
        });
        if (!res.ok) {
          console.error(`[send_message] ${ctx.sessionKey} FAILED: ${res.error}`);
          return { content: [{ type: "text", text: `send error: ${res.error}` }], isError: true };
        }
        recordToolSend(ctx, cleaned, chatGuid);
        return { content: [{ type: "text", text: "sent" }] };
      },
    },
    {
      name: "send_location",
      description: [
        "Send a place to THIS conversation as a tappable Apple Maps card, instead of writing an address out as text.",
        "",
        "Use it any time you name somewhere the person might actually go — a restaurant, a trailhead, a shop, a meeting point. An address typed as prose has to be selected, copied and pasted into Maps; a card is one tap to directions.",
        "",
        "Pass `name` plus `address` for a place (the name becomes the card's title). Pass `latitude`/`longitude` when you have them — coordinates can't geocode onto the wrong street, and the name still labels the card. A `name` on its own is fine too; it searches Maps the way a person would.",
        "",
        "`note` is optional context ('big portions, nobody expects a big check') and is sent as a SEPARATE message before the card, because Messages only renders the preview when the link is alone in its message.",
        "",
        "Send one card per place. Several links in one message render as none.",
      ].join("\n"),
      inputSchema: SendLocationInput,
      handler: async (args) => {
        if (isMirrorSession(ctx.sessionKey)) {
          return {
            content: [{ type: "text", text: "send_location is an iMessage action; the mirror has no chat" }],
            isError: true,
          };
        }
        let url: string;
        try {
          url = appleMapsLink({
            name: args.name,
            address: args.address,
            latitude: args.latitude,
            longitude: args.longitude,
          });
        } catch (err) {
          return {
            content: [{ type: "text", text: `send_location: ${(err as Error).message}` }],
            isError: true,
          };
        }

        const isGroup = isGroupSession(ctx.sessionKey);
        const to = chatIdFromKey(ctx.sessionKey);
        const chatGuid = ctx.chatGuids[0];

        // Context first, as its own message. Appending it to the link would
        // turn the card back into blue text, which is the whole problem.
        const note = markdownToPlaintext(sanitizeOutbound(args.note ?? "")).trim();
        if (note) {
          const pre = await sendMessage({ to, isGroup, text: note, chatGuid });
          if (!pre.ok) {
            return {
              content: [{ type: "text", text: `send_location: note failed — ${pre.error}` }],
              isError: true,
            };
          }
          recordToolSend(ctx, note, chatGuid);
        }

        const res = await sendMessage({ to, isGroup, text: url, chatGuid });
        if (!res.ok) {
          return {
            content: [{ type: "text", text: `send_location failed: ${res.error}` }],
            isError: true,
          };
        }
        recordToolSend(ctx, url, chatGuid);
        console.log(`[send_location] ${ctx.sessionKey} ${url}`);
        return { content: [{ type: "text", text: `sent map card: ${url}` }] };
      },
    },
    {
      name: "react",
      description:
        "Tapback a message in this conversation — love(❤️)/like(👍)/dislike(👎)/laugh(😂)/emphasis(‼️)/question(❓), or any single emoji for a custom reaction. " +
        "By default it reacts to the most recent message; pass `target` (a snippet of the text) to react to a specific earlier one — pick whichever message your reaction is actually about, you're not limited to the latest. " +
        "Use this instead of a text reply when a whole new message would just be noise: acknowledging you've seen something, a quick 👍 to confirm, laughing at a joke, hearting a photo. " +
        "Great in @mention-gated group chats — you can react without it counting as 'speaking up'. " +
        "If it errors, just send a short text instead.",
      inputSchema: ReactInput,
      handler: async (args) => {
        if (isMirrorSession(ctx.sessionKey)) {
          return {
            content: [
              {
                type: "text",
                text: "reactions are an iMessage social action; update or render mirror content instead",
              },
            ],
            isError: true,
          };
        }
        const reaction = normalizeReaction(args.reaction);
        const target = args.target?.trim();
        const targetGuid = args.target_guid?.trim();

        // Any message, any reaction. Reactions used to split two ways: the
        // classic six went through IMCore, while an emoji drove the Messages UI
        // with System Events — which needed an Accessibility grant and could
        // only ever touch the newest message, so "react 🎉 to what you said
        // earlier" was refused. IMCore sends emoji tapbacks as real objects, so
        // there is one path now and no combination to refuse.
        // The latest-message lookup carries no text (it does not need to read
        // one to find it), so the quoted snippet in the reply is optional.
        const hit: (Omit<ResolvedMessage, "text"> & { text?: string }) | null = targetGuid
          ? resolveMessageGuid(ctx.chatDb, targetGuid)
          : target
            ? findRecentMessageByText(ctx.chatDb, ctx.chatGuids, target)
            : latestMessageInGuids(ctx.chatDb, ctx.chatGuids);

        if (!hit) {
          const why = targetGuid
            ? `no message with guid ${targetGuid}`
            : target
              ? `couldn't find a recent message containing "${target}"`
              : "couldn't find a recent message in this chat to react to";
          return { content: [{ type: "text", text: why }], isError: true };
        }

        console.log(`[react] ${ctx.sessionKey} msg=${hit.messageGuid} kind=${reaction}`);
        const res = await sendTapback({
          chatGuid: hit.chatGuid,
          messageGuid: hit.messageGuid,
          kind: reaction,
        });
        if (!res.ok) {
          console.error(`[react] ${ctx.sessionKey} FAILED: ${res.error}`);
          return { content: [{ type: "text", text: `react error: ${res.error}` }], isError: true };
        }

        const snippet = (hit.text ?? "").replace(/\s+/g, " ").trim();
        const what = snippet.length > 50 ? `${snippet.slice(0, 50)}\u2026` : snippet;
        return {
          content: [
            {
              type: "text",
              text: what ? `reacted ${reaction} to "${what}"` : `reacted ${reaction}`,
            },
          ],
        };
      },
    },
    {
      name: "send_attachment",
      description:
        "Send ANY file to the current conversation — images, audio, video, PDFs, documents, HTML, archives, whatever. If you've just produced a file the user asked for (pdf about cats, a generated image, a voice memo, a zipped project), CALL THIS TOOL to actually deliver it. Never just tell the user 'here's the pdf at /path/...' — they can't see paths. Path must be absolute. Text replies are auto-sent; use send_attachment ONLY for files.",
      inputSchema: AttachmentInput,
      handler: async (args) => {
        const resolvedPath = resolveAttachmentPath(args.file_path, ctx.sandboxPath);
        try {
          assertPathSafe(resolvedPath);
        } catch (err) {
          return {
            content: [{ type: "text", text: (err as Error).message }],
            isError: true,
          };
        }
        // Deliverability guards: shrink oversized images (sips), and re-encode
        // videos that are too heavy or in an iMessage-hostile format (webm/
        // mkv/vp9/av1 → h264+aac mp4, ≤ ~15 MB). Each is a no-op for files
        // that are already fine, and each falls back to the original on any
        // failure — the guard must never block a send the bridge might manage.
        const path = await maybePrepareVideoForSend(await maybeResizeImage(resolvedPath));
        if (isMirrorSession(ctx.sessionKey)) {
          try {
            const publishMirrorAsset = await integrationExport<PublishMirrorAsset>(
              "mirror",
              "src/assets.ts",
              "publishMirrorAsset",
            );
            const mirrorComponentForAsset = await integrationExport<MirrorComponentForAsset>(
              "mirror",
              "src/assets.ts",
              "mirrorComponentForAsset",
            );
            const MirrorStore = await integrationExport<MirrorStoreCtor>(
              "mirror",
              "src/store.ts",
              "MirrorStore",
            );
            if (!publishMirrorAsset || !mirrorComponentForAsset || !MirrorStore) {
              throw new Error("mirror integration not installed");
            }
            const asset = await publishMirrorAsset(path, ctx.config);
            const spec = mirrorComponentForAsset(asset, args.caption, path);
            const id = `asset:${asset.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 80);
            const store = new MirrorStore(ctx.dataDir);
            try {
              store.upsertContent(
                {
                  id,
                  page: "home",
                  zone: "upper_third",
                  presentation:
                    spec.component === "image_card" || spec.component === "video"
                      ? "page"
                      : "widget",
                  ...spec,
                  lifespan: "ephemeral",
                  priority: 75,
                  expiresAtMs:
                    Date.now() + intSettings.mirror(ctx.config).default_ttl_seconds * 1_000,
                },
                "channel.send_attachment",
              );
            } finally {
              store.close();
            }
            recordToolSend(ctx, args.caption ?? "");
            return {
              content: [
                {
                  type: "text",
                  text: `rendered ${asset.mime} on mirror as ${id}`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `mirror attachment error: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        }

        const isGroup = isGroupSession(ctx.sessionKey);
        const to = chatIdFromKey(ctx.sessionKey);
        // Address the file at the same conversation a text would go to. Without
        // the GUID this fell through to the bare handle, and IMCore resolved it
        // to whichever chat it liked — for our own address, the note-to-self
        // thread, so the file left the building while the tool still said
        // "sent".
        const chatGuid = ctx.chatGuids[0];
        console.log(
          `[send_attachment] ${ctx.sessionKey} path=${path}${args.caption ? ` caption="${args.caption}"` : ""}`,
        );
        const res = await sendMessage({
          to,
          isGroup,
          text: args.caption,
          chatGuid,
          attachments: [path],
        });
        if (!res.ok) {
          console.error(`[send_attachment] ${ctx.sessionKey} FAILED: ${res.error}`);
          return { content: [{ type: "text", text: `send error: ${res.error}` }], isError: true };
        }
        recordToolSend(ctx, args.caption ?? "", chatGuid);
        console.log(`[send_attachment] ${ctx.sessionKey} sent ${path}`);
        return {
          content: [
            {
              type: "text",
              text: path === args.file_path ? "sent" : `sent (converted for delivery: ${path})`,
            },
          ],
        };
      },
    },
  ];
}
