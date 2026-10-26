---
"edmund-harness": patch
---

Keep recall's local embedder from eating the Mac's memory. Requests now reach the ONNX model at most eight texts at a time. The model keeps whatever memory a batch needed (about 45 MB per long text), so the indexer's 128-text batches had left the daemon holding 10 GB on a 16 GB Mac, which pushed Messages into swap and left incoming messages waiting up to two minutes for recall. Chunks are sent one at a time, so a live recall query also no longer waits behind a whole backfill.
