import type { Config } from "../../src/config/config.ts";
import { mirrorConfig } from "./config.ts";
import { summarizeContent } from "./src/protocol.ts";
import { MirrorStore } from "./src/store.ts";
import { UpdateInput, toContentInput } from "./tools.ts";

/**
 * Apply target for deterministic refresh scripts (applyKind
 * "mirror_content"). The daemon's RefreshWatcher resolves this via
 * integrationExport("mirror", "refresh.ts", "applyMirrorRefresh") — core
 * never imports the mirror package directly, so a harness without the
 * mirror simply has no such apply kind.
 *
 * The script's return value must be EXACTLY what update_mirror_content
 * takes (same zod schema) — the widget lands through the same store write
 * an MCP tool call would, so the orchestrator/glass pipeline is untouched.
 */
export function applyMirrorRefresh(
  dataDir: string,
  config: Config,
  value: unknown,
): { ok: true; summary: string } | { ok: false; error: string } {
  const parsed = UpdateInput.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      error: `script output failed update_mirror_content validation — ${issues}`,
    };
  }
  const store = new MirrorStore(dataDir);
  try {
    const content = store.upsertContent(
      toContentInput(parsed.data, mirrorConfig(config).default_ttl_seconds),
      "refresh.script",
    );
    return { ok: true, summary: summarizeContent(content) };
  } finally {
    store.close();
  }
}
