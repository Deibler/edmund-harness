import { z } from "zod";
import { readPersonFile, writePersonFile } from "../../persona/crud.ts";
import { type PersonSection, appendPersonNote } from "../../persona/write-note.ts";
import { chatIdFromKey, isGroupSession, normalizeHandle } from "../../sessions/key.ts";
import { LearnedNames, vetLearnedName } from "../../sessions/learned-names.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

const SECTIONS: PersonSection[] = [
  "who-they-are",
  "our-dynamic",
  "what-ive-learned",
  "shared-history",
  "open-items",
];

const NoteInput = z.object({
  handle: z
    .string()
    .optional()
    .describe(
      "Handle of the person (phone E.164 or email). REQUIRED in groups. In DMs, omit to auto-target the contact.",
    ),
  section: z
    .enum(SECTIONS as [PersonSection, ...PersonSection[]])
    .default("what-ive-learned")
    .describe(
      [
        "Section to append under; one of these five exactly. Dates are added automatically.",
        "  • who-they-are      — personality, background, what they care about",
        "  • our-dynamic       — how they like to be talked to; your posture with them",
        "  • what-ive-learned  — preferences, quirks, recurring topics (the default)",
        "  • shared-history    — dated events worth remembering",
        "  • open-items        — follow-ups, promises, loose ends",
        "There is no 'preferences' section: preferences go in what-ive-learned.",
      ].join("\n"),
    ),
  note: z.string().min(1).describe("Short prose line to append."),
});

const ReadInput = z.object({
  handle: z
    .string()
    .optional()
    .describe("Handle (phone E.164 or email). Omit in DMs to auto-target."),
});

const WriteInput = z.object({
  handle: z
    .string()
    .optional()
    .describe("Handle (phone E.164 or email). REQUIRED in groups. Omit in DMs to auto-target."),
  body: z
    .string()
    .min(20)
    .describe(
      "The FULL new Markdown contents of the file. Replaces everything. The previous version is backed up as <file>.md.bak. Typical flow: read_person_file → modify locally → write_person_file with the full new text.",
    ),
});

const NameInput = z.object({
  handle: z
    .string()
    .min(1)
    .describe("The person's phone (E.164) or email, as the roster or transcript shows it."),
  name: z
    .string()
    .describe("What they go by, e.g. 'Pat'. An empty string forgets a name set earlier."),
});

export function personTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "remember_about_person",
      description: [
        "Quick append: drop a dated note into one of the standard sections. Use this for small additions; for restructuring, rewriting, or deleting content, use `write_person_file` instead.",
        "",
        "⚠️ CROSS-CHAT: notes here are injected into every future conversation involving this person (DMs with them, groups they're in, conversations where others mention them). See `remember_about_person` safety rules in AGENTS.md.",
      ].join("\n"),
      inputSchema: NoteInput,
      handler: (args) => {
        const handle = args.handle ?? deriveDmHandle(ctx);
        if (!handle) return errorResult("handle required in group sessions");
        const displayName = ctx.contacts.displayName(handle);
        const path = appendPersonNote({
          handle,
          displayName,
          section: args.section,
          note: args.note,
        });
        return textResult(`appended to ${path} (${args.section})`);
      },
    },
    {
      name: "name_person",
      description: [
        "Record what someone goes by when the operator's contacts have no name for their number: typically someone in a group introduced as 'the 0001 number is Pat'. From then on every roster and transcript, in every chat, shows them as 'Pat (+1…)' instead of a bare number, so you no longer have to work out who it is each turn.",
        "Only for numbers with no contact name, and never a name that already belongs to one of the operator's contacts. Use what the person or the group actually calls them; don't guess. Pass an empty name to forget it.",
      ].join("\n"),
      inputSchema: NameInput,
      handler: (args) => {
        const handle = normalizeHandle(args.handle);
        if (!handle) return errorResult("handle required");
        const own = [...ctx.config.self.handles, ctx.config.sms.from ?? ""]
          .map(normalizeHandle)
          .filter(Boolean);
        if (own.includes(handle)) return errorResult("that is your own address");
        const known = ctx.contacts.displayName(handle);
        if (known) return errorResult(`${handle} is already in contacts as ${known}`);
        const store = new LearnedNames(ctx.dataDir);
        try {
          if (!args.name.trim()) {
            return textResult(
              store.forget(handle)
                ? `forgot the name for ${handle}`
                : `no name was set for ${handle}`,
            );
          }
          const vetted = vetLearnedName(args.name);
          if (!vetted.ok) return errorResult(`not saved: ${vetted.reason}`);
          const lower = vetted.name.toLowerCase();
          if (ctx.contacts.allKnownNames().some((n) => n.trim().toLowerCase() === lower)) {
            return errorResult(
              `not saved: "${vetted.name}" is already the name of one of the operator's contacts`,
            );
          }
          store.set(handle, vetted.name, ctx.sessionKey);
          return textResult(`saved: ${handle} now shows as ${vetted.name} (${handle})`);
        } finally {
          store.close();
        }
      },
    },
    {
      name: "read_person_file",
      description:
        "Fetch the current contents of a person's memory file. Use before `write_person_file` when you need to edit, restructure, or remove content.",
      inputSchema: ReadInput,
      handler: (args) => {
        const handle = args.handle ?? deriveDmHandle(ctx);
        if (!handle) return errorResult("handle required in group sessions");
        const file = readPersonFile(handle);
        if (!file) return textResult(`(no file yet for ${handle})`);
        return textResult(file.body);
      },
    },
    {
      name: "write_person_file",
      description: [
        "Replace a person's memory file wholesale with new Markdown. Use for restructuring, removing stale notes, merging duplicates, or any edit more complex than a simple append. The previous version is auto-backed-up as <file>.md.bak.",
        "",
        "Standard flow:",
        "  1. read_person_file(handle)",
        "  2. Build the new body in your head — keep the scaffold headings (Who They Are, Our Dynamic, What I've Learned, Shared History, Open Items).",
        "  3. write_person_file(handle, body=<full new Markdown>)",
        "",
        "⚠️ CROSS-CHAT — same privacy rules as remember_about_person. Never write secrets, confidences, or content that would embarrass the person if re-surfaced in another conversation.",
      ].join("\n"),
      inputSchema: WriteInput,
      handler: (args) => {
        const handle = args.handle ?? deriveDmHandle(ctx);
        if (!handle) return errorResult("handle required in group sessions");
        const displayName = ctx.contacts.displayName(handle);
        const path = writePersonFile({ handle, displayName, body: args.body });
        return textResult(`wrote ${path} (${args.body.length} chars, previous version backed up)`);
      },
    },
  ];
}

function deriveDmHandle(ctx: ToolContext): string | null {
  if (isGroupSession(ctx.sessionKey)) return null;
  return chatIdFromKey(ctx.sessionKey);
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
