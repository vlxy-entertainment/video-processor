# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **pnpm** (v8.15.0).

```bash
pnpm dev          # Run from TS source via ts-node (with 16GB heap + --expose-gc)
pnpm watch        # Run with file watching
pnpm build        # tsc + tsc-alias (resolves @/ path aliases in emitted JS)
pnpm start        # Run compiled dist/ (16GB heap + --expose-gc)
pnpm clean        # rm -rf dist

pnpm type-check   # tsc --noEmit
pnpm lint         # eslint src --fix
pnpm lint:check   # eslint src (no fix)
pnpm format       # prettier --write
pnpm format:check # prettier --check
```

Verify changes with `pnpm type-check`, `pnpm lint:check`, and `pnpm test:coverage` (Vitest suite, ≥90% coverage; all external boundaries mocked under `test/helpers/`).

The large heap (`--max-old-space-size=16384`) and `--expose-gc` flags are load-bearing: the upload path calls `global.gc()` explicitly between batches to keep memory bounded while streaming many file buffers. Don't drop these flags when adding run scripts.

## Architecture

This is a long-running **poll-based worker** (not a web server, despite Express being listed in the Cursor rules). `src/index.ts` boots an `App` that starts a `Scheduler`.

**Control flow:** `Scheduler` (every 1 min, `src/services/scheduler.ts`) → `ProcessingService.processNextVideo()` (`src/services/processingService.ts`) → the full pipeline. Two guards enforce **single-video concurrency**: the scheduler's `isProcessing` flag prevents overlapping ticks, and `QueueService.getNextItem()` refuses to claim work if any row is already `processing`, then atomically flips `queued → processing` (conditional update on `status='queued'`) to avoid races across instances.

**Pipeline (`processNextVideo`):**
1. Claim next queue item (ordered by `index`).
2. `TorboxService.requestDownloadUrl(torrent_id, file_id)` → a temporary video URL.
3. `VideoProcessor.processVideo()` → produces PNG-wrapped HLS in `processed/<queueItemId>/` (see below).
4. `TiktokUploadOrchestrator.uploadProcessedFiles()` → uploads to TikTok, returns the hosted playlist URL.
5. Create row in `videos` table, set status `ready` with the playlist URL.
6. `IndexNowService.submitVideo()`, mark queue item `processed`, delete the output folder.

On any failure the queue item is set to `failed`, progress `0`, and the output folder is cleaned up regardless.

### The core trick: HLS-in-PNG steganography (`src/services/videoProcessor.ts`)

The whole point of this project is hosting video segments on TikTok's **image** CDN. The processor:
1. Transcodes the source to HLS (`.ts` segments + `playlist.m3u8`), fixed 5s segments targeting <5MB each.
2. Strips FFmpeg's metadata packet from each `.ts` (byte-surgery on the MPEG-TS sync bytes, `0x47`) so the files look cleaner.
3. Concatenates each `.ts` (and the playlist) **after** the bytes of a 1×1 PNG, producing valid-looking `.png` files. Extraction works by finding the PNG `IEND` chunk and reading everything after it.
4. Rewrites the playlist's `.ts` references to `.png`, then embeds the playlist itself into a PNG too.

The orchestrator (`src/services/tiktokUploadOrchestrator.ts`) uploads each segment PNG to `api/upload/image/`, collects the returned CDN URIs, rewrites the playlist PNG's segment lines to those absolute CDN URLs, re-embeds, and uploads the final playlist. The hosted playlist PNG URL is what gets stored in `videos.hls_playlist_url`.

When editing the embed/extract logic, the PNG↔payload boundary (`IEND` signature `49 45 4E 44 AE 42 60 82`) must stay consistent between `videoProcessor.ts` (writes) and `tiktokUploadOrchestrator.ts` (reads).

### Routing & encoding strategies (`src/services/`)

Before encoding, `ProcessingPlanner` (`src/services/processingPlanner.ts`) probes the source (bitrate + max keyframe gap, bounded to the first 60s) and routes it: **remux** (`-c copy`, no re-encode, no GPU) when the predicted worst-case segment stays under `MAX_SEGMENT_SIZE_MB × SEGMENT_SIZE_SAFETY_MARGIN`, otherwise **transcode**. A remux that unexpectedly yields an oversize segment falls back to a one-shot transcode (`validateSegmentSizes` re-check in `processVideo`).

For the transcode path, a Strategy + Factory pattern selects the encoder. `EncodingStrategyFactory.createStrategy()` probes the host **once** (cached) in priority order **NVENC → Intel QSV → libx264** and returns the first available; libx264 is the guaranteed fallback, so the same binary runs on a GPU box or a CPU-only server. Each strategy's `isAvailable()` runs a `-f lavfi` test encode. Keyframe placement is owned solely by `VideoProcessor.runFFmpegConversion` (not the strategies), and NVENC uses capped-quality VBR (`-cq` with a `-maxrate` ceiling) rather than fixed CBR.

### Upload resilience

Two retry layers: `TiktokUploadService` retries 5xx/timeout HTTP errors with exponential backoff + jitter per file; `TiktokUploadOrchestrator` batches uploads (`TIKTOK_BATCH_SIZE`, `TIKTOK_BATCH_DELAY_MS`), distributes them round-robin across active accounts, and retries whole failed files on rotated accounts. A `403` marks the account `limited` (24h cooldown) via `TiktokAccountService`.

## Data layer

Supabase (service-role key, RLS bypassed — see `src/config/supabase.ts`). Three tables, all accessed through service classes, never raw clients in business logic:
- `video_processing_queue` — work queue. `index` orders processing and may be **negative** (`-1`/`-2`) for priority items; the Zod schema allows `>= -2`.
- `videos` — published records (`hls_playlist_url`, status `ready`/`failed`/…).
- `tiktok_accounts` — credentials (`aadvid`, `sid_guard_ads`, `csrftoken`) + status/cooldown bookkeeping.

All rows are validated through **Zod schemas in `src/types/index.ts`** on the way in/out (`VideoProcessingQueueItemSchema`, `VideoSchema`, `TiktokAccountSchema`). Generated DB types live in `src/types/database.ts`. SQL migrations are in `supabase/migrations/`.

Config is validated at startup by `EnvConfigSchema` (`src/types/index.ts`) — adding a new env var means adding it there. `TORBOX_TOKEN` is required and is **not** documented in the README (`env.example` is correct).

## Conventions (from `.cursor/rules/rules.mdc`)

- **Types are Zod-first:** define a Zod schema, then derive the TS type with `z.infer`. Never use `any`.
- Use `import type` for type-only imports. `readonly` for immutable fields.
- JSDoc every class, method, function, and type (TypeDoc-compatible tags only).
- Path aliases (`@/`, `@/services/`, etc.) — never deep relative imports across folders.
- Naming: PascalCase classes, camelCase members/files, UPPERCASE constants/env.
- A **Supabase MCP server** is configured (`.cursor/mcp.json`, project ref `uepacrwsmjjjsncssjis`); prefer it for live database inspection/changes over hand-writing SQL.
- Conventional commit messages; brief title, blank line, then detailed body.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **upload-to-tiktok** (1060 symbols, 1882 relationships, 32 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/upload-to-tiktok/context` | Codebase overview, check index freshness |
| `gitnexus://repo/upload-to-tiktok/clusters` | All functional areas |
| `gitnexus://repo/upload-to-tiktok/processes` | All execution flows |
| `gitnexus://repo/upload-to-tiktok/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## Workflow

This repo follows the VLXY workflow standard (`../vlxy-docs/docs/workflow.md`; summary in `../CLAUDE.md`).

- **Branch:** `develop`.
- **Test runner:** Vitest — `pnpm test`, `pnpm test:coverage` (≥90% coverage; all external boundaries mocked under `test/helpers/`).
- **Quality gates before done:** `pnpm type-check`, `pnpm lint:check`, `pnpm test:coverage`.
- **TDD:** mandatory for services, utils, data transforms, and Zod schemas; bug fixes start with a failing regression test. Real red → green → refactor, one behavior at a time.
- **Docs:** update this repo's docs on any contract/command change; update `vlxy-docs` per the standard's trigger table. This repo owns the shared-schema migrations and is the only writer of the `videos` table, so schema/flow/status changes here almost always require a `vlxy-docs` companion commit.
