---
"edmund-harness": patch
---

Take the dependency updates that pass the gates: TypeScript 7, cloudflare 7
(its snapshot response fields are optional now, so a partial render is
reported rather than written out as an empty file), concurrently 10,
changesets 3, hookform resolvers 5, and the GitHub Actions majors. Clear
every high-severity advisory by pinning patched versions of six transitive
packages. CI now typechecks and builds both front ends, which is where three
type errors had been hiding, and the audit gate retries instead of failing
the build when the advisory registry does not answer.
