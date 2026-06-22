# Derive upload batch size from active account count

**Date:** 2026-06-22
**Repo:** upload-to-tiktok (video-processor)
**Status:** Approved design — ready for implementation plan

## Problem

`TiktokUploadOrchestrator` uploads PNG-wrapped HLS segments in batches of a
fixed size, `TIKTOK_BATCH_SIZE` (production value `320`). Within each batch,
files are distributed round-robin across the active TikTok accounts and uploaded
concurrently, with `TIKTOK_BATCH_DELAY_MS` between batches.

The fixed size only produces the intended "10 uploads per account per batch"
ratio when the account count happens to match (`320 ÷ 32 accounts = 10`). When
accounts are added or removed without updating the setting, the ratio silently
drifts: fewer accounts → each account is overloaded per batch (rate-limit risk);
more accounts → accounts are underutilized.

## Goal

Make the batch size **derive from the number of active accounts** so each active
account always handles a fixed number of uploads per batch, regardless of how
many accounts exist.

```
batchSize = activeAccounts.length × TIKTOK_ITEMS_PER_ACCOUNT
```

`TIKTOK_BATCH_SIZE` is removed. The per-account ratio becomes a new env var,
`TIKTOK_ITEMS_PER_ACCOUNT` (default `10`), so it stays tunable without code
changes. `TIKTOK_BATCH_DELAY_MS` is unchanged.

## Decisions (from brainstorming)

- **Ratio source:** a new env var `TIKTOK_ITEMS_PER_ACCOUNT`, default `10` (not a
  hardcoded constant) — keeps the ratio tunable.
- **Account count:** the already-fetched `activeAccounts` from
  `TiktokAccountService.getActiveAccounts()` (non-limited / non-cooldown
  accounts) — the same accounts the batch distributes across. Not all rows in
  `tiktok_accounts`.

## Changes

### 1. Config — `src/types/index.ts` (`EnvConfigSchema`)

- **Remove** `TIKTOK_BATCH_SIZE`.
- **Add** `TIKTOK_ITEMS_PER_ACCOUNT`, mirroring the existing integer-env style:

  ```ts
  TIKTOK_ITEMS_PER_ACCOUNT: z
    .string()
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().min(1))
    .default('10'),
  ```

### 2. Orchestrator — `src/services/tiktokUploadOrchestrator.ts`

In `uploadProcessedFiles`, build the `BatchUploadConfig` **after** fetching
`activeAccounts` (currently it is built before, at lines ~79–83). Compute:

```ts
const activeAccounts = await this.accountService.getActiveAccounts();
if (activeAccounts.length === 0) {
  throw new Error('No active TikTok accounts available for upload');
}

const batchSize = activeAccounts.length * envConfig.TIKTOK_ITEMS_PER_ACCOUNT;
const config: BatchUploadConfig = {
  batchSize,
  delayMs: envConfig.TIKTOK_BATCH_DELAY_MS,
  outputDir,
};
logger.info(
  `Batch size ${batchSize} = ${activeAccounts.length} active account(s) ` +
    `× ${envConfig.TIKTOK_ITEMS_PER_ACCOUNT} items/account`
);
```

`activeAccounts.length` is guaranteed ≥ 1 by the zero-accounts guard that already
runs first, so `batchSize ≥ TIKTOK_ITEMS_PER_ACCOUNT` — no divide-by-zero or
empty-batch edge case. The round-robin distribution
(`fileIndex % accounts.length`) and inter-batch delay are unchanged.

### 3. Docs

- `env.example` (line ~16) and `README.md` (lines ~69, ~136): replace the
  `TIKTOK_BATCH_SIZE` row with `TIKTOK_ITEMS_PER_ACCOUNT` (default `10`,
  description: "uploads per active account per batch").
- `CLAUDE.md` "Upload resilience": describe the derived batch size
  (`accounts × TIKTOK_ITEMS_PER_ACCOUNT`) instead of `TIKTOK_BATCH_SIZE`.
- **`vlxy-docs/docs/deployment.md:149`** lists `TIKTOK_BATCH_SIZE` → **companion
  commit** updating it to `TIKTOK_ITEMS_PER_ACCOUNT`.

## Testing (TDD)

- `test/types/schemas.test.ts`: remove `TIKTOK_BATCH_SIZE` assertions; add
  `TIKTOK_ITEMS_PER_ACCOUNT` — default resolves to `10`, an explicit override is
  parsed, and a value `< 1` is rejected.
- `test/services/tiktokUploadOrchestrator.test.ts`: a failing-first test that, for
  N active accounts, the orchestrator chunks files into batches of
  `N × TIKTOK_ITEMS_PER_ACCOUNT` (e.g. assert the number of batches / batch
  boundaries for a known file count and account count). This fails against the
  current fixed-size code and passes after the change.

## Out of scope

- No change to round-robin distribution, retry logic, the inter-batch delay, or
  `getActiveAccounts()` itself.
- No change to how segments are produced or embedded.

## Definition of Done

1. Logic built test-first and passing.
2. `pnpm type-check`, `pnpm lint:check`, `pnpm test:coverage` (≥90%) green.
3. Repo docs updated (`env.example`, `README.md`, `CLAUDE.md`).
4. `vlxy-docs/docs/deployment.md` updated via companion commit.
