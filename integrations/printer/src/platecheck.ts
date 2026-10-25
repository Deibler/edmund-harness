import { runClaudeOneShot } from "../../../src/claude/one-shot.ts";
import type { PlateLook } from "./gate.ts";

/**
 * A second, independent look at the build plate before a print starts.
 *
 * The model that is about to start the print wants the plate to be empty; a
 * fresh model that is told nothing about the job has no stake in the answer.
 * It sees one camera frame and must answer CLEAR, OCCUPIED or UNSURE, and
 * only CLEAR lets a print start.
 */

export const PLATE_PROMPT = `You are checking a photo from a 3D printer's built-in camera before a print starts.
Look only at the build plate (the flat bed, usually textured gold or black).
Answer CLEAR only if the plate is completely empty: no printed parts, no strings or blobs of plastic, no purge, no tools, scrapers, paper or other objects anywhere on it.
Answer OCCUPIED if anything at all is on the plate.
Answer UNSURE if the plate is not fully visible, the image is dark or blurred, or you cannot tell.
Reply with exactly one word on the first line (CLEAR, OCCUPIED or UNSURE), then one short sentence on the second line saying what you see on the plate.`;

export function parsePlateVerdict(text: string): { verdict: PlateLook["verdict"]; note: string } {
  const lines = text
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const first = (lines[0] ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  const verdict: PlateLook["verdict"] =
    first === "CLEAR" ? "CLEAR" : first === "OCCUPIED" ? "OCCUPIED" : "UNSURE";
  return {
    verdict,
    note: lines.slice(1).join(" ").slice(0, 300) || (lines[0] ?? "").slice(0, 300),
  };
}

export async function lookAtPlate(
  imagePath: string,
  frameMs: number,
  model: string,
): Promise<PlateLook> {
  const r = await runClaudeOneShot({
    args: [
      "--model",
      model,
      "--tools",
      "Read",
      "--permission-mode",
      "bypassPermissions",
      "--append-system-prompt",
      PLATE_PROMPT,
    ],
    input: `Image: ${imagePath}`,
    timeoutMs: 120_000,
  });
  if (!r.ok || !r.text.trim()) {
    return {
      verdict: "UNSURE",
      frameMs,
      note: `the plate check could not run: ${r.error ?? "no answer"}`,
    };
  }
  return { frameMs, ...parsePlateVerdict(r.text) };
}
