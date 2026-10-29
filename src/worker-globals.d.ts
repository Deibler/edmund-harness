// The worker scripts (refresh/script-eval.ts, triggers/predicate-eval.ts) run
// as Web Workers and talk to their owner through `self`. The project leaves
// the DOM lib out of tsconfig, so `self` is declared here. Until 2026-10-29
// these scripts typechecked only because memory/transformers-embed-worker.ts,
// itself a global script then, declared it and the declaration leaked.
declare const self: Worker;
