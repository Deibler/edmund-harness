// Stands in for transformers-embed-worker.ts. Requests run one at a time, as
// in the real worker, and each vector is [texts in that request, the text's
// number], so a test can see how the provider batched and ordered its calls.

declare const self: Worker;

let queue = Promise.resolve();

self.onmessage = (event: MessageEvent<{ id: number; texts: string[] }>) => {
  const { id, texts } = event.data;
  queue = queue.then(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const data = new Float32Array(texts.length * 2);
    texts.forEach((text, i) => {
      data[i * 2] = texts.length;
      data[i * 2 + 1] = Number(text.replace(/\D/g, ""));
    });
    self.postMessage({ id, ok: true, data, dim: 2 });
  });
};
