# Architecture Reference — video-processor

## What this app is

`tiktok-video-uploader` (git remote: `video-processor`) is a long-running TypeScript
poll-based worker. It consumes rows from the shared Supabase `video_processing_queue`,
fetches the source video via a temporary TorBox download URL, transcodes it to HLS
(fixed 5-second segments), hides every HLS segment and the M3U8 playlist inside PNG
files using a post-`IEND` byte-append trick, uploads those PNGs to TikTok's image CDN,
and writes the resulting hosted playlist URL into a published `videos` row. It is not
a web server; it has no inbound HTTP interface.

## How it fits the bigger system

This app is the **bridge** in a three-service pipeline that shares a single Supabase
project. Each service owns a distinct stage:

- **torbox-app** — upstream producer; fills `video_processing_queue` with torrent/file
  references and an `index` priority value.
- **video-processor (this app)** — middle stage; claims queue items, runs the full
  download → transcode → steganography → upload pipeline, and writes the finished
  `videos` row.
- **video-streaming** — downstream consumer; the public frontend that reads `videos`
  and streams content to end-users.

External service dependencies at this app's boundary:

| Dependency | Role |
|---|---|
| TorBox API | Issues temporary signed download URLs for source video files |
| TikTok image-CDN / upload API (`api/upload/image/`) | Hosts the PNG-wrapped HLS segments and playlist |
| Supabase (service-role key, RLS bypassed) | Shared database — queue, videos, TikTok account credentials |
| IndexNow | SEO ping submitted after each video is published |

## Document index

| # | Document | Covers |
|---|---|---|
| 1 | [01-system-context.md](./01-system-context.md) | Bridge role and external dependencies; C4 context diagram |
| 2 | [02-worker-and-pipeline.md](./02-worker-and-pipeline.md) | Poll worker, `App` → `Scheduler` → `ProcessingService`, the 6-step pipeline, single-video concurrency guards; pipeline sequence diagram |
| 3 | [03-video-processing-png-steganography.md](./03-video-processing-png-steganography.md) | **Keystone:** HLS transcode, MPEG-TS metadata stripping, PNG steganography (post-`IEND` byte-append), playlist rewriting; encoding Strategy/Factory and the Nvidia-stub reality; embed/extract diagram |
| 4 | [04-tiktok-upload.md](./04-tiktok-upload.md) | `TiktokUploadOrchestrator` and `TiktokUploadService`: segment upload, CDN URL rewriting, playlist re-embed, batching, round-robin account rotation, retry/backoff, 403 → `limited` cooldown |
| 5 | [05-data-model.md](./05-data-model.md) | Three Supabase tables (`video_processing_queue`, `videos`, `tiktok_accounts`), Zod schemas in `src/types/index.ts`, generated `src/types/database.ts`, migrations under `supabase/migrations/`; ER diagram |
| 6 | [06-config-and-ops.md](./06-config-and-ops.md) | `EnvConfigSchema` env-var inventory (including the required `TORBOX_TOKEN`), winston logging, error sanitizer, load-bearing `--max-old-space-size=16384` + `--expose-gc` flags, IndexNow integration, build/run/lint commands |

## Recommended reading order

Newcomers should read in sequence:

**01** (system context) → **02** (worker + pipeline) → **03** (PNG steganography — the keystone)
→ **04** (TikTok upload) → **05** (data model) → **06** (config and ops)

Document 03 is the keystone: the HLS-in-PNG steganography is the core reason this project
exists, and documents 04 and 05 reference its outputs.

## Relationship to CLAUDE.md

[`CLAUDE.md`](../../CLAUDE.md) is the concise working guide — commands, key invariants,
and the conventions enforced by the linter and type-checker. These architecture docs are
the **deeper, diagrammed reference**: full service/table/env inventories, Mermaid
diagrams, and an honest account of known doc/code mismatches (for example, the encoding
strategy factory that always returns `NvidiaEncodingStrategy` regardless of hardware).
Where the two sources diverge, **the code is the source of truth** and these docs say so
explicitly.
