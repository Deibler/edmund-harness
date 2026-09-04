import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

const VALID_TOOL_ID = /^[A-Za-z0-9_-]+$/;

export type SessionRepairResult = {
  changed: boolean;
  toolUseIds: number;
  toolResultIds: number;
  backupPath: string | null;
};

/**
 * Repair tool ids emitted by providers that did not enforce Anthropic's id
 * grammar. Both sides of each tool_use/tool_result pair are rewritten with
 * the same deterministic value, preserving the conversation relationship.
 *
 * The rewrite is atomic and the first changed version is retained beside the
 * transcript as `<session>.pre-direct.bak`.
 */
export function repairSessionToolIds(filePath: string): SessionRepairResult {
  if (!existsSync(filePath)) {
    return { changed: false, toolUseIds: 0, toolResultIds: 0, backupPath: null };
  }

  const original = readFileSync(filePath, "utf8");
  const lines = original.split("\n");
  let toolUseIds = 0;
  let toolResultIds = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      const record = JSON.parse(line) as unknown;
      const repaired = repairRecord(record);
      toolUseIds += repaired.toolUseIds;
      toolResultIds += repaired.toolResultIds;
      if (repaired.toolUseIds > 0 || repaired.toolResultIds > 0) {
        lines[i] = JSON.stringify(record);
      }
    } catch {
      // Keep malformed/non-JSON lines byte-for-byte; Claude Code owns the
      // surrounding transcript format and may tolerate records we do not.
    }
  }

  if (toolUseIds === 0 && toolResultIds === 0) {
    return { changed: false, toolUseIds: 0, toolResultIds: 0, backupPath: null };
  }

  const mode = statSync(filePath).mode & 0o777;
  const backupPath = `${filePath}.pre-direct.bak`;
  if (!existsSync(backupPath)) copyFileSync(filePath, backupPath);

  const tmpPath = `${filePath}.repair-${process.pid}.tmp`;
  writeFileSync(tmpPath, lines.join("\n"));
  try {
    renameSync(tmpPath, filePath);
    if (mode) chmodSync(filePath, mode);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw err;
  }

  return { changed: true, toolUseIds, toolResultIds, backupPath };
}

export function repairedToolId(id: string): string {
  if (VALID_TOOL_ID.test(id)) return id;
  const readable = id.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 10);
  return `${readable}_${digest}`;
}

function repairRecord(value: unknown): { toolUseIds: number; toolResultIds: number } {
  if (!value || typeof value !== "object") return { toolUseIds: 0, toolResultIds: 0 };
  if (Array.isArray(value)) {
    return value.reduce(
      (total, item) => {
        const next = repairRecord(item);
        total.toolUseIds += next.toolUseIds;
        total.toolResultIds += next.toolResultIds;
        return total;
      },
      { toolUseIds: 0, toolResultIds: 0 },
    );
  }

  const record = value as Record<string, unknown>;
  let toolUseIds = 0;
  let toolResultIds = 0;
  if (
    record.type === "tool_use" &&
    typeof record.id === "string" &&
    !VALID_TOOL_ID.test(record.id)
  ) {
    record.id = repairedToolId(record.id);
    toolUseIds++;
  }
  if (typeof record.tool_use_id === "string" && !VALID_TOOL_ID.test(record.tool_use_id)) {
    record.tool_use_id = repairedToolId(record.tool_use_id);
    toolResultIds++;
  }

  for (const child of Object.values(record)) {
    const next = repairRecord(child);
    toolUseIds += next.toolUseIds;
    toolResultIds += next.toolResultIds;
  }
  return { toolUseIds, toolResultIds };
}
