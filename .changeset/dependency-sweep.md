---
"edmund-harness": patch
---

Take the dependency updates that pass the gates: TypeScript 7, cloudflare 7
(its snapshot response fields are optional now, and a partial render is
reported rather than written as an empty file), concurrently 10, changesets
3, hookform resolvers 5, and the GitHub Actions majors. CI now typechecks
and builds both front ends, which is where three type errors had been
hiding.
