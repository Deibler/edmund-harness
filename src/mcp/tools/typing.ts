import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { invoke } from "../../imessage/bridge/index.ts";
import type { MirrorStoreCtor } from "../../integrations/mirror-contracts.ts";
import { integrationExport } from "../../integrations/optional.ts";
import { isMirrorSession } from "../../sessions/key.ts";
import { chatIdFromKey, isGroupSession } from "../../sessions/key.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

/**
 * Model-controlled typing indicator. The model calls `activate_typing` when
 * it's starting real work (research, generation, multi-tool chains) so the
 * user sees live bubbles instead of silence.
 *
 * One call starts a detached heartbeat process that re-sets the indicator
 * every few seconds for up to 90s. Idempotent — a second call kills the prior
 * heartbeat and starts fresh (so the bubble never double-pumps). The outbound
 * reply naturally clears the bubble on the receiver side; no explicit stop
 * needed.
 */

const HEARTBEAT_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "scripts",
  "typing-heartbeat.ts",
);

const ActivateInput = z.object({
  seconds: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe(
      "Optional: show typing for exactly this many seconds, then stop on its own — a deliberate 'beat' before a short reply (hesitating, reconsidering). Omit for the default behavior: keep bubbles alive for up to 90s while you do real work, auto-clearing when your reply lands.",
    ),
});

export function typingTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "activate_typing",
      description:
        "Show 'typing…' bubbles in the current iMessage conversation. Two modes: (1) no args — keeps bubbles visible for up to 90s while you do real work; call this FIRST, before list_skills / read_skill / generate_image / long research, whenever the turn will take more than a couple seconds; the bubble clears automatically when your reply lands; safe to re-call to reset the heartbeat. (2) `seconds: N` — a short deliberate beat (≤20s) that stops on its own, for when you want to look like you paused to think before a quick reply. Don't bother for trivial one-liner turns with no real delay.",
      inputSchema: ActivateInput,
      handler: async (args) => {
        if (isMirrorSession(ctx.sessionKey)) {
          const mirrorFrameId = await integrationExport<(k: string) => string>(
            "mirror",
            "src/protocol.ts",
            "mirrorFrameId",
          );
          const MirrorStore = await integrationExport<MirrorStoreCtor>(
            "mirror",
            "src/store.ts",
            "MirrorStore",
          );
          if (!mirrorFrameId || !MirrorStore)
            return { content: [{ type: "text", text: "mirror integration not installed" }] };
          const id = mirrorFrameId("thinking");
          const store = new MirrorStore(ctx.dataDir);
          try {
            store.enqueueCommand({
              v: 2,
              id,
              type: "overlay_set",
              overlay: { phase: "thinking" },
            });
          } finally {
            store.close();
          }
          return {
            content: [{ type: "text" as const, text: `mirror thinking state queued (${id})` }],
          };
        }
        // Prefer the session's resolved chat GUID: a bare handle leaves the
        // pick to IMCore's registry, and a poisoned registry entry points a
        // DM's indicator at the note-to-self thread instead of the person.
        const target = ctx.chatGuids[0] ?? chatIdFromKey(ctx.sessionKey);
        const isGroup = isGroupSession(ctx.sessionKey);

        // Bounded "beat": set the indicator, then clear it after the requested
        // pause. IMCore has no duration, and an indicator outlives whoever set
        // it, so the clear is explicit rather than left to lapse.
        if (args.seconds != null) {
          await invoke("typing", { chat: target, typing: true });
          const clearAfterMs = args.seconds * 1000;
          setTimeout(() => {
            void invoke("typing", { chat: target, typing: false }).catch(() => {});
          }, clearAfterMs).unref?.();
          console.log(
            `[activate_typing] ${ctx.sessionKey} target=${target} isGroup=${isGroup} beat=${args.seconds}s`,
          );
          return { content: [{ type: "text" as const, text: `typing for ${args.seconds}s` }] };
        }

        const dataDir = process.env.EDMUND_DATA_DIR ?? resolve("data");
        const heartbeatDir = join(dataDir, "typing-heartbeats");
        if (!existsSync(heartbeatDir)) mkdirSync(heartbeatDir, { recursive: true });
        const sanitizedKey = ctx.sessionKey.replace(/[^a-zA-Z0-9]+/g, "_");
        const pidFile = join(heartbeatDir, `${sanitizedKey}.pid`);

        // Kill any prior heartbeat so re-calls don't stack.
        if (existsSync(pidFile)) {
          const prev = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
          if (Number.isFinite(prev)) {
            try {
              process.kill(prev, "SIGTERM");
            } catch {
              // already dead; fine
            }
          }
          try {
            rmSync(pidFile);
          } catch {}
        }

        const child = spawn("bun", [HEARTBEAT_SCRIPT], {
          env: {
            ...process.env,
            TYPING_CHAT: target,
            TYPING_PIDFILE: pidFile,
          },
          detached: true,
          stdio: "ignore",
        });
        child.unref();

        if (child.pid) writeFileSync(pidFile, String(child.pid));
        console.log(
          `[activate_typing] ${ctx.sessionKey} target=${target} isGroup=${isGroup} pid=${child.pid}`,
        );

        return { content: [{ type: "text" as const, text: "typing indicator active" }] };
      },
    },
  ];
}
