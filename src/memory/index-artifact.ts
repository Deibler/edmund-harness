/**
 * Helper for indexing one-off artifacts into the recall store from
 * places other than the periodic Indexer — generated images/videos,
 * sandbox text files, etc.
 *
 * Designed to be safe to call from the bg-runner subprocess: opens its
 * own VectorStore handle (bun:sqlite WAL allows concurrent writers),
 * uses the configured embedding provider, swallows failures so
 * indexing never blocks the caller's primary work.
 *
 * Three convenience entrypoints:
 *
 *   - `indexGeneratedMedia(...)` — used by image/video/audio generation
 *     tools. Embeds the prompt + media-type tag.
 *   - `indexSandboxFile(...)` — used by the sandbox-artifact walker.
 *     Embeds file content (truncated) + path + mtime.
 *   - `indexArtifact(...)` — low-level, for custom callers.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "../config/config.ts";
import type { ChatDb } from "../imessage/db.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import type { SessionKey } from "../sessions/key.ts";
import { chatGuidsForSession } from "../sessions/session-scope.ts";
import { log } from "../util/log.ts";
import { makeProvider } from "./embed-provider.ts";
import { type RowKind, VectorStore, normalize } from "./vector-store.ts";

type IndexArtifactArgs = {
  config: Config;
  /** Pre-built chat.guid value — when available, preferred over lookup. */
  chatGuid?: string | null;
  /** Used to derive chat.guid when `chatGuid` not provided. */
  sessionKey?: SessionKey;
  chatDb?: ChatDb;
  contacts?: ContactBook;
  /** Stable identifier for the row. Use a path-derived or
   *  prompt-derived key so re-runs are idempotent (INSERT OR REPLACE). */
  ref: string;
  kind: RowKind;
  /** Pre-built embed text. Will be truncated to max_chars. */
  text: string;
  /** Author label. Defaults to "me" (the assistant). */
  sender?: string;
  /** Timestamp. Defaults to Date.now(). */
  tsMs?: number;
};

/** Best-effort artifact index. Returns true on success, false on any
 *  failure (recall disabled, embed error, write error). */
async function indexArtifact(args: IndexArtifactArgs): Promise<boolean> {
  const cfg = args.config.memory_recall;
  if (!cfg.enabled || cfg.provider === "none") return false;

  const trimmed = args.text.trim().slice(0, cfg.max_chars);
  if (trimmed.length < cfg.min_chars) return false;

  const chatGuid = resolveChatGuid(args);
  if (!chatGuid) {
    log.debug("recall", "skipping artifact: no chat guid resolved", { ref: args.ref });
    return false;
  }

  const provider = makeProvider({
    provider: cfg.provider,
    model: cfg.model,
    dim: cfg.dim,
    ollamaEndpoint: cfg.ollama_endpoint,
    openaiKey: args.config.keys.openai,
  });

  let vec: Float32Array;
  try {
    const r = await provider.embed([trimmed]);
    if (r.vectors.length === 0) return false;
    vec = normalize(r.vectors[0]!);
  } catch (err) {
    log.warn("recall", "artifact embed failed", {
      ref: args.ref,
      err: (err as Error).message,
    });
    return false;
  }

  const dbPath = resolve(args.config.paths.data_dir, cfg.index_db);
  const store = new VectorStore(dbPath);
  try {
    store.upsert([
      {
        ref: args.ref,
        kind: args.kind,
        chatGuid,
        sender: args.sender ?? "me",
        ts: args.tsMs ?? Date.now(),
        text: trimmed,
        vec,
        model: cfg.model,
      },
    ]);
    log.info("recall", "indexed artifact", {
      ref: args.ref,
      kind: args.kind,
      chars: trimmed.length,
    });
    return true;
  } catch (err) {
    log.warn("recall", "artifact upsert failed", {
      ref: args.ref,
      err: (err as Error).message,
    });
    return false;
  } finally {
    store.close();
  }
}

/**
 * Index a generated image/video/audio file with its prompt. The prompt
 * is what the model "described" — that's what the user will search for
 * later ("the picture I made of the dog in the hat").
 */
export async function indexGeneratedMedia(args: {
  config: Config;
  sessionKey: SessionKey;
  /** "image" | "video" | "audio" */
  kind: "image" | "video" | "audio";
  /** Absolute path to the produced file. Used as the row's `ref`. */
  filePath: string;
  /** The text prompt the model used. */
  prompt: string;
  /** Optional model id for transparency in the embed text. */
  model?: string;
}): Promise<boolean> {
  const mediaTag = `[generated ${args.kind}]`;
  const modelTag = args.model ? ` (model: ${args.model})` : "";
  const text = `${mediaTag}${modelTag} ${args.prompt}`.trim();
  // Lazy-construct ChatDb + ContactBook so the bg-runner doesn't have
  // to thread them through. Cheap — both are read-only sqlite handles
  // and the bg-runner exits after a single tool result.
  const { ChatDb } = await import("../imessage/db.ts");
  const { AddressBook } = await import("../sessions/address-book.ts");
  const { ContactBook } = await import("../sessions/contacts.ts");
  let chatDb: ChatDb;
  try {
    chatDb = new ChatDb(args.config.paths.chat_db);
  } catch {
    return false;
  }
  const contacts = new ContactBook(args.config.contacts, new AddressBook());
  try {
    return await indexArtifact({
      config: args.config,
      sessionKey: args.sessionKey,
      chatDb,
      contacts,
      ref: `artifact:${args.filePath}`,
      kind: "artifact",
      text,
    });
  } finally {
    chatDb.close();
  }
}

function resolveChatGuid(args: IndexArtifactArgs): string | null {
  if (args.chatGuid) return args.chatGuid;
  if (!args.sessionKey || !args.chatDb || !args.contacts) return null;
  try {
    const guids = chatGuidsForSession(args.sessionKey, args.chatDb, args.contacts);
    return guids[0] ?? null;
  } catch {
    return null;
  }
}

/** Re-exported for the sandbox-artifact walker (next task). */
function fileMtimeMs(path: string): number | null {
  try {
    if (!existsSync(path)) return null;
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
