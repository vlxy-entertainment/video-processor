# Test Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Vitest test suite for `upload-to-tiktok` (develop branch) that mocks all external boundaries, changes zero production code, and reaches ≥90% coverage on business logic.

**Architecture:** Pure unit tests. Every boundary (Supabase, axios, fluent-ffmpeg, `child_process`, fs, `@torbox/torbox-api`, winston logger) is replaced with a `vi.mock` module fake from `test/helpers/`. Production services are imported and called black-box; private byte-surgery methods are reached via test-side type-casts (`(obj as any).method`). Tests assert both success and error paths of every public method.

**Tech Stack:** Vitest, `@vitest/coverage-v8`, `vite-tsconfig-paths`, TypeScript, pnpm.

**Inverted TDD note:** Production code already exists, so the per-task loop is: write the test → run it → it should PASS against real code → if it fails, the bug is in the *test or mock wiring*, so fix that until green → commit. Coverage gaps are closed in the final task.

**Branch:** `test/test-suite` (already cut from `develop`).

---

## File Structure

**Created:**
- `vitest.config.ts` — runner + coverage config
- `test/helpers/setup.ts` — global env + logger mock
- `test/helpers/supabaseMock.ts` — chainable Supabase query-builder fake
- `test/helpers/ffmpegMock.ts` — fluent-ffmpeg + ffprobe fake
- `test/helpers/childProcessMock.ts` — `execFile` fake
- `test/helpers/fsMock.ts` — fs promises + sync fake
- `test/helpers/fixtures.ts` — buffers, rows, sample strings
- `test/**/<module>.test.ts` — one spec per production module

**Modified:**
- `package.json` — add devDeps + `test*` scripts (no production code touched)

---

## Task 1: Tooling setup + smoke test

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `test/smoke.test.ts`

- [ ] **Step 1: Install dev dependencies**

Run:
```bash
pnpm add -D vitest @vitest/coverage-v8 vite-tsconfig-paths
```
Expected: packages added to `devDependencies`.

- [ ] **Step 2: Add scripts to `package.json`**

In the `"scripts"` block add:
```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['test/helpers/setup.ts'],
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: [
        'src/services/**',
        'src/utils/errorSanitizer.ts',
        'src/config/index.ts',
        'src/types/index.ts',
      ],
      exclude: [
        'src/types/database.ts',
        'src/types/common.ts',
        'src/index.ts',
        'src/config/supabase.ts',
        'src/utils/logger.ts',
        'src/scripts/**',
      ],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
```

- [ ] **Step 4: Create `test/smoke.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';

describe('smoke', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run the smoke test**

Run: `pnpm test`
Expected: 1 passing test. (If `vite-tsconfig-paths` errors on the path aliases, confirm `tsconfig.json` has `compilerOptions.paths` for `@/*`.)

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts test/smoke.test.ts
git commit -m "test: add vitest tooling and smoke test"
```

---

## Task 2: Global setup file

**Files:**
- Create: `test/helpers/setup.ts`

The production `envConfig` is parsed eagerly at import time (`src/config/index.ts`), so required env vars must exist before any production module loads. The logger is mocked globally so no test touches winston/disk.

- [ ] **Step 1: Write `test/helpers/setup.ts`**

```typescript
import { vi } from 'vitest';

// Required env vars — set before any production module is imported so that
// envConfig (parsed eagerly in src/config/index.ts) does not throw. The numeric
// vars fall through to their schema defaults.
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';
process.env.TIKTOK_API_ENDPOINT = 'https://www.tiktok.com';
process.env.TORBOX_TOKEN = 'test-torbox-token';

// Silence the logger everywhere; no winston, no file writes.
vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
```

- [ ] **Step 2: Verify the smoke test still passes with setup loaded**

Run: `pnpm test`
Expected: smoke test passes; no env/logger errors.

- [ ] **Step 3: Commit**

```bash
git add test/helpers/setup.ts
git commit -m "test: add global setup (env + logger mock)"
```

---

## Task 3: Fixtures

**Files:**
- Create: `test/helpers/fixtures.ts`

- [ ] **Step 1: Write `test/helpers/fixtures.ts`**

```typescript
import type { VideoProcessingQueueItem, Video, TiktokAccount } from '@/types';

/** The 1x1 transparent carrier PNG the production code prepends. Ends in IEND. */
export const CARRIER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/** Wraps a payload after the carrier PNG, exactly like the production wrap step. */
export function wrapInPng(payload: Buffer | string): Buffer {
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([CARRIER_PNG, buf]);
}

/**
 * A synthetic MPEG-TS-ish buffer with an embedded "FFmpeg" metadata marker and a
 * later 0x47 sync byte, for exercising stripFFmpegMetadata.
 * Layout: [10 bytes header][6 "FFmpeg"][junk ...][0x47 sync + payload].
 */
export function tsWithFFmpegMeta(): Buffer {
  const header = Buffer.alloc(10, 0x11); // 10 bytes; "FFmpeg" starts at index 10
  const marker = Buffer.from('FFmpeg');
  const junk = Buffer.alloc(200, 0x22); // pushes the next 0x47 well past byte 188
  const sync = Buffer.from([0x47, 0xde, 0xad, 0xbe, 0xef]);
  return Buffer.concat([header, marker, junk, sync]);
}

/** A clean TS buffer with no FFmpeg marker. */
export function tsClean(): Buffer {
  return Buffer.from([0x47, 0x01, 0x02, 0x03, 0x04]);
}

/** Sample HLS playlist text. */
export const SAMPLE_M3U8 = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:5',
  '#EXTINF:5.000,',
  'segment_000.ts',
  '#EXTINF:4.200,',
  'segment_001.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

/** ffprobe packet CSV (pts_time,flags) with keyframes (K) at 0, 4, 10 seconds. */
export const KEYFRAME_CSV = [
  '0.000000,K_',
  '1.000000,__',
  '4.000000,K_',
  '7.000000,__',
  '10.000000,K_',
  '',
].join('\n');

export function queueItem(overrides: Partial<VideoProcessingQueueItem> = {}): VideoProcessingQueueItem {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    index: 0,
    status: 'queued',
    progress: 0,
    video_name: 'Test Video',
    torrent_id: 'torrent-1',
    file_id: 'file-1',
    ...overrides,
  };
}

export function video(overrides: Partial<Video> = {}): Video {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    title: 'Test Video',
    description: 'desc',
    status: 'ready',
    ...overrides,
  };
}

export function account(overrides: Partial<TiktokAccount> = {}): TiktokAccount {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    name: 'acct-1',
    aadvid: 'aad-1',
    sid_guard_ads: 'sid-1',
    csrftoken: 'csrf-1',
    status: 'active',
    upload_count: 0,
    ...overrides,
  };
}
```

- [ ] **Step 2: Add a fixtures self-test `test/helpers/fixtures.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { CARRIER_PNG, wrapInPng, tsWithFFmpegMeta } from './fixtures';

describe('fixtures', () => {
  it('carrier PNG ends with IEND signature', () => {
    const iend = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    expect(CARRIER_PNG.indexOf(iend)).toBeGreaterThan(-1);
  });
  it('wrapInPng appends after the carrier', () => {
    const out = wrapInPng('hello');
    expect(out.length).toBe(CARRIER_PNG.length + 5);
  });
  it('tsWithFFmpegMeta contains the marker', () => {
    expect(tsWithFFmpegMeta().indexOf(Buffer.from('FFmpeg'))).toBe(10);
  });
});
```

- [ ] **Step 3: Run + commit**

Run: `pnpm test test/helpers/fixtures.test.ts` → Expected: PASS.
```bash
git add test/helpers/fixtures.ts test/helpers/fixtures.test.ts
git commit -m "test: add shared fixtures"
```

---

## Task 4: Supabase mock helper

**Files:**
- Create: `test/helpers/supabaseMock.ts`

The real client chains arbitrarily (`from().select().eq().order().limit()`) and the chain is awaited or terminated with `.single()`, resolving `{ data, error }`. The fake is a Proxy-free chainable object that returns itself for builder methods and resolves a scripted result when awaited or `.single()`-d.

- [ ] **Step 1: Write `test/helpers/supabaseMock.ts`**

```typescript
import { vi } from 'vitest';

export interface DbResult {
  data: unknown;
  error: unknown;
}

/**
 * A chainable Supabase query-builder fake. Builder methods return the same
 * thenable; awaiting it (or calling .single()) yields the next scripted result.
 */
class QueryBuilder {
  constructor(private readonly results: DbResult[]) {}

  private next(): DbResult {
    return this.results.length > 1 ? this.results.shift()! : (this.results[0] ?? { data: null, error: null });
  }

  // Builder methods — all return `this`.
  select = vi.fn(() => this);
  insert = vi.fn(() => this);
  update = vi.fn(() => this);
  delete = vi.fn(() => this);
  eq = vi.fn(() => this);
  order = vi.fn(() => this);
  limit = vi.fn(() => this);

  // Terminal: single() resolves the next scripted result.
  single = vi.fn(() => Promise.resolve(this.next()));

  // Make the builder awaitable (for queries that don't end in .single()).
  then<T>(onFulfilled: (v: DbResult) => T) {
    return Promise.resolve(this.next()).then(onFulfilled);
  }
}

/**
 * Builds a Supabase mock whose `.from()` returns a fresh builder scripted with
 * the provided results (consumed in order across terminal calls).
 *
 * @param results One result per terminal call, in order. A single result is
 * reused for every terminal call.
 */
export function makeSupabaseMock(results: DbResult[] = [{ data: null, error: null }]) {
  const queue = [...results];
  const from = vi.fn(() => new QueryBuilder(queue));
  return { supabase: { from } };
}
```

- [ ] **Step 2: Self-test `test/helpers/supabaseMock.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { makeSupabaseMock } from './supabaseMock';

describe('supabaseMock', () => {
  it('chains and resolves the scripted result via single()', async () => {
    const { supabase } = makeSupabaseMock([{ data: { id: 'x' }, error: null }]);
    const res = await supabase.from('t').select('*').eq('id', 'x').single();
    expect(res).toEqual({ data: { id: 'x' }, error: null });
  });

  it('is awaitable without single()', async () => {
    const { supabase } = makeSupabaseMock([{ data: [1, 2], error: null }]);
    const res = await supabase.from('t').select('*').order('index');
    expect(res).toEqual({ data: [1, 2], error: null });
  });

  it('consumes multiple results in order', async () => {
    const { supabase } = makeSupabaseMock([
      { data: [{ id: 'p' }], error: null },
      { data: { id: 'claimed' }, error: null },
    ]);
    const a = await supabase.from('t').select('id').eq('status', 'processing').limit(1);
    const b = await supabase.from('t').update({}).eq('id', 'p').select().single();
    expect(a.data).toEqual([{ id: 'p' }]);
    expect(b.data).toEqual({ id: 'claimed' });
  });
});
```

- [ ] **Step 3: Run + commit**

Run: `pnpm test test/helpers/supabaseMock.test.ts` → Expected: PASS.
```bash
git add test/helpers/supabaseMock.ts test/helpers/supabaseMock.test.ts
git commit -m "test: add chainable supabase mock helper"
```

---

## Task 5: ffmpeg, child_process, and fs mock helpers

**Files:**
- Create: `test/helpers/ffmpegMock.ts`
- Create: `test/helpers/childProcessMock.ts`
- Create: `test/helpers/fsMock.ts`

- [ ] **Step 1: Write `test/helpers/ffmpegMock.ts`**

```typescript
import { vi } from 'vitest';

export interface FfmpegMockControl {
  /** Set how the next command run resolves: fire 'end' (success) or 'error'. */
  succeed: () => void;
  fail: (err?: Error) => void;
  /** ffprobe result the next ffprobe() call yields. */
  setProbe: (data: unknown, err?: unknown) => void;
  ffmpeg: any;
}

/**
 * Builds a fluent-ffmpeg mock. The command object is chainable; calling .run()
 * fires either the 'end' or 'error' handler depending on the configured mode.
 */
export function makeFfmpegMock(): FfmpegMockControl {
  let mode: 'end' | 'error' = 'end';
  let error: Error = new Error('ffmpeg failed');
  let probeData: unknown = { streams: [], format: {} };
  let probeErr: unknown = null;

  const command: any = {};
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  command.input = vi.fn(() => command);
  command.inputOptions = vi.fn(() => command);
  command.outputOptions = vi.fn(() => command);
  command.output = vi.fn(() => command);
  command.on = vi.fn((event: string, cb: (...a: unknown[]) => void) => {
    handlers[event] = cb;
    return command;
  });
  command.run = vi.fn(() => {
    // Defer so .on() handlers are all registered first.
    queueMicrotask(() => {
      if (mode === 'end') handlers['end']?.();
      else handlers['error']?.(error, 'stdout', 'stderr');
    });
  });

  const ffmpeg: any = vi.fn(() => command);
  ffmpeg.ffprobe = vi.fn((_path: string, cb: (e: unknown, d: unknown) => void) => {
    cb(probeErr, probeData);
  });

  return {
    ffmpeg,
    succeed: () => { mode = 'end'; },
    fail: (err?: Error) => { mode = 'error'; if (err) error = err; },
    setProbe: (data: unknown, err: unknown = null) => { probeData = data; probeErr = err; },
  };
}
```

- [ ] **Step 2: Write `test/helpers/childProcessMock.ts`**

```typescript
import { vi } from 'vitest';

/**
 * Builds a child_process mock whose execFile invokes its callback with the
 * configured stdout (Node's promisify expects (err, { stdout, stderr })).
 */
export function makeChildProcessMock(stdout = '', err: unknown = null) {
  const execFile = vi.fn(
    (_cmd: string, _args: string[], cb: (e: unknown, r: { stdout: string; stderr: string }) => void) => {
      cb(err, { stdout, stderr: '' });
    }
  );
  return { execFile };
}
```

- [ ] **Step 3: Write `test/helpers/fsMock.ts`**

```typescript
import { vi } from 'vitest';

/**
 * In-memory fs fake covering the promises + sync surface the code uses. Files
 * are stored as real Buffers so byte-surgery runs for real.
 */
export function makeFsMock(initial: Record<string, Buffer> = {}) {
  const files = new Map<string, Buffer>(Object.entries(initial));

  const promises = {
    mkdir: vi.fn(async () => undefined),
    readdir: vi.fn(async (dir: string) =>
      [...files.keys()]
        .filter(p => p.startsWith(dir))
        .map(p => p.slice(dir.length + 1))
    ),
    readFile: vi.fn(async (p: string, enc?: string) => {
      const b = files.get(p);
      if (!b) throw new Error(`ENOENT: ${p}`);
      return enc ? b.toString(enc as BufferEncoding) : b;
    }),
    writeFile: vi.fn(async (p: string, data: Buffer | string) => {
      files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data));
    }),
    stat: vi.fn(async (p: string) => ({ size: files.get(p)?.length ?? 0 })),
    unlink: vi.fn(async (p: string) => { files.delete(p); }),
    rm: vi.fn(async () => undefined),
    access: vi.fn(async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); }),
  };

  const fsSync = {
    existsSync: vi.fn((p: string) => files.has(p)),
    readFileSync: vi.fn((p: string) => {
      const b = files.get(p);
      if (!b) throw new Error(`ENOENT: ${p}`);
      return b;
    }),
    writeFileSync: vi.fn((p: string, data: Buffer | string) => {
      files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data));
    }),
    createReadStream: vi.fn((p: string) => ({ path: p, _read: () => undefined })),
  };

  return { files, promises, fsSync };
}
```

- [ ] **Step 4: Run existing tests to confirm nothing broke**

Run: `pnpm test` → Expected: all prior tests still PASS (these helpers are not yet imported anywhere).

- [ ] **Step 5: Commit**

```bash
git add test/helpers/ffmpegMock.ts test/helpers/childProcessMock.ts test/helpers/fsMock.ts
git commit -m "test: add ffmpeg, child_process, and fs mock helpers"
```

---

## Task 6: errorSanitizer tests (pure logic warm-up)

**Files:**
- Test: `test/utils/errorSanitizer.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect } from 'vitest';
import { sanitizeForLogging, createSafeLogEntry } from '@/utils/errorSanitizer';

describe('sanitizeForLogging', () => {
  it('passes primitives through', () => {
    expect(sanitizeForLogging(null)).toBeNull();
    expect(sanitizeForLogging(undefined)).toBeUndefined();
    expect(sanitizeForLogging(5)).toBe(5);
    expect(sanitizeForLogging(true)).toBe(true);
  });

  it('truncates long strings', () => {
    const out = sanitizeForLogging('a'.repeat(10001)) as string;
    expect(out).toContain('[truncated 1 chars]');
  });

  it('extracts safe fields from an Error with cause and extra props', () => {
    const err = new Error('boom') as Error & { cause?: unknown; extra?: string };
    err.cause = new Error('root');
    err.extra = 'x';
    const out = sanitizeForLogging(err) as Record<string, unknown>;
    expect(out.name).toBe('Error');
    expect(out.message).toBe('boom');
    expect(out.cause).toBeDefined();
    expect(out.properties).toBeDefined();
  });

  it('caps arrays at 100 items', () => {
    const out = sanitizeForLogging(Array.from({ length: 150 }, (_, i) => i)) as unknown[];
    expect(out.length).toBe(101);
    expect(out[100]).toContain('50 more items');
  });

  it('caps object keys at 50 and skips functions', () => {
    const obj: Record<string, unknown> = { fn: () => 1 };
    for (let i = 0; i < 60; i++) obj[`k${i}`] = i;
    const out = sanitizeForLogging(obj) as Record<string, unknown>;
    expect(out.fn).toBeUndefined();
    expect(out['...']).toContain('more keys');
  });

  it('summarizes Buffer and Date', () => {
    expect(sanitizeForLogging(Buffer.alloc(3))).toBe('[Buffer: 3 bytes]');
    const d = new Date('2020-01-01T00:00:00.000Z');
    expect(sanitizeForLogging(d)).toBe('2020-01-01T00:00:00.000Z');
  });

  it('stops at max depth', () => {
    expect(sanitizeForLogging({}, 11)).toBe('[Max depth exceeded]');
  });

  it('special-cases large response data with important fields', () => {
    const big = { message: 'm', status: 500, blob: 'x'.repeat(11000) };
    const out = sanitizeForLogging({ data: big }) as Record<string, Record<string, unknown>>;
    expect(out.data._truncated).toBe(true);
    expect(out.data.message).toBe('m');
  });
});

describe('createSafeLogEntry', () => {
  it('returns sanitized data', () => {
    expect(createSafeLogEntry('msg', { a: 1 })).toEqual({ message: 'msg', data: { a: 1 } });
  });

  it('truncates entries above the max size', () => {
    const huge = { s: 'x'.repeat(200 * 1024) };
    const out = createSafeLogEntry('msg', huge);
    expect((out.data as Record<string, unknown>)._truncated).toBe(true);
  });

  it('omits data when none is given', () => {
    expect(createSafeLogEntry('msg')).toEqual({ message: 'msg', data: undefined });
  });
});
```

- [ ] **Step 2: Run**

Run: `pnpm test test/utils/errorSanitizer.test.ts`
Expected: PASS. If a case fails, the assertion's expectation is wrong — adjust to match `src/utils/errorSanitizer.ts` behavior (do not change production code).

- [ ] **Step 3: Commit**

```bash
git add test/utils/errorSanitizer.test.ts
git commit -m "test: cover errorSanitizer"
```

---

## Task 7: Zod schema + config tests

**Files:**
- Test: `test/types/schemas.test.ts`
- Test: `test/config/config.test.ts`

- [ ] **Step 1: Write `test/types/schemas.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import {
  EnvConfigSchema,
  VideoProcessingQueueItemSchema,
  VideoSchema,
  TiktokAccountSchema,
  ProcessingPlanSchema,
  ProcessingRouteSchema,
} from '@/types';

const baseEnv = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SECRET_KEY: 'k',
  TIKTOK_API_ENDPOINT: 'https://www.tiktok.com',
  TORBOX_TOKEN: 't',
};

describe('EnvConfigSchema', () => {
  it('applies defaults and transforms', () => {
    const cfg = EnvConfigSchema.parse(baseEnv);
    expect(cfg.TIKTOK_BATCH_SIZE).toBe(5);
    expect(cfg.TIKTOK_BATCH_DELAY_MS).toBe(5000);
    expect(cfg.MAX_SEGMENT_SIZE_MB).toBe(5);
    expect(cfg.SEGMENT_SIZE_SAFETY_MARGIN).toBe(0.8);
    expect(cfg.HLS_SEGMENT_DURATION_SECONDS).toBe(5);
  });

  it('rejects a non-url SUPABASE_URL', () => {
    expect(() => EnvConfigSchema.parse({ ...baseEnv, SUPABASE_URL: 'nope' })).toThrow();
  });

  it('rejects batch delay below 1000', () => {
    expect(() => EnvConfigSchema.parse({ ...baseEnv, TIKTOK_BATCH_DELAY_MS: '500' })).toThrow();
  });

  it('rejects safety margin above 1', () => {
    expect(() => EnvConfigSchema.parse({ ...baseEnv, SEGMENT_SIZE_SAFETY_MARGIN: '1.5' })).toThrow();
  });

  it('parses provided string numbers', () => {
    const cfg = EnvConfigSchema.parse({ ...baseEnv, TIKTOK_BATCH_SIZE: '8', MAX_SEGMENT_SIZE_MB: '9.5' });
    expect(cfg.TIKTOK_BATCH_SIZE).toBe(8);
    expect(cfg.MAX_SEGMENT_SIZE_MB).toBe(9.5);
  });
});

describe('domain schemas', () => {
  it('accepts a priority index of -2 and rejects -3', () => {
    expect(VideoProcessingQueueItemSchema.parse({ index: -2 }).status).toBe('queued');
    expect(() => VideoProcessingQueueItemSchema.parse({ index: -3 })).toThrow();
  });

  it('rejects progress above 100', () => {
    expect(() => VideoProcessingQueueItemSchema.parse({ index: 0, progress: 101 })).toThrow();
  });

  it('defaults video status to uploaded', () => {
    expect(VideoSchema.parse({ title: 't' }).status).toBe('uploaded');
  });

  it('defaults account status/upload_count', () => {
    const a = TiktokAccountSchema.parse({ name: 'n', aadvid: 'a', sid_guard_ads: 's' });
    expect(a.status).toBe('active');
    expect(a.upload_count).toBe(0);
  });

  it('validates processing plan + route', () => {
    expect(ProcessingRouteSchema.parse('remux')).toBe('remux');
    expect(() => ProcessingRouteSchema.parse('copy')).toThrow();
    expect(ProcessingPlanSchema.parse({ route: 'transcode', reason: 'r' }).route).toBe('transcode');
  });
});
```

- [ ] **Step 2: Write `test/config/config.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('getEnvConfig', () => {
  const saved = { ...process.env };
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { process.env = { ...saved }; });

  it('returns a parsed config', async () => {
    const { getEnvConfig } = await import('@/config');
    expect(getEnvConfig().SUPABASE_URL).toBe(process.env.SUPABASE_URL);
  });

  it('throws a wrapped error when required env is missing', async () => {
    delete process.env.TORBOX_TOKEN;
    const { getEnvConfig } = await import('@/config');
    expect(() => getEnvConfig()).toThrow(/Environment configuration error/);
  });
});
```

- [ ] **Step 3: Run + commit**

Run: `pnpm test test/types/schemas.test.ts test/config/config.test.ts` → Expected: PASS.
```bash
git add test/types/schemas.test.ts test/config/config.test.ts
git commit -m "test: cover zod schemas and env config"
```

---

## Task 8: Encoding strategies + factory tests

**Files:**
- Test: `test/services/encoding/strategies.test.ts`
- Test: `test/services/encoding/factory.test.ts`

- [ ] **Step 1: Write `test/services/encoding/strategies.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFfmpegMock } from '../../helpers/ffmpegMock';

const ff = makeFfmpegMock();
vi.mock('fluent-ffmpeg', () => ({ default: ff.ffmpeg }));

import { NvidiaEncodingStrategy } from '@/services/encoding/NvidiaEncodingStrategy';
import { IntelQsvEncodingStrategy } from '@/services/encoding/IntelQsvEncodingStrategy';
import { CpuEncodingStrategy } from '@/services/encoding/CpuEncodingStrategy';
import { AmdEncodingStrategy } from '@/services/encoding/AmdEncodingStrategy';
import { AppleVideoToolboxEncodingStrategy } from '@/services/encoding/AppleVideoToolboxEncodingStrategy';

const meta = (streams: unknown[]) => ({ streams, format: {} }) as any;

describe('NvidiaEncodingStrategy', () => {
  it('names itself and emits NVENC codec', () => {
    const s = new NvidiaEncodingStrategy('p4');
    expect(s.getName()).toBe('NVIDIA NVENC');
    expect(s.getOptions(meta([{ width: 1920, height: 1080 }]))).toContain('h264_nvenc');
  });

  it('adds a scale filter for >1080p sources', () => {
    const opts = new NvidiaEncodingStrategy().getOptions(meta([{ width: 3840, height: 2160 }]));
    expect(opts).toContain('-vf');
    expect(opts.join(' ')).toContain('scale=1920:1080');
  });

  it('isAvailable resolves true on ffmpeg end', async () => {
    ff.succeed();
    await expect(new NvidiaEncodingStrategy().isAvailable()).resolves.toBe(true);
  });

  it('isAvailable resolves false on ffmpeg error', async () => {
    ff.fail();
    await expect(new NvidiaEncodingStrategy().isAvailable()).resolves.toBe(false);
  });
});

describe('IntelQsvEncodingStrategy', () => {
  it('uses stream bitrate when present', () => {
    const opts = new IntelQsvEncodingStrategy().getOptions(
      meta([{ codec_type: 'video', bit_rate: '6000000', width: 1920 }])
    );
    expect(opts).toContain('h264_qsv');
    expect(opts.join(' ')).toContain('6000k');
  });

  it('estimates bitrate from resolution when missing', () => {
    const opts = new IntelQsvEncodingStrategy().getOptions(meta([{ codec_type: 'video', width: 1280 }]));
    expect(opts.join(' ')).toContain('20000k');
  });
});

describe('CpuEncodingStrategy', () => {
  it('emits libx264 fixed options', () => {
    const s = new CpuEncodingStrategy('medium');
    expect(s.getName()).toBe('CPU (libx264)');
    expect(s.getOptions()).toContain('libx264');
  });
});

describe('AMD + Apple strategies', () => {
  it('expose a name and option list', () => {
    expect(new AmdEncodingStrategy().getOptions(meta([{ width: 1920 }])).length).toBeGreaterThan(0);
    expect(new AppleVideoToolboxEncodingStrategy().getOptions(meta([{ width: 1920 }])).length).toBeGreaterThan(0);
  });
});
```

> **Executor note:** open `src/services/encoding/AmdEncodingStrategy.ts` and `AppleVideoToolboxEncodingStrategy.ts` and assert on their actual `getName()` strings + a representative codec flag (e.g. `h264_amf`, `h264_videotoolbox`). Add `isAvailable` true/false cases for QSV/CPU/AMD/Apple mirroring the NVENC ones to reach branch coverage.

- [ ] **Step 2: Write `test/services/encoding/factory.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Strategy doubles so we control isAvailable() without ffmpeg.
const makeStub = (name: string, available: boolean) => ({
  getName: () => name,
  isAvailable: vi.fn(async () => available),
  getOptions: () => [],
});

let nvAvailable = false;
let qsvAvailable = false;

vi.mock('@/services/encoding/NvidiaEncodingStrategy', () => ({
  NvidiaEncodingStrategy: vi.fn(() => makeStub('NVIDIA NVENC', nvAvailable)),
}));
vi.mock('@/services/encoding/IntelQsvEncodingStrategy', () => ({
  IntelQsvEncodingStrategy: vi.fn(() => makeStub('Intel Quick Sync Video', qsvAvailable)),
}));
vi.mock('@/services/encoding/CpuEncodingStrategy', () => ({
  CpuEncodingStrategy: vi.fn(() => makeStub('CPU (libx264)', true)),
}));

import { EncodingStrategyFactory } from '@/services/encoding/EncodingStrategyFactory';

describe('EncodingStrategyFactory', () => {
  beforeEach(() => {
    // Reset the static cache between tests.
    (EncodingStrategyFactory as unknown as { cachedStrategy: unknown }).cachedStrategy = null;
    nvAvailable = false;
    qsvAvailable = false;
  });

  it('selects NVENC first when available', async () => {
    nvAvailable = true;
    expect((await EncodingStrategyFactory.createStrategy()).getName()).toBe('NVIDIA NVENC');
  });

  it('falls through to QSV when NVENC is unavailable', async () => {
    qsvAvailable = true;
    expect((await EncodingStrategyFactory.createStrategy()).getName()).toBe('Intel Quick Sync Video');
  });

  it('falls back to libx264 when no GPU encoder is available', async () => {
    expect((await EncodingStrategyFactory.createStrategy()).getName()).toBe('CPU (libx264)');
  });

  it('caches the result (no re-probe on second call)', async () => {
    nvAvailable = true;
    const first = await EncodingStrategyFactory.createStrategy();
    const second = await EncodingStrategyFactory.createStrategy();
    expect(second).toBe(first);
  });

  it('getStrategyInfo reports available + recommended', async () => {
    nvAvailable = true;
    const info = await EncodingStrategyFactory.getStrategyInfo();
    expect(info.recommendedStrategy).toBe('NVIDIA NVENC');
    expect(info.availableStrategies).toContain('CPU (libx264)');
  });
});
```

- [ ] **Step 3: Run + commit**

Run: `pnpm test test/services/encoding` → Expected: PASS (after the executor note adjustments).
```bash
git add test/services/encoding
git commit -m "test: cover encoding strategies and factory"
```

---

## Task 9: ProcessingPlanner tests

**Files:**
- Test: `test/services/processingPlanner.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFfmpegMock } from '../helpers/ffmpegMock';
import { makeChildProcessMock } from '../helpers/childProcessMock';
import { KEYFRAME_CSV } from '../helpers/fixtures';

const ff = makeFfmpegMock();
let cp = makeChildProcessMock(KEYFRAME_CSV);

vi.mock('fluent-ffmpeg', () => ({ default: ff.ffmpeg }));
vi.mock('child_process', () => ({ execFile: (...args: unknown[]) => cp.execFile(...(args as [])) }));

import { ProcessingPlanner } from '@/services/processingPlanner';

describe('ProcessingPlanner', () => {
  beforeEach(() => {
    cp = makeChildProcessMock(KEYFRAME_CSV);
  });

  it('routes to remux when predicted segment is under budget', async () => {
    // Low bitrate (1 Mbps) × 6s max gap ≈ 0.75MB < 0.8×5MB budget.
    ff.setProbe({ streams: [{ codec_type: 'video', bit_rate: '1000000', width: 1920 }], format: {} });
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('remux');
    expect(plan.predictedMaxSegmentMB).toBeGreaterThan(0);
  });

  it('routes to transcode when predicted segment exceeds budget', async () => {
    // High bitrate (50 Mbps) × 6s ≈ 37MB > budget.
    ff.setProbe({ streams: [{ codec_type: 'video', bit_rate: '50000000', width: 1920 }], format: {} });
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('transcode');
  });

  it('defaults to transcode when probing throws', async () => {
    ff.setProbe(null, new Error('unreachable'));
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('transcode');
    expect(plan.reason).toContain('probe failed');
  });

  it('falls back to format bitrate, then resolution estimate', async () => {
    ff.setProbe({ streams: [{ codec_type: 'video', width: 1280 }], format: { bit_rate: '0' } });
    // width 1280 → 20 Mbps estimate → transcode at 6s gap.
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('transcode');
  });

  it('reports an infinite keyframe gap (→ transcode) when fewer than 2 keyframes sampled', async () => {
    cp = makeChildProcessMock('0.000000,K_\n');
    ff.setProbe({ streams: [{ codec_type: 'video', bit_rate: '1000000', width: 1920 }], format: {} });
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('transcode');
  });
});
```

- [ ] **Step 2: Run**

Run: `pnpm test test/services/processingPlanner.test.ts`
Expected: PASS. If the `child_process` mock isn't picked up by `promisify`, ensure the mock exports `execFile` as a named export and that `promisify(execFile)` resolves `{ stdout }` (the helper already shapes the callback that way).

- [ ] **Step 3: Commit**

```bash
git add test/services/processingPlanner.test.ts
git commit -m "test: cover ProcessingPlanner routing"
```

---

## Task 10: VideoProcessor tests (steganography core)

**Files:**
- Test: `test/services/videoProcessor.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFfmpegMock } from '../helpers/ffmpegMock';
import { makeFsMock } from '../helpers/fsMock';
import { wrapInPng, tsWithFFmpegMeta, tsClean, SAMPLE_M3U8 } from '../helpers/fixtures';

const ff = makeFfmpegMock();
let fsm = makeFsMock();

vi.mock('fluent-ffmpeg', () => ({ default: ff.ffmpeg }));
vi.mock('fs', () => ({ promises: fsm.promises, default: fsm.fsSync, ...fsm.fsSync }));
vi.mock('@/services/processingPlanner', () => ({
  ProcessingPlanner: vi.fn(() => ({ plan: vi.fn(async () => ({ route: 'transcode', reason: 'test' })) })),
}));
vi.mock('@/services/encoding/EncodingStrategyFactory', () => ({
  EncodingStrategyFactory: {
    createStrategy: vi.fn(async () => ({ getName: () => 'stub', getOptions: () => ['-c:v', 'libx264'] })),
  },
}));

import { VideoProcessor } from '@/services/videoProcessor';

beforeEach(() => {
  fsm = makeFsMock();
  // Re-point the fs mock module to the fresh instance.
  (fsm.promises as Record<string, unknown>) = fsm.promises;
});

describe('stripFFmpegMetadata (pure)', () => {
  const proc = () => new VideoProcessor() as any;

  it('removes the FFmpeg packet up to the next sync byte', () => {
    const out = proc().stripFFmpegMetadata(tsWithFFmpegMeta()) as Buffer;
    expect(out.indexOf(Buffer.from('FFmpeg'))).toBe(-1);
    expect(out[out.length - 5]).toBe(0x47);
  });

  it('returns input unchanged when no marker present', () => {
    const clean = tsClean();
    expect(proc().stripFFmpegMetadata(clean)).toBe(clean);
  });
});

describe('extractM3u8FromPng + validatePlaylist', () => {
  it('round-trips an embedded playlist', () => {
    const p = proc => proc as any;
    const processor = p(new VideoProcessor());
    fsm.files.set('/out/playlist.png', wrapInPng(SAMPLE_M3U8));
    const content = processor.extractM3u8FromPng('/out/playlist.png') as string;
    expect(content).toContain('#EXTM3U');
  });

  it('validatePlaylist counts segments and sums durations', async () => {
    const processor = new VideoProcessor() as any;
    fsm.files.set('/out/playlist.png', wrapInPng(SAMPLE_M3U8));
    const result = await processor.validatePlaylist('/out/playlist.png');
    expect(result.isValid).toBe(true);
    expect(result.segmentCount).toBe(2);
    expect(result.duration).toBeCloseTo(9.2, 1);
  });

  it('flags a playlist missing the HLS header', async () => {
    const processor = new VideoProcessor() as any;
    fsm.files.set('/out/playlist.png', wrapInPng('no-header\nsegment_000.png\n'));
    const result = await processor.validatePlaylist('/out/playlist.png');
    expect(result.isValid).toBe(false);
    expect(result.errors.join()).toContain('Missing HLS header');
  });
});

describe('wrapSegmentsInPng', () => {
  it('strips metadata, writes PNG, and unlinks the .ts', async () => {
    const processor = new VideoProcessor() as any;
    fsm.files.set('/out/segment_000.ts', tsWithFFmpegMeta());
    await processor.wrapSegmentsInPng('/out');
    expect(fsm.files.has('/out/segment_000.png')).toBe(true);
    expect(fsm.files.has('/out/segment_000.ts')).toBe(false);
  });
});

describe('updatePlaylistToUsePng', () => {
  it('rewrites .ts references to .png', async () => {
    const processor = new VideoProcessor() as any;
    fsm.files.set('/out/playlist.m3u8', Buffer.from(SAMPLE_M3U8));
    await processor.updatePlaylistToUsePng('/out');
    expect(fsm.files.get('/out/playlist.m3u8')!.toString()).toContain('segment_000.png');
  });

  it('throws when the playlist is missing', async () => {
    const processor = new VideoProcessor() as any;
    await expect(processor.updatePlaylistToUsePng('/missing')).rejects.toThrow('Playlist file not found');
  });
});

describe('processVideo orchestration', () => {
  it('runs the transcode route end to end', async () => {
    ff.succeed();
    ff.setProbe({ streams: [{ width: 1920, height: 1080 }], format: { duration: 30, size: 1000 } });
    const processor = new VideoProcessor();
    // Seed a segment + playlist that the run "produces".
    const dir = `${process.cwd()}/processed/q1`;
    // The conversion is mocked, so pre-seed outputs the later steps consume.
    fsm.files.set(`${dir}/segment_000.ts`, tsClean());
    fsm.files.set(`${dir}/playlist.m3u8`, Buffer.from(SAMPLE_M3U8.replace(/\.ts/g, '.ts')));
    await expect(processor.processVideo('http://src', 'q1')).resolves.toBeUndefined();
  });

  it('rethrows when a step fails', async () => {
    ff.fail();
    ff.setProbe(null, new Error('probe boom'));
    const processor = new VideoProcessor();
    await expect(processor.processVideo('http://src', 'q2')).rejects.toBeTruthy();
  });
});
```

> **Executor note:** `processVideo` composes many private steps against the fs mock; the two orchestration cases above are the highest-value. If wiring the full happy path proves brittle, prefer testing the private steps directly (as the other `describe` blocks do) — they deliver the same coverage with less mock choreography. Add a `remux` route case (planner stub returns `{route:'remux'}`, `validateSegmentSizes` finds nothing oversize) and a `remux→transcode` fallback case (seed an oversize `.ts` so `validateSegmentSizes` triggers `clearTsAndPlaylist` + `convertVideoToHLS`).

- [ ] **Step 2: Run**

Run: `pnpm test test/services/videoProcessor.test.ts`
Expected: PASS. Iterate on the fs mock wiring until green; do not modify `src/`.

- [ ] **Step 3: Commit**

```bash
git add test/services/videoProcessor.test.ts
git commit -m "test: cover VideoProcessor steganography + orchestration"
```

---

## Task 11: TiktokUploadService + ApiClientService tests

**Files:**
- Test: `test/services/tiktok/TiktokUploadService.test.ts`
- Test: `test/services/apiClientService.test.ts`

- [ ] **Step 1: Write `test/services/apiClientService.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';

const instance = {
  get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn(),
  defaults: { headers: { common: {} as Record<string, string> } },
};
vi.mock('axios', () => ({ default: { create: vi.fn(() => instance) } }));

import { ApiClientService } from '@/services/apiClientService';

describe('ApiClientService', () => {
  it('delegates verbs to the axios instance', () => {
    const c = new ApiClientService('http://api');
    c.get('u'); c.post('u', {}); c.put('u', {}); c.delete('u'); c.patch('u', {});
    expect(instance.get).toHaveBeenCalledWith('u', undefined);
    expect(instance.post).toHaveBeenCalled();
  });

  it('sets headers and builds a cookie string', () => {
    const c = new ApiClientService('http://api');
    c.setHeader('Host', 'h');
    c.appendCookie({ a: '1', b: '2' });
    expect(instance.defaults.headers.common['Host']).toBe('h');
    expect(instance.defaults.headers.common['Cookie']).toBe('a=1; b=2');
  });
});
```

- [ ] **Step 2: Write `test/services/tiktok/TiktokUploadService.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { account } from '../../helpers/fixtures';

const post = vi.fn();
vi.mock('@/services/apiClientService', () => ({
  ApiClientService: vi.fn(() => ({ post, setHeader: vi.fn() })),
}));
vi.mock('fs', () => ({
  promises: { stat: vi.fn(async () => ({ size: 100 })) },
  createReadStream: vi.fn(() => ({})),
}));

import { TiktokUploadService } from '@/services/tiktok/TiktokUploadService';

const okResponse = { data: { status_code: 0, data: { uri: '/img/x.png', url_list: [], url_prefix: '' } } };

describe('TiktokUploadService', () => {
  beforeEach(() => { vi.useFakeTimers(); post.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns the CDN URL on success', async () => {
    post.mockResolvedValue(okResponse);
    const url = await new TiktokUploadService().performUpload('/f/segment_000.png', account());
    expect(url).toContain('img/x.png');
  });

  it('returns null when status_code is non-zero', async () => {
    post.mockResolvedValue({ data: { status_code: 10, status_msg: 'bad' } });
    expect(await new TiktokUploadService().performUpload('/f.png', account())).toBeNull();
  });

  it('throws when the account has no CSRF token', async () => {
    await expect(new TiktokUploadService().performUpload('/f.png', account({ csrftoken: null })))
      .rejects.toThrow(/CSRF token/);
  });

  it('retries on a 5xx then succeeds', async () => {
    const err = Object.assign(new Error('5xx'), { response: { status: 503 } });
    post.mockRejectedValueOnce(err).mockResolvedValueOnce(okResponse);
    const promise = new TiktokUploadService().performUpload('/f.png', account());
    await vi.runAllTimersAsync();
    expect(await promise).toContain('img/x.png');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('rethrows a non-retryable error immediately', async () => {
    const err = Object.assign(new Error('403'), { response: { status: 403 } });
    post.mockRejectedValue(err);
    await expect(new TiktokUploadService().performUpload('/f.png', account())).rejects.toBe(err);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('getContentType', () => {
  it('maps extensions and defaults to octet-stream', () => {
    const svc = new TiktokUploadService() as any;
    expect(svc.getContentType('a.png')).toBe('image/png');
    expect(svc.getContentType('a.mp4')).toBe('video/mp4');
    expect(svc.getContentType('a.xyz')).toBe('application/octet-stream');
  });
});
```

- [ ] **Step 3: Run + commit**

Run: `pnpm test test/services/apiClientService.test.ts test/services/tiktok` → Expected: PASS.
```bash
git add test/services/apiClientService.test.ts test/services/tiktok
git commit -m "test: cover TiktokUploadService and ApiClientService"
```

---

## Task 12: TiktokUploadOrchestrator tests

**Files:**
- Test: `test/services/tiktokUploadOrchestrator.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeFsMock } from '../helpers/fsMock';
import { wrapInPng, account } from '../helpers/fixtures';

let fsm = makeFsMock();
const getActiveAccounts = vi.fn();
const updateUploadStats = vi.fn(async () => undefined);
const setAccountLimited = vi.fn(async () => undefined);
const performUpload = vi.fn();

vi.mock('fs', () => ({ promises: fsm.promises }));
vi.mock('@/services/tiktokAccountService', () => ({
  TiktokAccountService: vi.fn(() => ({ getActiveAccounts, updateUploadStats, setAccountLimited })),
}));
vi.mock('@/services/tiktok/TiktokUploadService', () => ({
  TiktokUploadService: vi.fn(() => ({ performUpload })),
}));

import { TiktokUploadOrchestrator } from '@/services/tiktokUploadOrchestrator';

const PLAYLIST = '#EXTM3U\n#EXTINF:5,\nsegment_000.png\n';

beforeEach(() => {
  fsm = makeFsMock();
  getActiveAccounts.mockReset().mockResolvedValue([account({ id: 'a1', name: 'a1' })]);
  performUpload.mockReset();
  updateUploadStats.mockClear();
  setAccountLimited.mockClear();
});

describe('uploadProcessedFiles', () => {
  it('throws when there are no active accounts', async () => {
    getActiveAccounts.mockResolvedValue([]);
    await expect(new TiktokUploadOrchestrator().uploadProcessedFiles('/out')).rejects.toThrow('No active');
  });

  it('uploads segments + playlist and returns the playlist URL', async () => {
    fsm.files.set('/out/segment_000.png', wrapInPng('seg'));
    fsm.files.set('/out/playlist.png', wrapInPng(PLAYLIST));
    performUpload.mockResolvedValue('https://cdn/uploaded.png');
    const url = await new TiktokUploadOrchestrator().uploadProcessedFiles('/out');
    expect(url).toBe('https://cdn/uploaded.png');
    expect(updateUploadStats).toHaveBeenCalled();
  });

  it('throws when no playlist file is present', async () => {
    fsm.files.set('/out/segment_000.png', wrapInPng('seg'));
    performUpload.mockResolvedValue('https://cdn/x.png');
    await expect(new TiktokUploadOrchestrator().uploadProcessedFiles('/out')).rejects.toThrow('playlist');
  });
});

describe('isRateLimitedError + 403 handling', () => {
  it('marks the account limited on a 403 during single upload', async () => {
    const orch = new TiktokUploadOrchestrator() as any;
    performUpload.mockRejectedValue(Object.assign(new Error('403'), { response: { status: 403 } }));
    const result = await orch.uploadSingleFile('/out/segment_000.png', account({ id: 'a1' }));
    expect(result.success).toBe(false);
    expect(setAccountLimited).toHaveBeenCalledWith('a1');
  });

  it('isRateLimitedError detects 403 only', () => {
    const orch = new TiktokUploadOrchestrator() as any;
    expect(orch.isRateLimitedError({ response: { status: 403 } })).toBe(true);
    expect(orch.isRateLimitedError({ response: { status: 500 } })).toBe(false);
    expect(orch.isRateLimitedError('nope')).toBe(false);
  });
});

describe('playlist URL rewriting', () => {
  it('extracts, rewrites, and re-embeds segment URLs', async () => {
    fsm.files.set('/out/playlist.png', wrapInPng(PLAYLIST));
    const orch = new TiktokUploadOrchestrator() as any;
    const updatedPath = await orch.updatePlaylistUrls('/out/playlist.png', [
      { success: true, uploadedUrl: 'https://cdn/seg0.png', originalPath: 'segment_000.png', filePath: '/out/segment_000.png', accountId: 'a1' },
    ]);
    expect(updatedPath).toContain('_updated.png');
    const written = fsm.files.get(updatedPath)!;
    expect(written.toString('utf8')).toContain('https://cdn/seg0.png');
  });
});

describe('retryFailedUploads', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries a failed upload on a rotated account and succeeds', async () => {
    getActiveAccounts.mockResolvedValue([account({ id: 'a1' }), account({ id: 'a2' })]);
    performUpload.mockResolvedValue('https://cdn/ok.png');
    const orch = new TiktokUploadOrchestrator() as any;
    const failed = [{ success: false, uploadedUrl: null, originalPath: 'segment_000.png', filePath: '/out/segment_000.png', accountId: 'a1', error: 'x' }];
    const promise = orch.retryFailedUploads(failed, [account({ id: 'a1' }), account({ id: 'a2' })]);
    await vi.runAllTimersAsync();
    const results = await promise;
    expect(results[0].success).toBe(true);
  });
});
```

- [ ] **Step 2: Run**

Run: `pnpm test test/services/tiktokUploadOrchestrator.test.ts`
Expected: PASS. Use `vi.runAllTimersAsync()` whenever a path goes through backoff delays.

- [ ] **Step 3: Commit**

```bash
git add test/services/tiktokUploadOrchestrator.test.ts
git commit -m "test: cover TiktokUploadOrchestrator batching + retries"
```

---

## Task 13: Data service tests (queue, video, account, torbox, indexnow)

**Files:**
- Test: `test/services/queueService.test.ts`
- Test: `test/services/videoService.test.ts`
- Test: `test/services/tiktokAccountService.test.ts`
- Test: `test/services/torboxService.test.ts`
- Test: `test/services/indexNowService.test.ts`

Each uses `vi.mock('@/config/supabase', ...)` with `makeSupabaseMock`. Because the mock is module-level, re-script results per test with `vi.resetModules()` + dynamic import, **or** expose a mutable results array. Pattern below uses a mutable array captured in the factory.

- [ ] **Step 1: Write `test/services/queueService.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queueItem } from '../helpers/fixtures';

let results: { data: unknown; error: unknown }[] = [];
vi.mock('@/config/supabase', () => {
  const builder: any = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'order', 'limit']) builder[m] = () => builder;
  builder.single = () => Promise.resolve(results.length > 1 ? results.shift() : results[0]);
  builder.then = (f: (v: unknown) => unknown) => Promise.resolve(results.length > 1 ? results.shift() : results[0]).then(f);
  return { supabase: { from: () => builder } };
});

import { QueueService } from '@/services/queueService';

beforeEach(() => { results = []; });

describe('QueueService.getNextItem', () => {
  it('returns null when a video is already processing', async () => {
    results = [{ data: [{ id: 'p' }], error: null }];
    expect(await new QueueService().getNextItem()).toBeNull();
  });

  it('returns null when no queued items exist', async () => {
    results = [{ data: [], error: null }, { data: [], error: null }];
    expect(await new QueueService().getNextItem()).toBeNull();
  });

  it('claims the next queued item atomically', async () => {
    const item = queueItem({ status: 'queued' });
    results = [
      { data: [], error: null },           // no processing
      { data: [item], error: null },        // queued select
      { data: { ...item, status: 'processing' }, error: null }, // claim update
    ];
    const claimed = await new QueueService().getNextItem();
    expect(claimed?.status).toBe('processing');
  });

  it('returns null when another instance already claimed it', async () => {
    const item = queueItem();
    results = [
      { data: [], error: null },
      { data: [item], error: null },
      { data: null, error: null },          // claim returns nothing
    ];
    expect(await new QueueService().getNextItem()).toBeNull();
  });
});

describe('QueueService writes', () => {
  it('addToQueue inserts and returns the parsed item', async () => {
    results = [
      { data: [{ index: 4 }], error: null },             // getNextIndex
      { data: queueItem({ index: 5 }), error: null },    // insert
    ];
    const created = await new QueueService().addToQueue('n', 't', 'f');
    expect(created.index).toBe(5);
  });

  it('updateStatus throws on a supabase error', async () => {
    results = [{ data: null, error: { message: 'boom' } }];
    await expect(new QueueService().updateStatus('id', 'failed', 0)).rejects.toThrow('boom');
  });
});
```

> **Executor note:** apply the same module-mock pattern to the other four data services. Cover, per the spec §4.4: `videoService` find-or-create network/actress (PGRST116 → create path, other error → throw), `createVideo` title/description fallbacks; `tiktokAccountService` mapping + empty + `setAccountLimited` cooldown timestamp (use `vi.setSystemTime`); `torboxService` success + no-data/`data.error`/no-URL branches (mock `@torbox/torbox-api`'s `TorboxApi` with `torrents.requestDownloadLink`); `indexNowService` 200/202/unexpected + error-swallowed + empty-array early return (mock `axios`).

- [ ] **Step 2: Write the remaining four data-service tests** following the executor note. Run each as you go: `pnpm test test/services/<name>.test.ts`.

- [ ] **Step 3: Run all data-service tests + commit**

Run: `pnpm test test/services` → Expected: PASS.
```bash
git add test/services/queueService.test.ts test/services/videoService.test.ts test/services/tiktokAccountService.test.ts test/services/torboxService.test.ts test/services/indexNowService.test.ts
git commit -m "test: cover queue, video, account, torbox, indexnow services"
```

---

## Task 14: Pipeline tests (ProcessingService + Scheduler)

**Files:**
- Test: `test/services/processingService.test.ts`
- Test: `test/services/scheduler.test.ts`

- [ ] **Step 1: Write `test/services/processingService.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queueItem, video } from '../helpers/fixtures';

const getNextItem = vi.fn();
const updateStatus = vi.fn(async () => undefined);
const requestDownloadUrl = vi.fn(async () => 'http://video');
const processVideo = vi.fn(async () => undefined);
const uploadProcessedFiles = vi.fn(async () => 'https://cdn/playlist.png');
const createVideo = vi.fn(async () => video());
const updateVideoStatus = vi.fn(async () => video());
const submitVideo = vi.fn(async () => undefined);

vi.mock('@/services/queueService', () => ({ QueueService: vi.fn(() => ({ getNextItem, updateStatus })) }));
vi.mock('@/services/torboxService', () => ({ TorboxService: vi.fn(() => ({ requestDownloadUrl })) }));
vi.mock('@/services/videoProcessor', () => ({ VideoProcessor: vi.fn(() => ({ processVideo })) }));
vi.mock('@/services/tiktokUploadOrchestrator', () => ({ TiktokUploadOrchestrator: vi.fn(() => ({ uploadProcessedFiles })) }));
vi.mock('@/services/videoService', () => ({ VideoService: vi.fn(() => ({ createVideo, updateVideoStatus })) }));
vi.mock('@/services/indexNowService', () => ({ IndexNowService: vi.fn(() => ({ submitVideo })) }));
vi.mock('fs', () => ({ promises: { access: vi.fn(async () => undefined), rm: vi.fn(async () => undefined) } }));

import { ProcessingService } from '@/services/processingService';

beforeEach(() => {
  getNextItem.mockReset();
  updateStatus.mockClear();
  processVideo.mockReset().mockResolvedValue(undefined);
});

describe('ProcessingService.processNextVideo', () => {
  it('returns early when the queue is empty', async () => {
    getNextItem.mockResolvedValue(null);
    await new ProcessingService().processNextVideo();
    expect(requestDownloadUrl).not.toHaveBeenCalled();
  });

  it('runs the full pipeline and marks the item processed', async () => {
    getNextItem.mockResolvedValue(queueItem());
    await new ProcessingService().processNextVideo();
    expect(updateStatus).toHaveBeenCalledWith(expect.any(String), 'processed', 100);
  });

  it('marks the item failed and rethrows when a step throws', async () => {
    getNextItem.mockResolvedValue(queueItem());
    processVideo.mockRejectedValue(new Error('encode failed'));
    await expect(new ProcessingService().processNextVideo()).rejects.toThrow('encode failed');
    expect(updateStatus).toHaveBeenCalledWith(expect.any(String), 'failed', 0);
  });

  it('throws when torrent_id/file_id are missing', async () => {
    getNextItem.mockResolvedValue(queueItem({ torrent_id: null, file_id: null }));
    await expect(new ProcessingService().processNextVideo()).rejects.toThrow();
    expect(updateStatus).toHaveBeenCalledWith(expect.any(String), 'failed', 0);
  });
});
```

- [ ] **Step 2: Write `test/services/scheduler.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const processNextVideo = vi.fn(async () => undefined);
vi.mock('@/services/processingService', () => ({
  ProcessingService: vi.fn(() => ({ processNextVideo })),
}));

import { Scheduler } from '@/services/scheduler';

beforeEach(() => { vi.useFakeTimers(); processNextVideo.mockReset().mockResolvedValue(undefined); });
afterEach(() => { vi.useRealTimers(); });

describe('Scheduler', () => {
  it('runs immediately on start and is running', () => {
    const s = new Scheduler(1);
    s.start();
    expect(s.isRunning()).toBe(true);
    expect(processNextVideo).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('fires again after the interval', async () => {
    const s = new Scheduler(1);
    s.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(processNextVideo.mock.calls.length).toBeGreaterThanOrEqual(2);
    s.stop();
  });

  it('does not start twice', () => {
    const s = new Scheduler();
    s.start();
    s.start();
    s.stop();
    expect(s.isRunning()).toBe(false);
  });

  it('reports interval minutes and stops cleanly when not running', () => {
    const s = new Scheduler(2);
    expect(s.getIntervalMinutes()).toBe(2);
    s.stop(); // not running — should not throw
    expect(s.isRunning()).toBe(false);
  });

  it('swallows task errors', async () => {
    processNextVideo.mockRejectedValueOnce(new Error('task boom'));
    const s = new Scheduler(1);
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.isRunning()).toBe(true);
    s.stop();
  });
});
```

- [ ] **Step 3: Run + commit**

Run: `pnpm test test/services/processingService.test.ts test/services/scheduler.test.ts` → Expected: PASS.
```bash
git add test/services/processingService.test.ts test/services/scheduler.test.ts
git commit -m "test: cover ProcessingService pipeline and Scheduler"
```

---

## Task 15: Coverage gate — close gaps to ≥90%

**Files:**
- Modify: any `test/**` file with thin coverage
- Remove: `test/smoke.test.ts` (no longer needed)

- [ ] **Step 1: Run full coverage**

Run: `pnpm test:coverage`
Expected: a coverage table. Note any file under 90% in lines/branches/functions/statements.

- [ ] **Step 2: Inspect uncovered lines**

Open `coverage/index.html` (or read the `text` report). For each red line, identify the missing branch (usually an untested error path or a conditional).

- [ ] **Step 3: Add targeted tests for each gap**

For every uncovered branch, add a focused test in the relevant existing spec that drives that path (e.g. a `{ error }` Supabase result, an ffprobe rejection, an empty-array input). Re-run `pnpm test:coverage` after each addition.

- [ ] **Step 4: Remove the smoke test**

```bash
git rm test/smoke.test.ts
```

- [ ] **Step 5: Confirm the gate passes**

Run: `pnpm test:coverage`
Expected: exit code 0; all four metrics ≥ 90% on the included files (no threshold failure).

- [ ] **Step 6: Run the full verification trio**

Run: `pnpm type-check && pnpm lint:check && pnpm test:coverage`
Expected: all three pass. Fix any TypeScript/lint issues introduced by the test files (e.g. add `test/**` to `tsconfig` includes if `@/` aliases don't resolve in test files, or add an eslint override allowing `as any` in `test/**`).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test: close coverage gaps to >=90% and drop smoke test"
```

---

## Task 16: Finalize

- [ ] **Step 1: Update CLAUDE.md testing note**

In `CLAUDE.md`, replace "There is **no test suite**. Verify changes with `pnpm type-check` and `pnpm lint:check`." with: "Verify changes with `pnpm type-check`, `pnpm lint:check`, and `pnpm test:coverage` (Vitest, ≥90% coverage; boundaries mocked under `test/helpers/`)."

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note the vitest test suite in CLAUDE.md"
```

- [ ] **Step 3: Push and open a PR (only if the user asks)**

```bash
git push -u origin test/test-suite
gh pr create --base develop --title "test: add vitest suite (≥90% coverage)" --body "Adds a fully-mocked Vitest suite covering the full pipeline. No production code changed."
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** Tasks 6–14 map 1:1 to spec §4.1–§4.6; Task 1 = §2; Tasks 2–5 = §3; Task 15 enforces §5; §6 (out of scope) is respected (no integration/E2E/refactors).
- **Mock-wiring reality:** module-level `vi.mock` factories cannot reference outer non-hoisted variables that are initialized *after* the mock runs. Where a test needs per-case results (data services), the factory closes over a `let results` array reset in `beforeEach` — see Task 13. Keep that pattern.
- **Fake timers:** any path through `delay`/backoff/`setInterval` must use `vi.useFakeTimers()` + `vi.runAllTimersAsync()`/`advanceTimersByTimeAsync`, or the test will hang.
- **No production changes:** all private-method access is via `as any` casts in the test only.
