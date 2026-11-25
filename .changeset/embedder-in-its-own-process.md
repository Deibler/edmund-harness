---
"edmund-harness": patch
---

Keep recall working, and say so when it is not. The local embedder now runs in a process of its own instead of a worker thread. On Bun 1.3.9 a package first loaded by a worker thread could stop resolving once workers were created and terminated: recall then failed with "Cannot find module '@huggingface/transformers'" until the daemon restarted, or the daemon segfaulted. A process that cannot load the model is replaced on the next call, so the failure no longer outlives it. A recall that could not run now logs `recall=ERR` instead of looking like a message with nothing to recall, the operator is alerted when the embedder keeps failing, and a boot that follows a runtime crash says so in the log. Bun 1.4.5 or newer is now required: it does not have the fault (`scripts/bun-worker-churn/check.ts` crashes 1.3.9 and runs clean on 1.4.5), and CI runs on it.
