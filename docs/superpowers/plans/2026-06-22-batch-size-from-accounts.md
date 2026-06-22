# Derive Upload Batch Size From Active Account Count — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed `TIKTOK_BATCH_SIZE` with a batch size derived from the active-account count: `batchSize = activeAccounts.length × TIKTOK_ITEMS_PER_ACCOUNT` (new env var, default `10`).

**Architecture:** `TiktokUploadOrchestrator.uploadProcessedFiles` already fetches the active accounts before batching. Compute the batch size from that count instead of reading a fixed env var. The per-account ratio becomes a new validated env var; the old one is removed.

**Tech Stack:** TypeScript, Zod (env schema), Vitest. pnpm.

## Global Constraints

- Package manager: **pnpm** (v8.15.0). Run commands from the repo root.
- Types are **Zod-first**; env vars are defined in `EnvConfigSchema` (`src/types/index.ts`). Never use `any`.
- Quality gates before done: `pnpm type-check`, `pnpm lint:check`, `pnpm test:coverage` (**≥90% coverage**).
- Repo's own docs change in the **same commit** as the code; `vlxy-docs` gets a **companion commit**.
- Commit message trailer (every commit):
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01PxwmQjK1Si22VhD9y495wJ
  ```

---

## File Structure

- `src/types/index.ts` — `EnvConfigSchema`: remove `TIKTOK_BATCH_SIZE`, add `TIKTOK_ITEMS_PER_ACCOUNT`.
- `src/services/tiktokUploadOrchestrator.ts` — compute `batchSize` from active accounts.
- `test/types/schemas.test.ts` — config-schema tests.
- `test/services/tiktokUploadOrchestrator.test.ts` — batch-sizing test.
- `env.example`, `README.md`, `CLAUDE.md` — repo docs (same commit as Task 1).
- `vlxy-docs/docs/deployment.md` — companion commit (Task 2).

---

### Task 1: Derive batch size from active account count

**Files:**
- Modify: `src/types/index.ts:13-17` (remove `TIKTOK_BATCH_SIZE`; add `TIKTOK_ITEMS_PER_ACCOUNT`)
- Modify: `src/services/tiktokUploadOrchestrator.ts:79-91`
- Modify: `test/types/schemas.test.ts:21`, `:40-44` (+ new rejection test)
- Modify: `test/services/tiktokUploadOrchestrator.test.ts` (add one test)
- Modify (docs, same commit): `env.example:16`, `README.md:69` & `:136`, `CLAUDE.md` "Upload resilience"

**Interfaces:**
- Consumes: `TiktokAccountService.getActiveAccounts(): Promise<TiktokAccount[]>` (already used); `envConfig.TIKTOK_ITEMS_PER_ACCOUNT: number` (new); `envConfig.TIKTOK_BATCH_DELAY_MS: number` (unchanged).
- Produces: `batchSize: number = activeAccounts.length * envConfig.TIKTOK_ITEMS_PER_ACCOUNT`, fed into the existing `BatchUploadConfig`.

- [ ] **Step 1: Update the config-schema tests (red)**

In `test/types/schemas.test.ts`, replace the `TIKTOK_BATCH_SIZE` default assertion (line 21) with the new var, change the "parses provided string numbers" test (lines 40-44) to use the new var, and add a rejection test.

Line 21 — replace:
```ts
    expect(cfg.TIKTOK_BATCH_SIZE).toBe(5);
```
with:
```ts
    expect(cfg.TIKTOK_ITEMS_PER_ACCOUNT).toBe(10);
```

Lines 40-44 — replace the whole `it('parses provided string numbers', ...)` block with:
```ts
  it('parses provided string numbers', () => {
    const cfg = EnvConfigSchema.parse({
      ...baseEnv,
      TIKTOK_ITEMS_PER_ACCOUNT: '8',
      MAX_SEGMENT_SIZE_MB: '9.5',
    });
    expect(cfg.TIKTOK_ITEMS_PER_ACCOUNT).toBe(8);
    expect(cfg.MAX_SEGMENT_SIZE_MB).toBe(9.5);
  });

  it('rejects TIKTOK_ITEMS_PER_ACCOUNT below 1', () => {
    expect(() => EnvConfigSchema.parse({ ...baseEnv, TIKTOK_ITEMS_PER_ACCOUNT: '0' })).toThrow();
  });
```

- [ ] **Step 2: Add the orchestrator batch-sizing test (red)**

In `test/services/tiktokUploadOrchestrator.test.ts`, add this import near the top (after line 12):
```ts
import { logger } from '@/utils/logger';
```
Then add this test inside the `describe('TiktokUploadOrchestrator', ...)` block (e.g. after the happy-path test at line 144):
```ts
  // -------------------------------------------------------------------------
  // uploadProcessedFiles — batch size derives from active account count
  // -------------------------------------------------------------------------
  it('sets batch size to activeAccounts × TIKTOK_ITEMS_PER_ACCOUNT (default 10)', async () => {
    const m = await mocks;
    vi.mocked(logger.info).mockClear();

    // 2 active accounts × default ratio 10 → batch size 20
    m.getActiveAccounts.mockResolvedValue([
      account({ id: 'a1', name: 'a1' }),
      account({ id: 'a2', name: 'a2' }),
    ]);
    await seedFiles({
      [SEG_PATH]: wrapInPng('seg-data'),
      [PLAYLIST_PATH]: wrapInPng(PLAYLIST_M3U8),
    });
    m.performUpload
      .mockResolvedValueOnce('https://cdn/uploaded-seg.png')
      .mockResolvedValueOnce('https://cdn/uploaded-playlist.png');

    const orch = new TiktokUploadOrchestrator();
    await orch.uploadProcessedFiles(DIR);

    // The batching log reports the derived size: 2 accounts × 10 = 20.
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('batches of 20'));
  });
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run:
```bash
pnpm exec vitest run test/types/schemas.test.ts test/services/tiktokUploadOrchestrator.test.ts
```
Expected: FAIL — `cfg.TIKTOK_ITEMS_PER_ACCOUNT` is `undefined` (≠ 10/8), and the orchestrator logs `batches of 5` (current `TIKTOK_BATCH_SIZE` default), not `batches of 20`.

- [ ] **Step 4: Swap the env var in the schema**

In `src/types/index.ts`, remove the `TIKTOK_BATCH_SIZE` block (lines 13-17):
```ts
  TIKTOK_BATCH_SIZE: z
    .string()
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().min(1))
    .default('5'),
```
and add, in its place (immediately above `TIKTOK_BATCH_DELAY_MS`):
```ts
  TIKTOK_ITEMS_PER_ACCOUNT: z
    .string()
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().min(1))
    .default('10'),
```

- [ ] **Step 5: Derive the batch size in the orchestrator**

In `src/services/tiktokUploadOrchestrator.ts`, replace lines 79-91:
```ts
    const config: BatchUploadConfig = {
      batchSize: envConfig.TIKTOK_BATCH_SIZE,
      delayMs: envConfig.TIKTOK_BATCH_DELAY_MS,
      outputDir,
    };

    // Step 1: Get active TikTok accounts
    const activeAccounts = await this.accountService.getActiveAccounts();
    if (activeAccounts.length === 0) {
      throw new Error('No active TikTok accounts available for upload');
    }

    logger.info(`Found ${activeAccounts.length} active TikTok accounts for upload distribution`);
```
with:
```ts
    // Step 1: Get active TikTok accounts
    const activeAccounts = await this.accountService.getActiveAccounts();
    if (activeAccounts.length === 0) {
      throw new Error('No active TikTok accounts available for upload');
    }

    logger.info(`Found ${activeAccounts.length} active TikTok accounts for upload distribution`);

    // Batch size scales with the account pool so each active account handles a
    // fixed number of uploads per batch (TIKTOK_ITEMS_PER_ACCOUNT), regardless of
    // how many accounts exist. activeAccounts.length is >= 1 (guarded above).
    const batchSize = activeAccounts.length * envConfig.TIKTOK_ITEMS_PER_ACCOUNT;
    const config: BatchUploadConfig = {
      batchSize,
      delayMs: envConfig.TIKTOK_BATCH_DELAY_MS,
      outputDir,
    };
    logger.info(
      `Batch size ${batchSize} = ${activeAccounts.length} active account(s) × ` +
        `${envConfig.TIKTOK_ITEMS_PER_ACCOUNT} items/account`
    );
```

- [ ] **Step 6: Run type-check and the tests to verify green**

Run:
```bash
pnpm type-check
pnpm exec vitest run test/types/schemas.test.ts test/services/tiktokUploadOrchestrator.test.ts
```
Expected: type-check passes (no remaining `TIKTOK_BATCH_SIZE` references), tests PASS.

- [ ] **Step 7: Update repo docs (same commit)**

`env.example` — replace line 16:
```
TIKTOK_BATCH_SIZE=5
```
with:
```
# Uploads each active TikTok account handles per batch (batch size = accounts × this).
TIKTOK_ITEMS_PER_ACCOUNT=10
```

`README.md` — in the env block (line ~69) replace `TIKTOK_BATCH_SIZE=5` with `TIKTOK_ITEMS_PER_ACCOUNT=10`; in the env table (line ~136) replace the row:
```
| `TIKTOK_BATCH_SIZE` | Number of videos to upload per batch | 5 | No |
```
with:
```
| `TIKTOK_ITEMS_PER_ACCOUNT` | Uploads per active account per batch (batch size = active accounts × this) | 10 | No |
```

`CLAUDE.md` — in the "Upload resilience" paragraph, replace `batches uploads (`TIKTOK_BATCH_SIZE`, `TIKTOK_BATCH_DELAY_MS`)` with `batches uploads (batch size = active accounts × `TIKTOK_ITEMS_PER_ACCOUNT`, `TIKTOK_BATCH_DELAY_MS` between batches)`.

- [ ] **Step 8: Run the full quality gates**

Run:
```bash
pnpm type-check && pnpm lint:check && pnpm test:coverage
```
Expected: all green; coverage ≥90%; full suite passes (existing count + 1 new orchestrator test + 1 new schema test).

- [ ] **Step 9: Commit (code + repo docs together)**

```bash
git add src/types/index.ts src/services/tiktokUploadOrchestrator.ts \
  test/types/schemas.test.ts test/services/tiktokUploadOrchestrator.test.ts \
  env.example README.md CLAUDE.md
git commit -m "feat(upload): derive batch size from active account count

Replace the fixed TIKTOK_BATCH_SIZE with
batchSize = activeAccounts.length × TIKTOK_ITEMS_PER_ACCOUNT (new env var,
default 10), so each active account handles a fixed number of uploads per
batch regardless of how many accounts exist.

vlxy-docs: updated

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PxwmQjK1Si22VhD9y495wJ"
```

---

### Task 2: vlxy-docs companion commit

**Files:**
- Modify: `/home/nguyenhaison/works/vlxy/vlxy-docs/docs/deployment.md:149`

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the deployment env-var table**

In `/home/nguyenhaison/works/vlxy/vlxy-docs/docs/deployment.md`, replace line 149:
```
| `TIKTOK_BATCH_SIZE` / `TIKTOK_BATCH_DELAY_MS` | — | segment upload batching (default `5` / `5000`) |
```
with:
```
| `TIKTOK_ITEMS_PER_ACCOUNT` / `TIKTOK_BATCH_DELAY_MS` | — | segment upload batching: batch size = active accounts × items/account (default `10` / `5000`) |
```

- [ ] **Step 2: Commit in the vlxy-docs repo**

```bash
git -C /home/nguyenhaison/works/vlxy/vlxy-docs add docs/deployment.md
git -C /home/nguyenhaison/works/vlxy/vlxy-docs commit -m "docs(deployment): batch size now derives from active account count

Companion to video-processor: TIKTOK_BATCH_SIZE removed in favour of
TIKTOK_ITEMS_PER_ACCOUNT (default 10); batch size = active accounts × items.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PxwmQjK1Si22VhD9y495wJ"
```

---

## Self-Review

**Spec coverage:**
- Config: remove `TIKTOK_BATCH_SIZE`, add `TIKTOK_ITEMS_PER_ACCOUNT` (default 10, int ≥1) → Task 1 Steps 1, 4.
- Orchestrator: `batchSize = activeAccounts.length × TIKTOK_ITEMS_PER_ACCOUNT`, computed after the zero-accounts guard → Task 1 Steps 2, 5.
- Repo docs (`env.example`, `README.md`, `CLAUDE.md`) → Task 1 Step 7.
- `vlxy-docs` companion → Task 2.
- Tests (schema default/override/rejection; orchestrator derived size) → Task 1 Steps 1, 2.
- All spec sections covered.

**Placeholder scan:** none — every step has exact code/commands.

**Type consistency:** `batchSize: number`, `envConfig.TIKTOK_ITEMS_PER_ACCOUNT: number`, `BatchUploadConfig` shape unchanged (`batchSize`, `delayMs`, `outputDir`). The new var name is identical across schema, orchestrator, tests, and docs.
