---
scope: "Runtime environment, package manager, build tooling, and the overall shape of the application (long-running worker vs. server), including mandatory Node runtime flags."
not: "Coding conventions (see conventions.md) or video-pipeline domain logic (see patterns-video-pipeline.md)."
anchors:
  - "pnpm is the package manager (v8.15.0) — use pnpm, not npm"
  - "Runs as a long-running poll-based worker, not a web server"
  - "Node must run with --max-old-space-size=16384 --expose-gc"
---

## pnpm is the package manager (v8.15.0) — use pnpm, not npm

`package.json` pins `packageManager` to `pnpm@8.15.0` and a `pnpm-lock.yaml` is committed. Run scripts with `pnpm` (`pnpm dev`, `pnpm build`, `pnpm type-check`, etc.).

**Why:** Using npm/yarn would desync or regenerate the committed lockfile and drift dependency versions.

---

## Runs as a long-running poll-based worker, not a web server

`src/index.ts` boots an `App` that starts a `Scheduler` (`src/services/scheduler.ts`) which polls every 1 minute → `ProcessingService.processNextVideo()`. There is **no HTTP server**, despite Express being listed in the Cursor rules. Single-video concurrency is enforced two ways: the scheduler's `isProcessing` flag (no overlapping ticks) and an atomic DB claim in `QueueService.getNextItem()` (conditional `queued → processing` update).

**Why:** Mental model for the whole system — work flows from a Supabase queue through one pipeline at a time, not from request handlers.

---

## Node must run with --max-old-space-size=16384 --expose-gc

The `dev` and `start` scripts pass `--max-old-space-size=16384 --expose-gc`, and the upload path calls `global.gc()` explicitly between batches (`tiktokUploadOrchestrator.ts`, `TiktokUploadService.ts`).

**Why:** These flags are load-bearing for memory management while streaming many file buffers; dropping them when adding new run scripts risks OOM.

---
