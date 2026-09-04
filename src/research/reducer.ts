/**
 * Reducer-side helpers for deep research. These run *inside* the
 * synthesizer agent's task and are also useful for the main model
 * when it picks up the team output. Kept pure so unit tests can
 * exercise them without spawning processes.
 */

/**
 * Build the task string for an individual researcher agent. Pulled
 * into a helper so the wording stays consistent across fan-out and so
 * tests can assert what each agent will see.
 */
export function buildResearcherTask(subQuery: string, sharedDir: string): string {
  return [
    `Research the following question and produce a concise brief.`,
    ``,
    `QUESTION: ${subQuery}`,
    ``,
    `Approach:`,
    `- Use \`web_search\` to find 3-5 high-quality sources.`,
    `- Use \`web_fetch\` to read the most relevant ones.`,
    `- Skim, extract the answer, and write findings.`,
    ``,
    `Output: write a markdown file to \`${sharedDir}/finding-<role>.md\` with:`,
    `  # <one-line headline>`,
    `  - 3-6 bullets summarizing what you learned`,
    `  - A "Sources" section listing each URL on its own line`,
    ``,
    `Then your result.md must contain the same content. Keep it short — the synthesizer reads all siblings together.`,
  ].join("\n");
}

/**
 * Build the task string for the synthesizer agent. It is spawned via the
 * team follow-on marker AFTER the researcher fan-out settles (see
 * src/agents/follow-on.ts) — by the time it runs, every finding that will
 * ever exist is already on disk, so it reads and merges immediately. (It
 * previously ran concurrently with the researchers and was told to poll
 * the shared dir every ~30s for up to 10 minutes — a claude worker paid
 * to sleep.)
 */
export function buildSynthesizerTask(
  question: string,
  sharedDir: string,
  researcherCount: number,
): string {
  return [
    `You are the synthesizer for a deep-research team answering:`,
    ``,
    `  ${question}`,
    ``,
    `The ${researcherCount} researchers have already finished. Everything they produced is in \`${sharedDir}\` — do NOT wait or poll for more files.`,
    ``,
    `Your job:`,
    `1. Read every \`finding-*.md\` in \`${sharedDir}\`. (If none exist, the researchers failed — write a brief.md saying exactly that and stop.)`,
    `2. Dedupe URLs across siblings. Resolve obvious contradictions by noting them.`,
    `3. Write a single \`${sharedDir}/brief.md\` with:`,
    `   # <title>`,
    `   ## TL;DR`,
    `   - three bullets, each one short sentence`,
    `   ## Findings`,
    `   - merged bullets from siblings, no dupes`,
    `   ## Sources`,
    `   - deduped URL list`,
    `4. Also write a short \`${sharedDir}/summary.txt\` — 3 bullets, no markdown — that fits in one iMessage. Each bullet ≤120 chars.`,
    `5. Your final result.md = the contents of summary.txt.`,
    ``,
    `Be terse. The user will read summary.txt first and click through to brief.md for depth.`,
  ].join("\n");
}

type ReducerOutput = {
  summary: string;
  briefPath: string;
};

/**
 * Pure helper used by the MCP tool to format the post-spawn return
 * message. Tells the model what to expect and where to look.
 */
export function formatSpawnReturn(args: {
  question: string;
  teamId: string;
  fanout: number;
  sharedDir: string;
  plannerVia: "haiku" | "heuristic";
  queries: string[];
}): string {
  const lines = [
    `deep_research team spawned: ${args.teamId} (planner=${args.plannerVia}, fanout=${args.fanout})`,
    `Question: ${args.question}`,
    `Shared dir: ${args.sharedDir}`,
    `Sub-queries:`,
    ...args.queries.map((q, i) => `  ${i + 1}. ${q}`),
    ``,
    `The researchers run in parallel; when the last one settles, the synthesizer spawns automatically and merges their findings. Do NOT poll — you'll be woken by ONE team-completion event after the synthesizer finishes. Then read the synthesizer's result.md for a 3-bullet summary, and ${args.sharedDir}/brief.md for the full markdown brief. If the brief is long, consider sharing it via the instant-share skill.`,
  ];
  return lines.join("\n");
}

/**
 * Extract URLs from a chunk of markdown for deduplication. Conservative
 * — matches http(s) URLs only.
 */
export function extractUrls(markdown: string): string[] {
  const re = /https?:\/\/[^\s)>\]"']+/g;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of markdown.matchAll(re)) {
    const u = stripTrailingPunct(m[0]);
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

function stripTrailingPunct(u: string): string {
  return u.replace(/[.,;:!?)\]>]+$/, "");
}
