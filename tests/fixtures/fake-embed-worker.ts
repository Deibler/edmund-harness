// Stands in for transformers-embed-worker.ts. Requests run one at a time,
// queries first, through the same scheduler as the real worker. Each vector is
// [texts in that request (negative for a query), the text's number], so a
// test can see how the provider batched, laned and ordered its calls.
import { laneScheduler } from "../../src/memory/embed-lanes.ts";

declare const self: Worker;

type Request = { id: number; texts: string[]; lane?: "query" | "index" };

const push = laneScheduler<Request>(
  (r) => r.lane ?? "index",
  async ({ id, texts, lane }) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const data = new Float32Array(texts.length * 2);
    texts.forEach((text, i) => {
      data[i * 2] = lane === "query" ? -texts.length : texts.length;
      data[i * 2 + 1] = Number(text.replace(/\D/g, ""));
    });
    self.postMessage({ id, ok: true, data, dim: 2 });
  },
);

self.onmessage = (event: MessageEvent<Request>) => push(event.data);
