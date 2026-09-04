import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ToolContext } from "../../src/mcp/context.ts";
import type { ToolDef } from "../../src/mcp/tools/types.ts";
/**
 * Fishing data platform integration.
 *
 * Every ordinary model session gets the two direct data tools. Endpoint detail
 * lives in skills/fishing so it is loaded only for a fishing question; the tool
 * descriptions carry enough routing information for the model to find that
 * skill instead of falling back to general web search.
 */
import { fishingConfig } from "./config.ts";
import { fishingBaseUrl, fishingGetImage, fishingGetJson } from "./src/client.ts";

function text(body: string, isError = false) {
  return { content: [{ type: "text" as const, text: body }], isError };
}

const QueryInput = z.object({
  path: z
    .string()
    .describe(
      "Fishing API path, e.g. '/waterbodies', '/waterbodies/5063/summary', " +
        "'/analytics/best-waters', '/gages/{id}/observations', or '/viz/schema'.",
    ),
  params: z
    .record(z.any())
    .optional()
    .describe(
      "Query params, e.g. {q:'Blue Marsh'}, {species:'largemouth',state:'PA'}, " +
        "or {near:'-76.3,40.04,40000'}. Do not put query-string text in path.",
    ),
});

const VizInput = z.object({
  path: z.string().describe("'/viz/chart' or '/viz/map'."),
  params: z
    .record(z.any())
    .optional()
    .describe("Viz params (see /viz/schema). fmt defaults to png."),
  filename: z.string().optional().describe("Optional base filename for the saved PNG."),
});

export function fishingTools(ctx: ToolContext): ToolDef[] {
  if (!fishingConfig(ctx.config)?.enabled) return [];
  const base = fishingBaseUrl(ctx.config);
  return [
    {
      name: "fishing_query",
      description:
        "Primary source for ANY mid-Atlantic (PA/MD/NJ/DE) fishing-data question: " +
        "waterbodies, species/bass composition, stocking, catch records, regulations and " +
        "motor limits, depth, access points, gages, and observed water conditions. Query " +
        "this before answering from memory or general web results. Read skill 'fishing' " +
        "for the endpoint workflow, or call path='/viz/schema' to discover chart/map fields. " +
        "Typical first lookup: path='/waterbodies' params {q:'Blue Marsh'}, then query the " +
        "returned id at '/waterbodies/{id}/summary'. Returns JSON, CSV, or text.",
      inputSchema: QueryInput,
      handler: async (args) => {
        try {
          const r = await fishingGetJson(base, args.path, args.params);
          const out = typeof r.body === "string" ? r.body : JSON.stringify(r.body, null, 2);
          if (r.ok) return text(out.slice(0, 60_000));
          const diagnostic =
            r.status >= 500 && args.path !== "/meta/health"
              ? await fishingHealthDiagnostic(base)
              : "";
          return text(
            `fishing_query failed (${r.status}) for ${args.path}: ${out.slice(0, 2_000)}${diagnostic}`,
            true,
          );
        } catch (err) {
          return text(
            `fishing_query could not reach ${base}: ${errorMessage(err)}. The fishing service or its database may be stopped; check /meta/health.`,
            true,
          );
        }
      },
    },

    {
      name: "fishing_viz",
      description:
        "Render fishing-platform data as a PNG chart or map using path='/viz/chart' or " +
        "path='/viz/map'. Call fishing_query('/viz/schema') first for valid entities, " +
        "dimensions, metrics, filters, and chart/map kinds. Saves the image in this " +
        "conversation's sandbox and returns its path; send that path to the user with " +
        "send_attachment. For raw numbers, call fishing_query on the same /viz path with " +
        "params {fmt:'json'} instead.",
      inputSchema: VizInput,
      handler: async (args) => {
        try {
          const params = { fmt: "png", ...(args.params ?? {}) };
          const r = await fishingGetImage(base, args.path, params);
          if (!r.ok || !r.base64) {
            const diagnostic = r.status >= 500 ? await fishingHealthDiagnostic(base) : "";
            return text(
              `fishing_viz failed (${r.status}) for ${args.path}: ${(r.text ?? "").slice(0, 2_000)}${diagnostic}`,
              true,
            );
          }
          const dir = join(ctx.sandboxPath, "fishing");
          mkdirSync(dir, { recursive: true });
          const safe = (args.filename ?? `viz_${Date.now()}`).replace(/[^\w.-]+/g, "_");
          const file = join(dir, safe.endsWith(".png") ? safe : `${safe}.png`);
          writeFileSync(file, Buffer.from(r.base64, "base64"));
          return {
            content: [
              { type: "image" as const, data: r.base64, mimeType: r.contentType },
              {
                type: "text" as const,
                text: `saved fishing visualization to ${file}\nsend it with send_attachment`,
              },
            ],
          };
        } catch (err) {
          return text(
            `fishing_viz could not reach ${base}: ${errorMessage(err)}. The fishing service or its database may be stopped; check /meta/health.`,
            true,
          );
        }
      },
    },
  ];
}

async function fishingHealthDiagnostic(base: string): Promise<string> {
  try {
    const health = await fishingGetJson(base, "/meta/health", undefined, 5_000);
    const body =
      typeof health.body === "string" ? health.body : JSON.stringify(health.body, null, 2);
    return `\nFishing service health (${health.status}): ${body.slice(0, 2_000)}`;
  } catch (err) {
    return `\nFishing service health check failed: ${errorMessage(err)}`;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
