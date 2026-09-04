import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PEOPLE_DIR, PERSONA_DIR } from "../../claude/persona.ts";
import { appendDomainNote } from "../../persona/domains.ts";
import {
  type SelfFile,
  type SelfSection,
  appendSelfNote,
  readSelfFile,
  writeSelfFile,
} from "../../persona/self-memory.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

const SELF_SECTIONS: SelfSection[] = ["opinions", "running-bits", "tastes", "annoyances", "other"];
const SELF_FILES: SelfFile[] = ["SOUL.md", "IDENTITY.md", "AGENTS.md"];

const RememberSelfInput = z.object({
  section: z
    .enum(SELF_SECTIONS as [SelfSection, ...SelfSection[]])
    .default("other")
    .describe(
      [
        "Which evolving-character section to append under in SOUL.md:",
        "  • opinions      — positions Edmund has actually held out loud more than once",
        "  • running-bits  — inside jokes, recurring shorthand built up across threads",
        "  • tastes        — specific aesthetic preferences (authors, coffee, bands, movies)",
        "  • annoyances    — real, specific irritations Edmund has pushed back on",
        "  • other         — durable context not fitting the above (dates, project facts)",
        "",
        "Defaults to `other` when omitted.",
      ].join("\n"),
    ),
  note: z
    .string()
    .min(3)
    .describe(
      "Short prose line — the bullet body. Today's date is added automatically. Idempotent: if the same text already exists under this section, no-op.",
    ),
});

const ReadSelfInput = z.object({
  file: z
    .enum(SELF_FILES as [SelfFile, ...SelfFile[]])
    .default("SOUL.md")
    .describe("Which self-memory file to read."),
});

const UpdateSelfInput = z.object({
  file: z
    .enum(SELF_FILES as [SelfFile, ...SelfFile[]])
    .describe("Which self-memory file to overwrite."),
  body: z
    .string()
    .min(20)
    .describe(
      "FULL new Markdown contents. Replaces everything. Previous version is backed up as <file>.md.bak. Standard flow: read_self_memory → revise locally → update_self_memory.",
    ),
});

const SNIPPET_CHARS = 400;
const MAX_RESULTS = 8;
const MIN_SCORE = 0.05;

const SearchInput = z.object({
  query: z.string().describe("Keywords or phrase to search across persona memory files."),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe(`Maximum results to return (default ${MAX_RESULTS}).`),
});

type MemoryChunk = {
  source: string; // filename, e.g. "IDENTITY.md" or "people/jordan.md"
  text: string;
  score: number;
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function scoreChunk(chunk: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const words = tokenize(chunk);
  if (words.length === 0) return 0;
  const wordSet = new Set(words);
  const tf = new Map<string, number>();
  for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);

  let score = 0;
  for (const qt of queryTokens) {
    const count = tf.get(qt) ?? 0;
    if (count > 0) {
      // TF component (normalized)
      score += count / words.length;
      // Exact phrase bonus
      if (wordSet.has(qt)) score += 0.1;
    }
    // Partial match
    for (const w of wordSet) {
      if (w.includes(qt) && w !== qt) score += 0.02;
    }
  }
  return score / queryTokens.length;
}

function extractSnippet(text: string, queryTokens: string[], maxChars: number): string {
  const lower = text.toLowerCase();
  let bestPos = 0;
  let bestCount = 0;
  const step = 50;

  for (let i = 0; i < lower.length; i += step) {
    const window = lower.slice(i, i + maxChars);
    let count = 0;
    for (const qt of queryTokens) {
      if (window.includes(qt)) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestPos = i;
    }
  }

  const start = Math.max(0, bestPos - 20);
  const end = Math.min(text.length, start + maxChars);
  const snippet = text.slice(start, end).trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${snippet}${suffix}`;
}

function loadPersonaFiles(): Array<{ source: string; text: string }> {
  const files: Array<{ source: string; text: string }> = [];

  // Top-level persona files
  for (const name of ["IDENTITY.md", "SOUL.md", "AGENTS.md"]) {
    const path = join(PERSONA_DIR, name);
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8").trim();
      if (text) files.push({ source: name, text });
    }
  }

  // People files
  if (existsSync(PEOPLE_DIR)) {
    for (const entry of readdirSync(PEOPLE_DIR)) {
      if (!entry.endsWith(".md") || entry.endsWith(".bak")) continue;
      const path = join(PEOPLE_DIR, entry);
      const text = readFileSync(path, "utf8").trim();
      if (text) files.push({ source: `people/${entry}`, text });
    }
  }

  return files;
}

function splitIntoChunks(text: string, maxChunkChars = 600): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (!para.trim()) continue;
    if (current.length + para.length + 2 > maxChunkChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += (current ? "\n\n" : "") + para;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** A lesson about a subject. `outcome` is mandatory and includes REJECTED —
 *  ReasoningBank's finding is that failed episodes carry the signal an article
 *  never will, so the schema refuses to let a note omit what actually
 *  happened. */
const RememberSubjectInput = z.object({
  domain: z
    .string()
    .min(3)
    .describe('Subject, plain words. "endurance training", "short-form content".'),
  title: z.string().min(8).describe("The lesson as a claim, one line. Deduped on this."),
  applies: z.string().min(8).describe("Conditions it holds under — and where it does not."),
  learned: z.string().min(12).describe("What was tried and what actually happened."),
  outcome: z
    .enum(["worked", "rejected", "mixed", "untested"])
    .describe(
      "What happened when this met reality. Record rejections, they are the valuable ones.",
    ),
  source: z
    .string()
    .optional()
    .describe("Who/when it came from, so one-person claims stay visible."),
});

export function memoryTools(_ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "remember_about_subject",
      description: [
        "Record something you learned about a SUBJECT — endurance training, short-form content, fantasy football, whatever you actually practise. This is how expertise compounds instead of resetting: person files make you specific about someone, this makes you better at the thing.",
        "",
        "When to use: you reasoned something out and it held up, you gave advice and watched what happened, or a piece of conventional wisdom failed in practice. Record REJECTIONS and FAILURES too — 'told a runner to drop lifting, ignored every time' is worth more than a citation, because no article will tell you that.",
        "",
        "NOT for facts about one person (use remember_about_person) or about yourself (remember_about_self). The test: would this still be useful with a different person, next year? Then it belongs here.",
        "",
        "Indexed globally, so it surfaces by recall in any conversation, not just the one it came from.",
      ].join("\n"),
      inputSchema: RememberSubjectInput,
      handler: (args) => {
        try {
          const { path, appended } = appendDomainNote({
            domain: args.domain,
            title: args.title,
            applies: args.applies,
            learned: args.learned,
            outcome: args.outcome,
            source: args.source,
          });
          return {
            content: [
              {
                type: "text",
                text: appended
                  ? `recorded in ${path}`
                  : `no-op: "${args.title}" already recorded in ${path}`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              { type: "text", text: `remember_about_subject failed: ${(err as Error).message}` },
            ],
            isError: true,
          };
        }
      },
    },
    {
      name: "remember_about_self",
      description: [
        "Append a dated note to one of the evolving-character sections of SOUL.md. This is how you accrete identity over time — opinions you've held publicly, running bits, tastes, things that bug you, durable facts.",
        "",
        "When to use: a position you've stated more than once, a recurring joke that landed, a preference you keep coming back to, a real irritation you've pushed back on. NOT for one-off observations or things specific to one person (use `remember_about_person` for those).",
        "",
        "The bullet is dated automatically. Re-running with the same text under the same section is a no-op (idempotent), so it's safe to restate if you're not sure. Hot-read: takes effect on the next turn, no restart needed.",
      ].join("\n"),
      inputSchema: RememberSelfInput,
      handler: (args) => {
        try {
          const { path, appended } = appendSelfNote({ section: args.section, note: args.note });
          return {
            content: [
              {
                type: "text",
                text: appended
                  ? `appended to ${path} (${args.section})`
                  : `no-op: already present under ${args.section} in ${path}`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              { type: "text", text: `remember_about_self failed: ${(err as Error).message}` },
            ],
            isError: true,
          };
        }
      },
    },
    {
      name: "read_self_memory",
      description:
        "Read the current contents of a self-memory file (SOUL.md, IDENTITY.md, or AGENTS.md). AGENTS.md is the full operating-rules document; it is NOT auto-injected into the system prompt to save tokens, so reach for it via this tool when you need to consult red lines, tool discipline, group/DM behavior nuance, etc. SOUL.md and IDENTITY.md ARE auto-injected; read them here when you want to restructure or trim them via `update_self_memory`.",
      inputSchema: ReadSelfInput,
      handler: (args) => {
        const text = readSelfFile(args.file);
        if (!text)
          return { content: [{ type: "text", text: `(no contents yet for ${args.file})` }] };
        return { content: [{ type: "text", text }] };
      },
    },
    {
      name: "update_self_memory",
      description: [
        "Replace a self-memory file wholesale with new Markdown. Use for restructuring (renaming sections, merging duplicates), trimming dead scaffolding, or any edit more complex than appending a bullet — for which `remember_about_self` is much cheaper.",
        "",
        "The previous version is auto-backed-up as <file>.md.bak.",
        "",
        "Standard flow:",
        "  1. read_self_memory(file)",
        "  2. Revise the markdown in your head",
        "  3. update_self_memory(file, body=<full new markdown>)",
        "",
        "Hot-read — takes effect on the next turn.",
      ].join("\n"),
      inputSchema: UpdateSelfInput,
      handler: (args) => {
        try {
          const { path, backupPath } = writeSelfFile(args.file, args.body);
          return {
            content: [
              {
                type: "text",
                text: `wrote ${path} (${args.body.length} chars${backupPath ? `, previous version backed up to ${backupPath}` : ""})`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              { type: "text", text: `update_self_memory failed: ${(err as Error).message}` },
            ],
            isError: true,
          };
        }
      },
    },
    {
      name: "memory_search",
      description:
        "Search across all persona memory files (identity, soul, agents, memory, and all people files) for information matching your query. Use to recall facts about people, preferences, relationship history, or any stored context.",
      inputSchema: SearchInput,
      handler: (args) => {
        const maxResults = args.max_results ?? MAX_RESULTS;
        const queryTokens = tokenize(args.query);

        if (queryTokens.length === 0) {
          return {
            content: [{ type: "text", text: "Query is empty — provide keywords to search." }],
            isError: true,
          };
        }

        const personaFiles = loadPersonaFiles();
        const scored: MemoryChunk[] = [];

        for (const { source, text } of personaFiles) {
          const chunks = splitIntoChunks(text);
          for (const chunk of chunks) {
            const score = scoreChunk(chunk, queryTokens);
            if (score >= MIN_SCORE) {
              scored.push({ source, text: chunk, score });
            }
          }
        }

        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, maxResults);

        if (top.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No matches found for: ${args.query}`,
              },
            ],
          };
        }

        const lines = top.map((c, i) => {
          const snippet = extractSnippet(c.text, queryTokens, SNIPPET_CHARS);
          return `[${i + 1}] ${c.source}\n${snippet}`;
        });

        return {
          content: [
            {
              type: "text",
              text: `Memory search results for "${args.query}":\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      },
    },
  ];
}
