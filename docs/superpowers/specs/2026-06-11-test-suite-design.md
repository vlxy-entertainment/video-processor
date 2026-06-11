# Test Suite Design — upload-to-tiktok

**Date:** 2026-06-11
**Branch:** `test/test-suite` (cut from `develop`)
**Goal:** A fast, deterministic, CI-safe automated test suite that covers every feature of the service, enforcing **≥ 90 % coverage** on business logic.

---

## 1. Context

`upload-to-tiktok` is a long-running poll-based worker. A `Scheduler` ticks every minute and runs a pipeline that: claims a queue item → resolves a TorBox download URL → transcodes/remuxes the video to HLS and hides each segment inside a PNG → uploads the PNGs to TikTok's image CDN → records the result in Supabase → submits to IndexNow.

The repo currently has **no test runner and no tests**; the only safety net is `pnpm type-check` + `pnpm lint:check`. This spec adds the missing test layer.

This spec targets the **`develop`** branch, which differs from `main`: it adds a `ProcessingPlanner` (remux-vs-transcode routing), real cached hardware detection in `EncodingStrategyFactory`, a single-pass `wrapSegmentsInPng`, a pure `stripFFmpegMetadata` helper, and three new env vars (`MAX_SEGMENT_SIZE_MB`, `SEGMENT_SIZE_SAFETY_MARGIN`, `HLS_SEGMENT_DURATION_SECONDS`) plus `ProcessingPlan`/`ProcessingRoute` types.

### Keystone decisions

| Decision | Choice |
|---|---|
| Test framework | **Vitest** + `@vitest/coverage-v8` + `vite-tsconfig-paths` |
| External boundaries | **Mock all** (Supabase, axios, fluent-ffmpeg, `child_process`, fs, `@torbox/torbox-api`) — pure unit tests |
| Coverage target | **90 %** lines/functions/branches/statements on business logic; glue & generated code excluded |
| Mock wiring | **Module mocking via `vi.mock`** — zero production code changes |

---

## 2. Tooling & configuration

1. **Branch:** `git checkout -b test/test-suite origin/develop` (done).
2. **Dev dependencies:** `vitest`, `@vitest/coverage-v8`, `vite-tsconfig-paths`.
3. **`vitest.config.ts`:**
   - `test.environment = 'node'`, `test.globals = true`.
   - `plugins: [tsconfigPaths()]` so `@/...` resolves exactly as in production.
   - `test.setupFiles = ['test/helpers/setup.ts']`.
   - `coverage`: provider `v8`, reporters `['text','html','lcov']`, thresholds all `90`, with the `include`/`exclude` globs in §5.
4. **`package.json` scripts:**
   - `"test": "vitest run"`
   - `"test:watch": "vitest"`
   - `"test:coverage": "vitest run --coverage"`
5. **Verification** for any future change becomes: `pnpm type-check` + `pnpm lint:check` + `pnpm test:coverage`.

---

## 3. Shared test infrastructure (`test/helpers/`)

The suite stands on a small set of reusable boundary fakes. These are the highest-leverage pieces; build them first.

### `setup.ts` (global)
- Sets required env vars **before any module import** so `envConfig` parsing (eager, at import time) does not throw: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `TIKTOK_API_ENDPOINT`, `TORBOX_TOKEN` (and lets the new numeric vars fall to their defaults).
- `vi.mock('@/utils/logger', ...)` → a no-op logger (`info/warn/error/debug` as `vi.fn()`), so tests are quiet and never touch winston/disk.

### `supabaseMock.ts`
A chainable query-builder fake — **the single most important helper**, since every data service depends on `supabase.from(...)`.
- `from()`, `select()`, `insert()`, `update()`, `delete()`, `eq()`, `order()`, `limit()` all return the builder.
- Terminal calls (`single()`, or `await`-ing the builder) resolve to a **per-test-configurable** `{ data, error }`.
- Helper to enqueue a sequence of results so multi-query methods (e.g. `getNextItem`'s processing-check → select → claim-update) can be scripted in order.
- `vi.mock('@/config/supabase', () => ({ supabase: <builder> }))`.

### `ffmpegMock.ts`
Fakes `fluent-ffmpeg`:
- A chainable command (`input`, `inputOptions`, `outputOptions`, `output`, `on`, `run`) whose `.on('end' | 'error', cb)` handlers the test can fire to simulate success/failure of conversions, remuxes, and `isAvailable()` probes.
- `ffmpeg.ffprobe(path, cb)` returning canned `FfprobeData` (configurable streams/format) for metadata, planner bitrate, and strategy bitrate logic.

### `childProcessMock.ts`
Fakes `child_process.execFile` (used by `ProcessingPlanner.getMaxKeyframeGapSeconds` via `promisify`) so tests feed canned `ffprobe` packet CSV (`pts_time,flags`) and assert keyframe-gap math.

### `fsMock.ts`
Fakes `fs` (`promises` + sync): `mkdir`, `readdir`, `stat`, `readFile`, `writeFile`, `unlink`, `rm`, `access`, `existsSync`, `readFileSync`, `writeFileSync`, `createReadStream`.
- `readFile`/`readFileSync` return **real Buffers** and `writeFile`/`writeFileSync` capture them, so the genuine PNG/TS byte-surgery runs against real bytes — no disk I/O.

### `fixtures.ts`
- The real 1×1 carrier PNG buffer (matching the source's base64) + its IEND offsets.
- A synthetic `.ts` buffer containing an `FFmpeg` metadata packet and a later `0x47` sync byte (for `stripFFmpegMetadata`), plus a clean `.ts` with no marker.
- Sample `m3u8` content (header + `#EXTINF` + segment lines).
- Zod-valid row objects: queue item, video, tiktok account.
- Sample `ffprobe` packet CSV strings (keyframe `K` flags).

---

## 4. Test plan — one spec per module

Each `*.test.ts` mirrors its source under `test/`. Both the success path **and** the error/`{ error }` path of every public method are covered (that is where most branch coverage lives).

### 4.1 Steganography core — `videoProcessor.test.ts` (crown jewel)
Private byte logic is exercised via test-side type-cast access (`(processor as any).method(...)`) — a test technique, not a production change.
- `stripFFmpegMetadata` (pure Buffer): removes the `FFmpeg` packet up to the next `0x47`; returns input unchanged when no marker (remuxed segments); returns input unchanged when no later sync byte.
- `wrapSegmentsInPng`: carrier-PNG prefix + cleaned payload, `.ts` unlinked; round-trips through `extractM3u8FromPng`; rethrows on write failure.
- `extractM3u8FromPng` / `validatePlaylist`: IEND lookup, `#EXTM3U` header check, segment count, `#EXTINF` duration sum, error cases (missing header, no segments, missing IEND).
- `updatePlaylistToUsePng` (`.ts`→`.png`), `embedPlaylistToPng`, `clearTsAndPlaylist`.
- `processVideo` orchestration: **remux route** (under budget → wrap → validate), **remux→transcode fallback** when `validateSegmentSizes` finds an oversize segment, **transcode route**, and the top-level failure path (logs + rethrows).
- `convertVideoToHLS` / `runRemuxToHls` / `runFFmpegConversion`: resolve on `end`, reject on `error`; correct option lists (incl. `HLS_SEGMENT_DURATION_SECONDS` in remux).
- `getVideoMetadata` / `getFFmpegMetadata`: ffprobe success + reject; bitrate/duration math, zero-duration guard.

### 4.2 Routing — `processingPlanner.test.ts`
- `plan`: remux when `predictedMaxSegmentMB ≤ budget`, transcode when over, transcode when probe throws (default), transcode when `predictedMaxSegmentMB === 0`.
- `getVideoBitrateBps` fallback chain: stream bitrate → format bitrate → resolution estimate (4K/1080p/720p/≤480p) → default width.
- `getMaxKeyframeGapSeconds`: parse `K`-flagged packets, compute max gap, return `Infinity` when < 2 keyframes; ignore malformed lines.

### 4.3 Upload
**`tiktokUploadOrchestrator.test.ts`** (fake timers for backoff):
- `uploadProcessedFiles`: no active accounts → throw; happy path returns playlist URL; batching math + round-robin account distribution; failed-segment retry merge; "still failed after retries" → throw; missing playlist file → throw.
- `uploadSingleFile`: success updates stats; null URL → failure result; **403 → `setAccountLimited`**; `setAccountLimited` failure is swallowed.
- `retryFailedUploads`: exponential backoff capped at `maxDelayMs`, account rotation (skip the failed account), success-breaks-loop, exhaustion records last error.
- `updatePlaylistUrls` / `extractM3U8FromPNG` / `embedM3U8IntoPNG`: IEND parse, per-line filename→URL replacement, replacement-count mismatch warning, re-embed to `_updated.png`, missing-IEND throw.
- `isRateLimitedError` truth table.

**`TiktokUploadService.test.ts`** (fake timers):
- `performUploadWithRetry`: retryable 5xx codes retried up to `MAX_RETRIES` then rethrow; non-retryable rethrown immediately; missing CSRF token → throw; large response-data truncation branch; `global.gc` guard.
- `processUploadResponse`: `status_code !== 0` → null; missing `data.uri` → null; success → URL.
- `extractImageUrl`: leading-slash trim + CDN concat. `getContentType`: extension table + `application/octet-stream` default. `isRetryableError`, `calculateDelay` jitter bounds (mock `Math.random`).

**`apiClientService.test.ts`**: `get/post/put/delete/patch` delegate to the axios instance; `setHeader`, `appendCookie` build the cookie string; `buildCookieString`.

### 4.4 Data services
- **`queueService.test.ts`**: `addToQueue` (+ `getNextIndex`: empty → 0, increment, error → 0); `getQueue`/`logCurrentQueue`; `isTorrentInQueue` (found / not / error→false); **`getNextItem`** (processing exists → null; none queued → null; happy claim; already-claimed race → null; select/update error → null); `updateStatus`; `removeFromQueue`. Error path on each Supabase call.
- **`videoService.test.ts`**: `createVideo` (title/description fallbacks, with/without network, with/without actresses); `findOrCreateNetwork` & `findOrCreateActress` (found / PGRST116-not-found→create / other-error→throw); `assignActressesToVideo` (parse/trim/empty); `updateVideoStatus` (with/without URL); `getVideo` (found / PGRST116→null / error→throw).
- **`tiktokAccountService.test.ts`**: `getActiveAccounts` (mapping, empty→`[]`, error→throw); `updateUploadStats` (fetch+increment, fetch-error, update-error); `setAccountLimited` (default 24 h cooldown timestamp via faked clock); `updateCsrfToken`.
- **`torboxService.test.ts`**: `requestDownloadUrl` success; no-data / `data.error` / no-URL branches; thrown error wrapped. Mock `@torbox/torbox-api`.
- **`indexNowService.test.ts`**: `submitVideo` / `submitVideos` — 200/202 success, unexpected status warn, **error swallowed (never throws)**, empty-array early return. Mock `axios`.

### 4.5 Pipeline
- **`processingService.test.ts`** (mock all six sibling service modules): full 9-step success; no queue item → early return; missing `id` → throw; missing `torrent_id`/`file_id` → throw; failure at each major step → queue marked `failed(0)` + `cleanupOutputFolder` + rethrow; `cleanupOutputFolder` no-dir branch (access throws) and rm-error swallowed.
- **`scheduler.test.ts`** (fake timers): `start` runs immediately + sets interval, double-start warns; `isProcessing` overlap guard skips a tick; `runTask` swallows errors and clears the flag; `stop` (running / not running); `isRunning`; `getIntervalMinutes`.

### 4.6 Pure logic
- **`errorSanitizer.test.ts`**: primitives, long-string truncation, `Error` (name/message/stack cap, `cause`, extra props), arrays (>100 cap), objects (>50 keys, skip functions, `data`/`response` special-casing), `Buffer`/`Date`, max-depth, `sanitizeResponseData` size branches, `createSafeLogEntry` over-size + serialize-failure paths.
- **`types/schemas.test.ts`**: `EnvConfigSchema` defaults & transforms (`TIKTOK_BATCH_SIZE` int≥1, `TIKTOK_BATCH_DELAY_MS` ≥1000, `SEGMENT_SIZE_SAFETY_MARGIN` 0<x≤1, `MAX_SEGMENT_SIZE_MB` positive, `HLS_SEGMENT_DURATION_SECONDS` positive int) + rejection cases; `VideoProcessingQueueItemSchema` (index ≥ −2, progress 0–100, status enum); `VideoSchema`; `TiktokAccountSchema`; `ProcessingPlanSchema`/`ProcessingRouteSchema`.
- **`config.test.ts`**: `getEnvConfig` returns parsed config; throws wrapped error on invalid env (test via isolated import with bad `process.env`).
- **`encoding/*.test.ts`**: for each of the 6 strategies — `getName`, `getOptions` (Nvidia 1080p-scale branch + bitrate args; QSV `getVideoBitrate` stream→resolution fallback table; CPU fixed args; AMD & Apple option lists), and `isAvailable` (ffmpeg `end`→true / `error`→false). **`EncodingStrategyFactory`**: priority order NVENC→QSV→libx264, first-available wins, caching (second call returns cached, no re-probe), `getAvailableStrategies`, `getStrategyInfo`. Reset the static `cachedStrategy` between tests.

---

## 5. Coverage policy

**Enforce 90 %** (lines/functions/branches/statements) over:
- `src/services/**`
- `src/utils/errorSanitizer.ts`
- `src/config/index.ts`
- `src/types/index.ts` (Zod schemas)

**Exclude** (generated or thin glue with no meaningful logic):
- `src/types/database.ts` (generated DB types)
- `src/types/common.ts` (pure interfaces)
- `src/index.ts` (bootstrap)
- `src/config/supabase.ts` (one-line client construction)
- `src/utils/logger.ts` (winston transport configuration; its only logic — `sanitizeFormat` — delegates to `errorSanitizer`, which is fully tested directly; and the module is globally mocked everywhere else)
- `src/scripts/**`
- `test/**`, config files

---

## 6. Out of scope (YAGNI)

- No real ffmpeg / network / Supabase integration or E2E tests.
- No production-code refactors (no DI seams) — module mocking only.
- No CI pipeline file in this pass (can follow once the suite is green).

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `envConfig` is parsed eagerly at import → a missing env var throws before any test runs | `setup.ts` sets required vars before imports |
| Supabase's fluent chaining is easy to mock wrong | One well-tested `supabaseMock` builder with scripted multi-result sequences |
| `EncodingStrategyFactory` caches a static strategy across tests | Reset `cachedStrategy` in `beforeEach` |
| Backoff/interval timers could make the suite slow/flaky | `vi.useFakeTimers()` for all delay/retry/scheduler tests |
| Hitting 90 % branches on heavily-logged services | Test both success and `{ error }`/throw paths for every method |
| Private byte-surgery methods aren't public | Exercise via test-side type-cast access (no production change) |
