# 06 — Configuration and Operations

Covers the full environment-variable inventory (validated at startup), the winston logging
pipeline and error sanitizer, the load-bearing Node.js memory flags, the IndexNow SEO
integration, and every `package.json` command available to run, build, and check the app.

Source files referenced throughout: [`src/types/index.ts`](../../src/types/index.ts) (schema),
[`src/config/index.ts`](../../src/config/index.ts) (loader), [`src/utils/logger.ts`](../../src/utils/logger.ts),
[`src/utils/errorSanitizer.ts`](../../src/utils/errorSanitizer.ts), [`package.json`](../../package.json),
[`env.example`](../../env.example).

---

## 1. Environment variables

Configuration is loaded by `src/config/index.ts` via `dotenv` and immediately validated
through `EnvConfigSchema` (`src/types/index.ts`, a Zod object). If any required variable
is missing or fails its constraint the process throws and exits before the worker starts.
**Adding a new env var means adding it to `EnvConfigSchema` first.**

| Variable | Purpose | Required / Default |
|---|---|---|
| `SUPABASE_URL` | Supabase project URL (must be a valid URL) | **Required** |
| `SUPABASE_SECRET_KEY` | Service-role key (RLS bypassed; privileged) | **Required** |
| `TORBOX_TOKEN` | TorBox API token used by `TorboxService` to request signed download URLs | **Required** |
| `TIKTOK_API_ENDPOINT` | Base URL for the TikTok upload API | **Required** (must be a valid URL) |
| `LOG_LEVEL` | Winston log verbosity: `error` \| `warn` \| `info` \| `debug` | Default: `info` |
| `LOG_FILE_PATH` | Path for the main log file; error log is derived as `<stem>-error.log` | Default: `./logs/app.log` |
| `TIKTOK_BATCH_SIZE` | Number of PNG segments uploaded in one batch before the inter-batch delay | Default: `5` (integer ≥ 1) |
| `TIKTOK_BATCH_DELAY_MS` | Milliseconds to wait between upload batches (during which `global.gc()` is called) | Default: `5000` (integer ≥ 1000) |
| `TIKTOK_IMG_CDN` | Base URL for the TikTok image CDN; prepended when constructing absolute segment URLs in the rewritten playlist | Default: `https://p21-ad-sg.ibyteimg.com/obj/` |

### env.example vs code-default divergence

`env.example` sets `TIKTOK_IMG_CDN=https://p16-sg.tiktokcdn.com/obj/` — a different CDN
host from the `EnvConfigSchema` Zod default (`https://p21-ad-sg.ibyteimg.com/obj/`).
`EnvConfigSchema` is authoritative for validation and fallback behaviour; the example
value may reflect a prior or region-specific endpoint. Set the variable explicitly in
`.env` rather than relying on either default.

---

## 2. Logging

Logger: **winston** (`src/utils/logger.ts`).

**Level** is read from `envConfig.LOG_LEVEL` at module init. The four allowed levels
(`error`, `warn`, `info`, `debug`) are enforced by Zod.

**Transports:**

| Transport | File | Scope | Max size | Rotation |
|---|---|---|---|---|
| File (errors) | `<LOG_FILE_PATH stem>-error.log` | `level: 'error'` | 5 MB | 5 rotated files (`.log.1` … `.log.5`) |
| File (all) | `LOG_FILE_PATH` | all levels | 5 MB | 5 rotated files |
| Console | stdout | all levels | — | Non-production only (`NODE_ENV !== 'production'`) |

All entries are JSON-formatted with a `YYYY-MM-DD HH:mm:ss` timestamp and `service: 'tiktok-video-uploader'` default meta.

### Error sanitizer (`src/utils/errorSanitizer.ts`)

A custom winston format (`sanitizeFormat`) runs `sanitizeForLogging()` on every log
entry before it reaches the transports. The sanitizer exists to prevent
`"Invalid string length"` errors that arise when HLS buffers, HTTP response bodies, or
large objects are logged naively. What it does:

- **Strings** — truncated at 10 000 chars; remainder noted as `[truncated N chars]`.
- **`Error` objects** — reduced to `{ name, message, stack (≤ 5 000 chars), cause, properties }`. Extra properties beyond the standard four are included up to a limit of 10 keys.
- **Arrays** — limited to the first 100 elements; remainder noted as `[N more items]`.
- **Plain objects** — limited to 50 keys; function-valued keys skipped entirely.
- **`data` / `responseData` / `response` keys** — passed through `sanitizeResponseData()`, which caps strings at 5 000 chars and large JSON objects at 10 000 chars; oversized objects are replaced by just the `message`, `error`, `status`, and `statusCode` fields plus `_truncated: true` and `_originalSize`.
- **`Buffer`** — replaced with `[Buffer: N bytes]`.
- **Nesting depth** — recursion capped at 10 levels; deeper nodes become `[Max depth exceeded]`.
- **Final size guard** — `createSafeLogEntry()` serialises the entire sanitised payload and, if it still exceeds 100 KB, replaces `data` with a `_truncated` sentinel.

The sanitizer does **not** redact secrets (keys, tokens) by value — it limits size.
Keep privileged values out of log calls at the call site.

---

## 3. Memory flags

The `start` and `dev` scripts both pass two load-bearing Node.js flags:

```
node --max-old-space-size=16384 --expose-gc
```

- **`--max-old-space-size=16384`** — raises the V8 old-generation heap ceiling to 16 GB.
  Without this the process OOMs when holding multiple large video file buffers in memory
  during transcoding and PNG wrapping.
- **`--expose-gc`** — makes `global.gc()` callable from user code. The upload path
  (`TiktokUploadOrchestrator`) calls it explicitly between batches to reclaim segment
  buffers and keep resident memory bounded over a long run.

Do not drop these flags when adding new run scripts. The `watch` script (`ts-node --watch`)
omits them because it is for development use only and not intended for production or
processing real workloads.

---

## 4. IndexNow integration

After step 5 of the pipeline (the `videos` row is written with status `ready`),
`IndexNowService.submitVideo()` is called with the published video URL. It pings the
IndexNow API to request immediate crawling of the new page — a lightweight SEO signal
that costs nothing if it fails (failures are logged but do not fail the queue item).

For the full pipeline context, including where this step sits relative to queue-item
state transitions, see [02-worker-and-pipeline.md](./02-worker-and-pipeline.md).

---

## 5. Commands

Package manager: **pnpm** (v8.15.0). All commands run from the repo root.

| Command | What it does |
|---|---|
| `pnpm dev` | Run from TypeScript source via `ts-node` + `tsconfig-paths`; applies the full 16 GB heap and `--expose-gc` flags |
| `pnpm watch` | Run with file watching via `ts-node --watch`; no memory flags — development only |
| `pnpm build` | `tsc` compiles to `dist/`, then `tsc-alias` rewrites `@/` path aliases in the emitted JS |
| `pnpm start` | Run the compiled `dist/index.js` with 16 GB heap + `--expose-gc`; production entry point |
| `pnpm clean` | `rm -rf dist` — wipe compiled output |
| `pnpm type-check` | `tsc --noEmit` — type-check without emitting; run before merging |
| `pnpm lint` | `eslint src --fix` — lint and auto-fix |
| `pnpm lint:check` | `eslint src` — lint without fixing; safe for CI |
| `pnpm format` | `prettier --write` over all `src/**/*.{ts,tsx,js,jsx,json,md}` |
| `pnpm format:check` | `prettier --check` — format check without writing; safe for CI |

**There is no test suite.** Correctness is verified through `pnpm type-check` (static
types) and `pnpm lint:check` (rules + style). When validating a change, run both.
