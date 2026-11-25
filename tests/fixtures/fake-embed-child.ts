// Stands in for transformers-embed-child.ts. Requests run one at a time,
// queries first, through the same scheduler as the real process. Each vector
// is [texts in that request (negative for a query), the text's number], so a
// test can see how the provider batched, laned and ordered its calls.
//
// FAKE_EMBED_BROKEN names a file. A process that starts while it exists can
// never load its "model", even after the file is gone: that is the outage
// this stands in for, where only a fresh process recovers. A text of "crash"
// kills the process mid-request, and "bad input" fails that one request only.
import { existsSync } from "node:fs";
import { laneScheduler } from "../../src/memory/embed-lanes.ts";

type Request = { id: number; texts: string[]; lane?: "query" | "index" };

const brokenFlag = process.env.FAKE_EMBED_BROKEN ?? "";
const broken = brokenFlag !== "" && existsSync(brokenFlag);

const push = laneScheduler<Request>(
  (r) => r.lane ?? "index",
  async ({ id, texts, lane }) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (broken) {
      process.send?.({
        id,
        ok: false,
        stage: "load",
        error: "ResolveMessage: Cannot find module '@huggingface/transformers'",
      });
      return;
    }
    if (texts.includes("crash")) process.exit(7);
    if (texts.includes("bad input")) {
      process.send?.({ id, ok: false, stage: "run", error: "Error: bad input" });
      return;
    }
    const data = new Float32Array(texts.length * 2);
    texts.forEach((text, i) => {
      data[i * 2] = lane === "query" ? -texts.length : texts.length;
      data[i * 2 + 1] = text === "pid" ? process.pid : Number(text.replace(/\D/g, ""));
    });
    process.send?.({ id, ok: true, data, dim: 2 });
  },
);

process.on("disconnect", () => process.exit(0));
process.on("message", (request: Request) => push(request));
process.send?.({ ready: true });
