import { existsSync } from "node:fs";
import { z } from "zod";
import { runClaudeOneShot } from "../../claude/one-shot.ts";
import { assertPathSafe } from "../../util/path-safety.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

const BlindCheckInput = z.object({
  image_path: z.string().describe("Absolute path of a rendered image (PNG/JPG) to check."),
});

/**
 * A look at a render by a model that is not told what it should be. The
 * model that made a thing sees what it meant to make: a cow ornament with two
 * heads went through twelve renders unnoticed (2026-10), and vision models
 * asked to double-check their own expected subject barely improve, while one
 * that must describe it cold reports the second head. Counting is the point.
 */
export const BLIND_CHECK_PROMPT = [
  "Read the image at the path given and describe exactly what is in it, as if to someone who cannot see it.",
  "You have not been told what it is supposed to be; do not guess an intent.",
  "Count every repeated part you can see (heads, eyes, ears, legs, arms, hands, fingers, wheels, windows, letters) and give each count as a number.",
  "List anything malformed, merged, duplicated, floating, cut off or missing, and any text exactly as written (note misspellings).",
  "Plain sentences, no preamble.",
].join(" ");

export function blindCheckTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "blind_check",
      description:
        "Get a cold description of a render from a fresh model that is NOT told what it should be: what it is, counts of every repeated part (heads, legs, fingers, letters), and anything malformed, duplicated or misspelled. Run it before sending any render of a creature, person or object with parts, and compare its counts with what you meant to make. Your own second look misses the same things the first did.",
      inputSchema: BlindCheckInput,
      handler: async (args) => {
        try {
          assertPathSafe(args.image_path);
        } catch (err) {
          return { content: [{ type: "text", text: (err as Error).message }], isError: true };
        }
        if (!existsSync(args.image_path)) {
          return {
            content: [{ type: "text", text: `file not found: ${args.image_path}` }],
            isError: true,
          };
        }
        const model = ctx.config.claude.agent_model || ctx.config.claude.model;
        const r = await runClaudeOneShot({
          args: [
            "--model",
            model,
            "--tools",
            "Read",
            "--permission-mode",
            "bypassPermissions",
            "--append-system-prompt",
            BLIND_CHECK_PROMPT,
          ],
          input: `Image: ${args.image_path}`,
          timeoutMs: 120_000,
        });
        if (!r.ok || !r.text.trim()) {
          return {
            content: [{ type: "text", text: `blind check failed: ${r.error ?? "no description"}` }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: `Cold description:\n${r.text.trim()}` }] };
      },
    },
  ];
}
