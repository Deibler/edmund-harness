// A short-lived worker that loads nothing, like a trigger predicate.

self.onmessage = (event: MessageEvent<{ rows: Array<{ v: number }>; n: number }>) => {
  self.postMessage({
    ok: true,
    fire: event.data.rows.filter((r) => r.v > 0.5).length > event.data.n,
  });
};
