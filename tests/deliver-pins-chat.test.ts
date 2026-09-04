import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every deliverReply call must pin the chat row.
 *
 * A DM addressed by bare handle leaves the pick to IMCore's registry. On this
 * account — which has no phone number, so its only identity is the Apple ID
 * email — the registry resolves such a send onto the note-to-self thread, and
 * the bridge refuses it as `chat_mismatch`. The message never goes.
 *
 * This was found, understood and fixed once already, in cron/fire.ts, whose
 * comment reads "Both of today's misdelivered sends were cron deliveries
 * missing this pin." The fix was applied to that one call site. Five others
 * kept sending unpinned — proactive/fire.ts, recovery/turn.ts, the guest-cap
 * decline, and three dashboard-tunnel notices — and went on failing for weeks
 * while the investigation looked at IMCore, at macOS Tahoe, and at the chat
 * GUID format.
 *
 * A comment could not keep the invariant. This can: the next send path added
 * without a pin fails here instead of in production.
 */

const SRC = join(import.meta.dir, "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** The argument object of each deliverReply call, by brace matching. */
function deliverCallArgs(source: string): string[] {
  const calls: string[] = [];
  const re = /deliverReply\(/g;
  let m: RegExpExecArray | null = re.exec(source);
  for (; m !== null; m = re.exec(source)) {
    const open = source.indexOf("{", m.index);
    if (open < 0) continue;
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          calls.push(source.slice(open, i + 1));
          break;
        }
      }
    }
  }
  return calls;
}

describe("every deliverReply pins the chat row", () => {
  test("no send addresses a conversation by bare handle", () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      // deliver.ts is the implementation, not a caller.
      if (file.endsWith(join("channels", "deliver.ts"))) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("deliverReply(")) continue;

      for (const args of deliverCallArgs(source)) {
        // A mirror send is not an iMessage conversation and has no chat row.
        if (args.includes('"mirror:') || args.includes("mirror:")) continue;
        // Must be an object PROPERTY (`chatGuid:` or shorthand `chatGuid,`),
        // not merely the substring — the group ternary on the `to:` line reads
        // `session.chatGuid`, which made a naive includes() check pass for
        // every unpinned call and produced a test that could not fail.
        if (!/(^|[^.\w])chatGuid\s*[,:]/.test(args)) {
          offenders.push(`${file.replace(SRC, "src")}: ${args.replace(/\s+/g, " ").slice(0, 110)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
