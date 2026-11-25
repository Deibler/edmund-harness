// A worker that is the first thing in the process to load a package.

self.onmessage = async () => {
  try {
    const mod = await import("@huggingface/transformers");
    self.postMessage({ ok: true, exports: Object.keys(mod).length });
  } catch (error) {
    const e = error as { name?: string; message?: string };
    self.postMessage({ ok: false, error: `${e?.name ?? "Error"}: ${e?.message ?? String(error)}` });
  }
};
