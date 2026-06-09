---
scope: "How to verify changes in this repository, given the absence of an automated test suite."
not: "Runtime/tooling setup (see tech-stack.md) or domain logic (see patterns-video-pipeline.md)."
anchors:
  - "No test suite — verify with pnpm type-check and pnpm lint:check"
---

## No test suite — verify with pnpm type-check and pnpm lint:check

There are no tests (no `test`/`spec` dirs, no `*.test.*` files, no test runner in `package.json`). Verify changes with `pnpm type-check` (`tsc --noEmit`) and `pnpm lint:check` (`eslint src`).

**Why:** Without tests these two commands are the only automated safety net; run both before claiming a change is correct.

---
