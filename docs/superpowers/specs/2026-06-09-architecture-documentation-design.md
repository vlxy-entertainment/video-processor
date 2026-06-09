# Architecture Documentation — Design Spec (upload-to-tiktok / video-processor)

**Date:** 2026-06-09
**Status:** Approved (design); pending implementation plan
**Topic:** A focused set of architecture/reference docs for the TikTok video-processor service

## Purpose

`upload-to-tiktok` (npm name `tiktok-video-uploader`, git remote `video-processor`) is a
long-running TypeScript **poll-based worker** that consumes the shared Supabase
`video_processing_queue`, downloads source video via TorBox, transcodes it to HLS, hides
the HLS segments inside PNG files, uploads them to TikTok's image CDN, and publishes the
resulting playlist into the `videos` table. It is the **bridge** between `torbox-app`
(which fills the queue) and `video-streaming` (which serves `videos`).

A concise `CLAUDE.md` already exists. Produce a **comprehensive reference** that
complements it — humans and AI agents get diagrams, full service/table/env inventories,
and a deep dive on the keystone PNG-steganography pipeline — without duplicating CLAUDE.md.

Reference depth: concrete file paths, tables, and diagrams — not line-by-line walkthroughs.

## Audience

- Engineers/architects new to this repo or the wider platform.
- AI coding agents needing an accurate, loadable map before making changes.

## The bigger system (context this app lives in)

This service is the middle stage of a three-app pipeline sharing one Supabase project (VLXY):

- **torbox-app** — fills `video_processing_queue` (upstream producer).
- **THIS app (video-processor)** — claims queue items, processes + uploads, writes `videos`.
- **video-streaming** — public frontend that reads `videos` (downstream consumer).
- **External services:** TorBox API (source download), TikTok image-CDN/upload API
  (segment hosting), Supabase (shared DB, service-role), IndexNow (SEO ping).

## Structure

A new `docs/architecture/` folder in this repo, one Markdown file per concern, plus a
`README.md` index with a recommended reading order. No upstream/custom legend — this is
our own code.

### Document set

| # | File | Covers |
|---|------|--------|
| — | `README.md` | What it is (queue-consuming processor + TikTok uploader), doc index, reading order, link to `CLAUDE.md` |
| 1 | `01-system-context.md` | The bridge role: consumes `video_processing_queue` (torbox-app), produces `videos` (video-streaming); external deps — TorBox API, TikTok image-CDN/upload API, Supabase, IndexNow. **C4 context diagram.** |
| 2 | `02-worker-and-pipeline.md` | Poll-based worker: `App` → `Scheduler` (1-min tick) → `ProcessingService.processNextVideo()`; the 6-step pipeline; single-video concurrency guards (scheduler `isProcessing` + atomic `queued→processing` claim); service inventory. **Pipeline sequence diagram.** |
| 3 | `03-video-processing-png-steganography.md` | **Keystone:** `VideoProcessor` — HLS transcode (5s segments, <5MB), MPEG-TS metadata stripping (`0x47` sync-byte surgery), PNG-wrapping after the `IEND` chunk (`49 45 4E 44 AE 42 60 82`), playlist `.ts`→`.png` rewriting; the encoding Strategy/Factory and the reality that `createStrategy()` always returns `NvidiaEncodingStrategy`. **Embed/extract diagram.** |
| 4 | `04-tiktok-upload.md` | `TiktokUploadOrchestrator` + `TiktokUploadService`: upload segment PNGs to `api/upload/image/`, rewrite playlist PNG segment lines to CDN URLs, re-embed + upload playlist; batching (`TIKTOK_BATCH_SIZE`/`TIKTOK_BATCH_DELAY_MS`), round-robin account rotation, retry/backoff+jitter, 403→`limited` (24h cooldown); `TiktokAccountService` (aadvid/sid_guard_ads/csrftoken). |
| 5 | `05-data-model.md` | Supabase tables (`video_processing_queue`, `videos`, `tiktok_accounts`), the Zod schemas in `src/types/index.ts`, generated `src/types/database.ts`, the 6 `supabase/migrations/`, `index` negative-priority ordering (`>= -2`), and the service-class access pattern. **ER diagram.** |
| 6 | `06-config-and-ops.md` | `EnvConfigSchema` env-var table (incl. required `TORBOX_TOKEN`; `env.example` authoritative), winston logging (`src/utils/logger.ts`), error sanitizer, the load-bearing `--max-old-space-size=16384` + `--expose-gc` flags (explicit `global.gc()` between batches), IndexNow, build/run/lint commands. |

The keystone is **#3** (HLS-in-PNG steganography) — the reason the project exists.

## Conventions for the docs

- **Mermaid diagrams** (context, pipeline sequence, embed/extract, ER).
- Each doc opens with a one-line "what this covers" and links source files by path.
- **Tables** for services, env vars, tables/columns.
- **Code is the source of truth.** Flag the known doc/code mismatches:
  - `EncodingStrategyFactory.createStrategy()` always returns `NvidiaEncodingStrategy('p1')`
    — hardware detection is stubbed; the README's "automatic hardware detection" is aspirational,
    and the `videoProcessor` CPU-fallback re-creates the same NVENC strategy (no real fallback).
  - `package.json` `description` ("monitors a folder … pushes to a queue") is stale — the app
    *consumes* the queue.
- `CLAUDE.md` and `.claude/memory/` are linked, not duplicated.

## Sources of truth (used while writing)

- The codebase (`src/`, `supabase/migrations/`, config) — primary.
- `CLAUDE.md` and `.claude/memory/plugin/` for stated architecture/conventions (cross-checked
  against code; code wins on conflict).
- Live Supabase access is restricted; schema is taken from `supabase/migrations/` and the Zod
  schemas / `src/types/database.ts`.

## Out of scope

- Internals of the other system repos (torbox-app, video-streaming) and the TorBox/TikTok
  services themselves — described only at this app's boundary.
- Any code changes. Documentation only. (The known code/doc mismatches are documented, not fixed.)
- Committing the untracked `CLAUDE.md` / `.claude/` — left as-is.

## Success criteria

- A reader (human or agent) can, from `docs/architecture/`, answer: what this service is,
  how the poll-based pipeline claims and processes a queue item, how the HLS-in-PNG
  steganography and TikTok upload work, the data model, and how it's configured/run —
  without reading the source first.
- Every service, table, and env var is listed with its source file.
- All diagrams render and reflect the current code (including the Nvidia-stub reality).
