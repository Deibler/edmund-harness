/**
 * Pixel Bar tools: each one is a request to the bar's own HTTP API
 * (`POST <url>/api/<tool>`, firmware/PixelBar/tools.h in the LED-BOX project).
 *
 * The bar is the authority. Brightness, the power budget, the rate limit, the
 * expiry of what is shown and the lock a person can set are all enforced in
 * its firmware, so nothing here re-implements or second-guesses them: a
 * refusal comes back as the bar's own sentence, marked as an error.
 *
 * A bar that is asleep, switched off or off the network must never cost a
 * turn more than `timeout_ms`, and never throws.
 */

import { z } from "zod";
import type { ToolContext } from "../../src/mcp/context.ts";
import type { ToolDef, ToolResult } from "../../src/mcp/tools/types.ts";
import { isConfigured, pixelbarConfig } from "./config.ts";

const text = (body: string, isError = false): ToolResult => ({
  content: [{ type: "text", text: body }],
  ...(isError ? { isError: true } : {}),
});

/** One call to the bar. `tool` is the bar's name for it; `args` go as the JSON body. */
export async function callBar(ctx: ToolContext, tool: string, args: unknown): Promise<ToolResult> {
  const cfg = pixelbarConfig(ctx.config);
  if (!isConfigured(cfg)) {
    return text("The Pixel Bar is not set up here: [pixelbar] needs its key in config.toml.", true);
  }
  let res: Response;
  let raw: string;
  try {
    res = await fetch(`${cfg.url.replace(/\/+$/, "")}/api/${tool}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify(args ?? {}),
      signal: AbortSignal.timeout(cfg.timeout_ms),
    });
    raw = await res.text();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return text(
      `The Pixel Bar did not answer (${why}). It may be asleep, switched off or off the network. Carry on without it.`,
      true,
    );
  }
  let body: { result?: unknown; error?: unknown } | null = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // not JSON: fall through with the raw text
  }
  if (res.ok) return text(typeof body?.result === "string" ? body.result : raw);
  return text(
    typeof body?.error === "string" ? body.error : `The bar answered ${res.status}.`,
    true,
  );
}

const ttl = z
  .number()
  .int()
  .positive()
  .max(3600)
  .optional()
  .describe(
    "Seconds to keep it on the bar. Default 60, at most 3600. It goes by itself after that.",
  );
const notify = z
  .boolean()
  .optional()
  .describe(
    "true: show it over whatever mode the bar is in, for at most 30 s (one per 10 s; any key on the bar dismisses it). Keep for things the person asked to be told. Otherwise it shows when the bar is in AGENT mode.",
  );
const hue = z
  .number()
  .min(0)
  .max(360)
  .optional()
  .describe(
    "Colour as a hue in degrees: 30 red-orange, 85 yellow, 150 green, 200 teal, 265 blue, 320 pink. Omit for the default.",
  );

const SCENES = [
  "low sun",
  "candles",
  "heartbeat",
  "sunrise",
  "fireplace",
  "lighthouse",
  "pendulums",
  "stained glass",
  "water",
  "aurora",
  "plasma",
  "breathing",
  "comet",
  "lava lamp",
  "ember bed",
  "ember band",
  "lava glass",
] as const;

export function pixelbarTools(ctx: ToolContext): ToolDef[] {
  if (!pixelbarConfig(ctx.config).enabled) return [];
  return [
    {
      name: "pixelbar_state",
      description:
        "Read the Pixel Bar: its mode, brightness, clock, timer, what an agent has on it, the usage meter, power, and the limits it enforces. Read-only.",
      inputSchema: z.object({}),
      handler: () => callBar(ctx, "get_state", {}),
    },
    {
      name: "pixelbar_status",
      description:
        "Show what you are doing as a soft light on the bar: idle, thinking, working, attention (you need the person), done, error. The glanceable way to say 'on it' and 'finished' without a message.",
      inputSchema: z.object({
        status: z.enum(["idle", "thinking", "working", "attention", "done", "error"]),
        note: z.string().max(60).optional().describe("A few words for the small screen on top."),
        ttl_s: ttl,
        notify,
      }),
      handler: (args) => callBar(ctx, "set_status", args),
    },
    {
      name: "pixelbar_text",
      description:
        "Show text on the bar. Up to 5 characters stand still; longer text scrolls. Capitals, digits and common punctuation (lower case is shown as capitals); at most 63 characters.",
      inputSchema: z.object({
        text: z.string().min(1).max(63),
        hue,
        ttl_s: ttl,
        notify,
      }),
      handler: (args) => callBar(ctx, "show_text", args),
    },
    {
      name: "pixelbar_progress",
      description:
        "Show a progress bar across the face. Send it again as the work advances; the bar eases to the new value.",
      inputSchema: z.object({
        fraction: z.number().min(0).max(1),
        label: z.string().max(60).optional().describe("A few words for the small screen on top."),
        hue,
        ttl_s: ttl,
      }),
      handler: (args) => callBar(ctx, "show_progress", args),
    },
    {
      name: "pixelbar_draw",
      description:
        "Draw a still 32 x 8 picture: 8 rows, top first, each a string of exactly 32 characters, and a palette giving each character a colour. Characters not in the palette are dark. Light few pixels: a full face is dim.",
      inputSchema: z.object({
        rows: z.array(z.string().length(32)).length(8),
        palette: z
          .record(z.string().length(1), z.string().regex(/^#?[0-9a-fA-F]{6}$/))
          .describe('One character -> "#rrggbb".'),
        ttl_s: ttl,
        notify,
      }),
      handler: (args) => callBar(ctx, "draw", args),
    },
    {
      name: "pixelbar_timer",
      description:
        "Start a countdown on the bar (0 cancels). It pulses gently when it ends, in any mode, until someone presses a key on it.",
      inputSchema: z.object({ seconds: z.number().int().min(0).max(86400) }),
      handler: (args) => callBar(ctx, "set_timer", args),
    },
    {
      name: "pixelbar_mode",
      description:
        "Switch what the bar shows: clock, timer, usage (Claude usage for the week, as a grid), agent (what you send), scenes (an animation: name one with scene), oasis (a lamp that follows the day: white by day, dark orange at night).",
      inputSchema: z.object({
        mode: z.enum(["clock", "timer", "usage", "agent", "scenes", "oasis"]),
        scene: z.enum(SCENES).optional().describe("With mode scenes: which animation."),
      }),
      handler: (args) => callBar(ctx, "set_mode", args),
    },
    {
      name: "pixelbar_clear",
      description: "Take down whatever an agent put on the bar.",
      inputSchema: z.object({}),
      handler: () => callBar(ctx, "clear", {}),
    },
  ];
}
