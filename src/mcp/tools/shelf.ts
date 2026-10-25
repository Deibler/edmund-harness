import { z } from "zod";
import { shelveFile } from "../../shelf/shelf.ts";
import { assertPathSafe } from "../../util/path-safety.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

const ShelveInput = z.object({
  file_path: z
    .string()
    .describe("Absolute path of the file to keep (usually in this chat's sandbox)."),
  title: z
    .string()
    .optional()
    .describe('How it is listed on their shelf, e.g. "SEPTA study kit, week 3".'),
});

/**
 * `shelve`: put a finished file on this chat's shelf and get a link that does
 * not expire (see src/shelf/shelf.ts for why).
 */
export function shelfTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "shelve",
      description:
        "Put a finished file (page, PDF, video, image, printable, game) on this person's shelf and get a PERMANENT link to it, plus the link to their shelf page listing everything you have made for them, newest first. Use it for anything they will open later or come back to, instead of a temporary tunnel link (those die within days). Send the file link; mention the shelf link the first time.",
      inputSchema: ShelveInput,
      handler: (args) => {
        try {
          assertPathSafe(args.file_path);
        } catch (err) {
          return { content: [{ type: "text", text: (err as Error).message }], isError: true };
        }
        const origin = ctx.config.shelf?.origin?.trim() ?? "";
        if (!origin) {
          return {
            content: [
              {
                type: "text",
                text: "No shelf is configured on this machine ([shelf] origin is empty). Send the file itself with send_attachment instead of a link.",
              },
            ],
            isError: true,
          };
        }
        try {
          const r = shelveFile({
            dataDir: ctx.dataDir,
            sessionKey: ctx.sessionKey,
            src: args.file_path,
            origin,
            title: args.title,
          });
          return {
            content: [
              { type: "text", text: `on their shelf: ${r.url}\ntheir shelf page: ${r.shelfUrl}` },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `shelve failed: ${(err as Error).message}` }],
            isError: true,
          };
        }
      },
    },
  ];
}
