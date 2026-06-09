# TikTok Upload Orchestration and Account Rotation

Covers `TiktokUploadOrchestrator`, `TiktokUploadService`, `TiktokAccountService`, and `ApiClientService`: how segment PNGs are batched and distributed across accounts, how the rewritten playlist PNG is produced and uploaded, and how the system recovers from transient failures and rate-limited accounts.

Source files referenced:
- [`src/services/tiktokUploadOrchestrator.ts`](../../src/services/tiktokUploadOrchestrator.ts)
- [`src/services/tiktok/TiktokUploadService.ts`](../../src/services/tiktok/TiktokUploadService.ts)
- [`src/services/tiktokAccountService.ts`](../../src/services/tiktokAccountService.ts)
- [`src/services/apiClientService.ts`](../../src/services/apiClientService.ts)

For the PNG steganography that produces the files consumed here (the post-`IEND` byte-append format that embeds HLS segments and the M3U8 playlist inside PNG files), see [03-video-processing-png-steganography.md](./03-video-processing-png-steganography.md).

---

## 1. Upload flow

`TiktokUploadOrchestrator.uploadProcessedFiles(outputDir)` runs six sequential steps:

```
Step 1  getActiveAccounts()       → ordered list of active TikTok accounts
Step 2  getFilesToUpload()        → sorted list of all .png files in outputDir
Step 3  uploadFilesInBatches()    → upload segment_*.png files; collect UploadResult[]
Step 4  retryFailedUploads()      → re-attempt any failures on rotated accounts
Step 5  updatePlaylistUrls()      → extract M3U8 from playlist.png, replace segment
                                     filenames with CDN URLs, re-embed into playlist_updated.png
Step 6  uploadSingleFile()        → upload playlist_updated.png; return its CDN URL
```

The returned CDN URL is written into `videos.hls_playlist_url` by the calling pipeline layer (`ProcessingService`).

### Playlist URL rewriting (Step 5)

`updatePlaylistUrls()` reads the playlist PNG, extracts the M3U8 text from after the IEND boundary (same mechanism as described in doc 03), then processes line by line:

```ts
const lines = m3u8Content.split('\n');
const updatedLines = lines.map(line => {
  const trimmedLine = line.trim();
  if (trimmedLine && !trimmedLine.startsWith('#')) {
    const lineFilename = path.basename(trimmedLine);
    for (const [segmentFilename, uploadedUrl] of urlMapping.entries()) {
      if (lineFilename === segmentFilename || trimmedLine === segmentFilename) {
        return uploadedUrl;   // absolute CDN URL replaces the segment filename
      }
    }
  }
  return line;
});
```

Each non-comment line (a segment filename) is replaced with the absolute CDN URL from the corresponding `UploadResult`. The updated M3U8 text is re-embedded after the original PNG's IEND boundary into `playlist_updated.png`, which is then uploaded as the final step. The playlist is always uploaded using `activeAccounts[0]` (the least-recently-used account, because `getActiveAccounts()` orders by `last_upload_at ASC`).

---

## 2. Batching

Two env vars govern batching, defined in `EnvConfigSchema` (`src/types/index.ts`):

| Variable | Zod default | Constraint |
|---|---|---|
| `TIKTOK_BATCH_SIZE` | `5` | `int ≥ 1` |
| `TIKTOK_BATCH_DELAY_MS` | `5000` | `int ≥ 1000` |

`uploadFilesInBatches()` slices the segment file list into chunks of `TIKTOK_BATCH_SIZE`, runs all files in a chunk concurrently with `Promise.all`, then waits `TIKTOK_BATCH_DELAY_MS` before starting the next chunk (skipped after the last batch). Within each chunk, accounts are assigned round-robin by file index:

```ts
const accountIndex = fileIndex % accounts.length;
const account = accounts[accountIndex];
```

`global.gc()` is called after each batch completes (and after every individual upload in `TiktokUploadService`) when the `--expose-gc` flag is set, to reclaim file buffer memory between batches.

---

## 3. Retry resilience

There are two independent retry layers.

### Layer 1 — `TiktokUploadService` (per-request, same account)

Defined in `RETRY_CONFIG` at the top of `TiktokUploadService.ts`:

```ts
const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  BASE_DELAY_MS: 1000,       // 1 second
  MAX_DELAY_MS: 10000,       // 10 seconds
  RETRYABLE_STATUS_CODES: [500, 502, 503, 504, 520, 521, 522, 523, 524],
} as const;
```

`performUploadWithRetry()` retries on any of those HTTP status codes, up to 3 times (4 total attempts). Delay per attempt:

```ts
private calculateDelay(attempt: number): number {
  const exponentialDelay = RETRY_CONFIG.BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * 1000;   // up to 1 s of random jitter
  return Math.min(exponentialDelay + jitter, RETRY_CONFIG.MAX_DELAY_MS);
}
```

So delays are approximately: attempt 1 → ~1 s, attempt 2 → ~2 s, attempt 3 → ~4 s, capped at 10 s. A 403 is **not** in the retryable set — it is handled at the orchestrator layer instead (see §4).

### Layer 2 — `TiktokUploadOrchestrator` (per-file, rotated accounts)

After all batches complete, any still-failed files enter `retryFailedUploads()`. This layer uses a separate `RetryConfig`:

```ts
private readonly retryConfig: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 2000,       // 2 seconds
  maxDelayMs: 30000,          // 30 seconds
  backoffMultiplier: 2,
};
```

For each failed file, up to 3 retry attempts are made. The delay formula is:

```ts
const delayMs = Math.min(
  this.retryConfig.initialDelayMs *
    Math.pow(this.retryConfig.backoffMultiplier, retryAttempt - 1),
  this.retryConfig.maxDelayMs
);
```

Delays: attempt 1 → 2 s, attempt 2 → 4 s, attempt 3 → 8 s, capped at 30 s.

Account rotation at this layer explicitly avoids the account that originally failed: `accounts.filter(account => account.id !== failedUpload.accountId)`. If no alternatives exist, all accounts are tried. Accounts are cycled by `(retryAttempt - 1) % accountsToTry.length`.

If any file still fails after all orchestrator retries, `uploadProcessedFiles()` throws and the queue item is marked failed by the pipeline.

---

## 4. Account management (`TiktokAccountService`)

Accounts are stored in the `tiktok_accounts` Supabase table. Relevant credential fields per account:

| Field | Role |
|---|---|
| `aadvid` | TikTok advertiser device ID (sent as part of cookie/header identification) |
| `sid_guard_ads` | Session cookie value for the `sid_guard` cookie |
| `csrftoken` | Sent as both `tt-csrf-token` request header and `tt_csrf_token` cookie value |

### Active account selection

`getActiveAccounts()` filters `status = 'active'` and orders by `last_upload_at ASC`:

```ts
.eq('status', 'active')
.order('last_upload_at', { ascending: true })
```

This ensures the least-recently-used account is first, distributing load naturally across accounts.

### 403 → `limited` with 24 h cooldown

In `uploadSingleFile()` in the orchestrator, after any upload failure, a 403 response triggers `setAccountLimited()`:

```ts
if (account.id && this.isRateLimitedError(error)) {
  await this.accountService.setAccountLimited(account.id);
  logger.warn(`Account ${account.name} marked as limited due to 403 response`);
}
```

`isRateLimitedError()` checks `error.response?.status === 403`. `setAccountLimited()` writes:

```ts
const cooldownUntil = new Date();
cooldownUntil.setHours(cooldownUntil.getHours() + cooldownHours); // default 24

await supabase.from(this.accountsTable).update({
  status: 'limited',
  cooldown_until: cooldownUntil.toISOString(),
  updated_at: new Date().toISOString(),
}).eq('id', accountId);
```

A `limited` account is excluded from future `getActiveAccounts()` calls (which filter `status = 'active'` only) until it is manually or automatically reset. There is no automatic reactivation logic in this codebase; cooldown expiry is informational only.

### Upload statistics

On each successful upload, `updateUploadStats(accountId)` increments `upload_count` and sets `last_upload_at` to the current timestamp. This is what drives the `last_upload_at ASC` ordering in account selection.

---

## 5. API client (`ApiClientService`)

`ApiClientService` is a thin Axios wrapper. `TiktokUploadService` instantiates it with the `TIKTOK_API_ENDPOINT` env var as `baseURL` and immediately sets a static `Host: www.tiktok.com` header:

```ts
this.apiClient = new ApiClientService(envConfig.TIKTOK_API_ENDPOINT);
this.apiClient.setHeader('Host', 'www.tiktok.com');
```

Per-request auth is passed in the upload config rather than as Axios defaults, keeping credentials scoped to the specific account being used:

```ts
const cookieHeader = `tt_csrf_token=${csrfToken}; sid_guard=${account.sid_guard_ads}`;

const uploadConfig = {
  headers: {
    'tt-csrf-token': csrfToken,
    Cookie: cookieHeader,
  },
  withCredentials: true,
};
```

The upload endpoint is `api/upload/image/` (relative to `TIKTOK_API_ENDPOINT`). Files are sent as `multipart/form-data` using `form-data` with a read stream (not a full buffer load) to limit memory pressure. The response CDN URL is constructed from the `uri` field in the response body prefixed with `TIKTOK_IMG_CDN` (default `https://p21-ad-sg.ibyteimg.com/obj/`):

```ts
const completeUrl = `${envConfig.TIKTOK_IMG_CDN}${uriPath}`;
```

`ApiClientService` exposes `setHeader()` and `appendCookie()` helpers but `TiktokUploadService` uses neither for per-request auth — it passes cookies inline via the `config` argument to `post()` instead.
