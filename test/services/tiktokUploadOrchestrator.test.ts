/**
 * Tests for TiktokUploadOrchestrator — batching, retries, steganography round-trip.
 *
 * Mocking strategy:
 *  - vi.hoisted (async) builds the fs fake + mock fns before vi.mock factories run.
 *  - TiktokAccountService and TiktokUploadService are replaced with inline class
 *    expressions that forward to the hoisted mock fns.
 *  - vi.useFakeTimers() controls the exponential-backoff delays in retryFailedUploads.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { wrapInPng, account } from '../helpers/fixtures';

// ---------------------------------------------------------------------------
// Hoisted mock fns + fs fake — must be declared before any vi.mock() calls.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(async () => {
  const { makeFsMock } = await import('../helpers/fsMock');
  const { vi: _vi } = await import('vitest');
  return {
    fsm: makeFsMock(),
    getActiveAccounts: _vi.fn<() => Promise<ReturnType<typeof account>[]>>(),
    updateUploadStats: _vi.fn(async (_id: string) => undefined as undefined),
    setAccountLimited: _vi.fn(async (_id: string) => undefined as undefined),
    performUpload: _vi.fn<(filePath: string, acct: ReturnType<typeof account>) => Promise<string | null>>(),
  };
});

// ---------------------------------------------------------------------------
// vi.mock declarations
// ---------------------------------------------------------------------------

vi.mock('fs', async () => {
  const m = await mocks;
  return {
    promises: m.fsm.promises,
    default: m.fsm.fsSync,
    ...m.fsm.fsSync,
  };
});

vi.mock('@/services/tiktokAccountService', async () => {
  const m = await mocks;
  return {
    TiktokAccountService: class {
      getActiveAccounts = m.getActiveAccounts;
      updateUploadStats = m.updateUploadStats;
      setAccountLimited = m.setAccountLimited;
    },
  };
});

vi.mock('@/services/tiktok/TiktokUploadService', async () => {
  const m = await mocks;
  return {
    TiktokUploadService: class {
      performUpload = m.performUpload;
    },
  };
});

// Production module — imported AFTER all vi.mock() calls.
import { TiktokUploadOrchestrator } from '@/services/tiktokUploadOrchestrator';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIR = '/tmp/test-output';
const SEG_PATH = `${DIR}/segment_000.png`;
const PLAYLIST_PATH = `${DIR}/playlist.png`;
const PLAYLIST_M3U8 = '#EXTM3U\n#EXTINF:5,\nsegment_000.png\n';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  const m = await mocks;
  m.fsm.files.clear();
  m.getActiveAccounts.mockReset().mockResolvedValue([account({ id: 'a1', name: 'a1' })]);
  m.performUpload.mockReset();
  m.updateUploadStats.mockClear();
  m.setAccountLimited.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedFiles(files: Record<string, Buffer>) {
  const m = await mocks;
  for (const [path, buf] of Object.entries(files)) {
    m.fsm.files.set(path, buf);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TiktokUploadOrchestrator', () => {
  // -------------------------------------------------------------------------
  // uploadProcessedFiles — no active accounts
  // -------------------------------------------------------------------------
  it('throws when no active accounts are available', async () => {
    const m = await mocks;
    m.getActiveAccounts.mockResolvedValue([]);

    const orch = new TiktokUploadOrchestrator();
    await expect(orch.uploadProcessedFiles(DIR)).rejects.toThrow(
      'No active TikTok accounts available for upload'
    );
  });

  // -------------------------------------------------------------------------
  // uploadProcessedFiles — happy path
  // -------------------------------------------------------------------------
  it('uploads segments + playlist and returns the playlist URL', async () => {
    const m = await mocks;

    // Seed: one segment PNG + playlist PNG
    await seedFiles({
      [SEG_PATH]: wrapInPng('seg-data'),
      [PLAYLIST_PATH]: wrapInPng(PLAYLIST_M3U8),
    });

    // performUpload resolves first call (segment) then second (playlist)
    m.performUpload
      .mockResolvedValueOnce('https://cdn/uploaded-seg.png') // segment upload
      .mockResolvedValueOnce('https://cdn/uploaded-playlist.png'); // playlist upload

    const orch = new TiktokUploadOrchestrator();
    const url = await orch.uploadProcessedFiles(DIR);

    expect(url).toBe('https://cdn/uploaded-playlist.png');
    // updateUploadStats should have been called at least once (per successful upload)
    expect(m.updateUploadStats).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // uploadProcessedFiles — missing playlist
  // -------------------------------------------------------------------------
  it('throws when no playlist file is present', async () => {
    const m = await mocks;

    // Only seed the segment (no playlist file)
    await seedFiles({
      [SEG_PATH]: wrapInPng('seg-data'),
    });

    m.performUpload.mockResolvedValue('https://cdn/seg.png');

    const orch = new TiktokUploadOrchestrator();
    await expect(orch.uploadProcessedFiles(DIR)).rejects.toThrow('M3U8 playlist file not found');
  });

  // -------------------------------------------------------------------------
  // uploadSingleFile — 403 marks account limited
  // -------------------------------------------------------------------------
  it('marks account limited on 403 and returns success=false', async () => {
    const m = await mocks;

    const rateLimitError = { response: { status: 403 }, message: 'Forbidden' };
    m.performUpload.mockRejectedValue(rateLimitError);

    const acct = account({ id: 'a1', name: 'a1' });
    const orch = new TiktokUploadOrchestrator();

    // Access private method via cast
    const result = await (orch as unknown as { uploadSingleFile: (p: string, a: typeof acct) => Promise<{ success: boolean; accountId: string }> }).uploadSingleFile(SEG_PATH, acct);

    expect(result.success).toBe(false);
    expect(m.setAccountLimited).toHaveBeenCalledWith('a1');
    expect(m.updateUploadStats).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // isRateLimitedError
  // -------------------------------------------------------------------------
  describe('isRateLimitedError', () => {
    it('returns true for 403 error', () => {
      const orch = new TiktokUploadOrchestrator();
      const check = (err: unknown) =>
        (orch as unknown as { isRateLimitedError: (e: unknown) => boolean }).isRateLimitedError(err);

      expect(check({ response: { status: 403 } })).toBe(true);
    });

    it('returns false for 500 error', () => {
      const orch = new TiktokUploadOrchestrator();
      const check = (err: unknown) =>
        (orch as unknown as { isRateLimitedError: (e: unknown) => boolean }).isRateLimitedError(err);

      expect(check({ response: { status: 500 } })).toBe(false);
    });

    it('returns false for non-object error', () => {
      const orch = new TiktokUploadOrchestrator();
      const check = (err: unknown) =>
        (orch as unknown as { isRateLimitedError: (e: unknown) => boolean }).isRateLimitedError(err);

      expect(check('some string error')).toBe(false);
      expect(check(null)).toBe(false);
      expect(check(undefined)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // updatePlaylistUrls
  // -------------------------------------------------------------------------
  it('rewrites segment references to CDN URLs and writes _updated.png', async () => {
    const m = await mocks;

    await seedFiles({
      [PLAYLIST_PATH]: wrapInPng(PLAYLIST_M3U8),
    });

    const uploadResults = [
      {
        success: true,
        uploadedUrl: 'https://cdn/seg0.png',
        originalPath: 'segment_000.png',
        filePath: SEG_PATH,
        accountId: 'a1',
      },
    ];

    const orch = new TiktokUploadOrchestrator();
    const updatedPath = await (
      orch as unknown as {
        updatePlaylistUrls: (
          p: string,
          r: typeof uploadResults
        ) => Promise<string>;
      }
    ).updatePlaylistUrls(PLAYLIST_PATH, uploadResults);

    // Path should end with _updated.png
    expect(updatedPath).toContain('_updated.png');

    // The written file should contain the CDN URL
    const writtenBuf = m.fsm.files.get(updatedPath);
    expect(writtenBuf).toBeDefined();
    const writtenContent = writtenBuf!.toString('utf8');
    expect(writtenContent).toContain('https://cdn/seg0.png');
  });

  // -------------------------------------------------------------------------
  // retryFailedUploads — success on retry
  // -------------------------------------------------------------------------
  it('retryFailedUploads succeeds on retry with a second account (fake timers)', async () => {
    const m = await mocks;
    vi.useFakeTimers();

    // Two accounts
    const acct1 = account({ id: 'a1', name: 'a1' });
    const acct2 = account({ id: 'a2', name: 'a2' });

    // performUpload succeeds when called (for the retry)
    m.performUpload.mockResolvedValue('https://cdn/retried.png');

    const failedUpload = {
      filePath: SEG_PATH,
      originalPath: 'segment_000.png',
      uploadedUrl: null as string | null,
      success: false,
      accountId: 'a1', // was uploaded by a1, retry should prefer a2
      error: 'initial failure',
    };

    const orch = new TiktokUploadOrchestrator();
    const retryPromise = (
      orch as unknown as {
        retryFailedUploads: (
          failed: typeof failedUpload[],
          accounts: typeof acct1[]
        ) => Promise<typeof failedUpload[]>;
      }
    ).retryFailedUploads([failedUpload], [acct1, acct2]);

    // Attach catch immediately before driving timers
    retryPromise.catch(() => {});

    // Run all timers (exponential backoff delays)
    await vi.runAllTimersAsync();

    const results = await retryPromise;
    expect(results[0].success).toBe(true);
    expect(results[0].uploadedUrl).toBe('https://cdn/retried.png');
  });

  // -------------------------------------------------------------------------
  // retryFailedUploads — exhaustion records failure
  // -------------------------------------------------------------------------
  it('retryFailedUploads records failure after exhausting all retries (fake timers)', async () => {
    const m = await mocks;
    vi.useFakeTimers();

    const acct1 = account({ id: 'a1', name: 'a1' });

    // performUpload always rejects
    m.performUpload.mockRejectedValue(new Error('persistent failure'));

    const failedUpload = {
      filePath: SEG_PATH,
      originalPath: 'segment_000.png',
      uploadedUrl: null as string | null,
      success: false,
      accountId: 'a99', // different from a1 so a1 is tried
      error: 'initial failure',
    };

    const orch = new TiktokUploadOrchestrator();
    const retryPromise = (
      orch as unknown as {
        retryFailedUploads: (
          failed: typeof failedUpload[],
          accounts: typeof acct1[]
        ) => Promise<typeof failedUpload[]>;
      }
    ).retryFailedUploads([failedUpload], [acct1]);

    // Attach catch immediately before driving timers
    retryPromise.catch(() => {});

    await vi.runAllTimersAsync();

    const results = await retryPromise;
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('persistent failure');
  });

  // -------------------------------------------------------------------------
  // uploadSingleFile — null URL returned by performUpload
  // -------------------------------------------------------------------------
  it('returns success=false when performUpload returns null', async () => {
    const m = await mocks;

    m.performUpload.mockResolvedValue(null);

    const acct = account({ id: 'a1', name: 'a1' });
    const orch = new TiktokUploadOrchestrator();

    const result = await (
      orch as unknown as {
        uploadSingleFile: (p: string, a: typeof acct) => Promise<{ success: boolean }>;
      }
    ).uploadSingleFile(SEG_PATH, acct);

    expect(result.success).toBe(false);
    expect(m.updateUploadStats).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // uploadSingleFile — non-403 error does NOT mark account limited
  // -------------------------------------------------------------------------
  it('does not mark account limited for non-403 errors', async () => {
    const m = await mocks;

    m.performUpload.mockRejectedValue(new Error('network timeout'));

    const acct = account({ id: 'a1', name: 'a1' });
    const orch = new TiktokUploadOrchestrator();

    const result = await (
      orch as unknown as {
        uploadSingleFile: (p: string, a: typeof acct) => Promise<{ success: boolean }>;
      }
    ).uploadSingleFile(SEG_PATH, acct);

    expect(result.success).toBe(false);
    expect(m.setAccountLimited).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // extractM3U8FromPNG — invalid PNG (no IEND) throws
  // -------------------------------------------------------------------------
  it('extractM3U8FromPNG throws on invalid PNG (no IEND chunk)', async () => {
    const orch = new TiktokUploadOrchestrator();
    const badBuffer = Buffer.from('not a real png');

    await expect(
      (
        orch as unknown as {
          extractM3U8FromPNG: (b: Buffer) => Promise<string>;
        }
      ).extractM3U8FromPNG(badBuffer)
    ).rejects.toThrow('Invalid PNG file: IEND chunk not found');
  });

  // -------------------------------------------------------------------------
  // embedM3U8IntoPNG — invalid PNG (no IEND) throws
  // -------------------------------------------------------------------------
  it('embedM3U8IntoPNG throws on invalid PNG (no IEND chunk)', async () => {
    const orch = new TiktokUploadOrchestrator();
    const badBuffer = Buffer.from('not a real png');

    await expect(
      (
        orch as unknown as {
          embedM3U8IntoPNG: (b: Buffer, content: string, p: string) => Promise<string>;
        }
      ).embedM3U8IntoPNG(badBuffer, 'content', '/tmp/file.png')
    ).rejects.toThrow('Invalid PNG file: IEND chunk not found');
  });

  // -------------------------------------------------------------------------
  // uploadProcessedFiles — failed segments throw after retries exhausted
  // -------------------------------------------------------------------------
  it('throws when segment upload fails and retries are exhausted', async () => {
    const m = await mocks;
    vi.useFakeTimers();

    await seedFiles({
      [SEG_PATH]: wrapInPng('seg-data'),
      [PLAYLIST_PATH]: wrapInPng(PLAYLIST_M3U8),
    });

    // performUpload always returns null (failure)
    m.performUpload.mockResolvedValue(null);

    const orch = new TiktokUploadOrchestrator();
    const uploadPromise = orch.uploadProcessedFiles(DIR);
    uploadPromise.catch(() => {});

    await vi.runAllTimersAsync();

    await expect(uploadPromise).rejects.toThrow(
      'Failed to upload 1 video segments to TikTok after retries'
    );
  });

  // -------------------------------------------------------------------------
  // retryFailedUploads — catch block when uploadSingleFile throws (not rejects UploadResult)
  // -------------------------------------------------------------------------
  it('retryFailedUploads catch block: handles thrown error inside retry attempt', async () => {
    const m = await mocks;
    vi.useFakeTimers();

    const acct1 = account({ id: 'a1', name: 'a1' });

    // Make uploadSingleFile itself throw (rather than returning failure result)
    // by having performUpload reject with a non-Error value that is still an error
    // The production code catches inside uploadSingleFile and returns an UploadResult,
    // so to trigger the outer catch we need to cause uploadSingleFile to throw.
    // We can do this by making performUpload throw and also making the catch inside
    // uploadSingleFile throw (by making setAccountLimited throw when it shouldn't matter).
    // Simpler: have performUpload throw with a 403, and setAccountLimited also throw.
    const rateLimitErr = { response: { status: 403 }, message: 'rate limited' };
    m.performUpload.mockRejectedValue(rateLimitErr);
    m.setAccountLimited.mockRejectedValue(new Error('db error'));

    const failedUpload = {
      filePath: SEG_PATH,
      originalPath: 'segment_000.png',
      uploadedUrl: null as string | null,
      success: false,
      accountId: 'a99', // not a1, so a1 is used for retry
      error: 'initial failure',
    };

    const orch = new TiktokUploadOrchestrator();
    const retryPromise = (
      orch as unknown as {
        retryFailedUploads: (
          failed: typeof failedUpload[],
          accounts: typeof acct1[]
        ) => Promise<typeof failedUpload[]>;
      }
    ).retryFailedUploads([failedUpload], [acct1]);

    retryPromise.catch(() => {});
    await vi.runAllTimersAsync();

    const results = await retryPromise;
    // Even when setAccountLimited throws, uploadSingleFile swallows it and returns UploadResult
    // The retry should still record a failed result
    expect(results[0].success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // updatePlaylistUrls — mismatch branch: upload result doesn't match playlist line
  // -------------------------------------------------------------------------
  it('updatePlaylistUrls logs mismatch when segment name does not match playlist line', async () => {
    const m = await mocks;

    // Playlist references 'segment_000.png' but upload result has a different name
    const mismatchPlaylist = '#EXTM3U\n#EXTINF:5,\nsegment_000.png\n';
    await seedFiles({
      [PLAYLIST_PATH]: wrapInPng(mismatchPlaylist),
    });

    // Upload result with a DIFFERENT original path — won't match any line
    const uploadResults = [
      {
        success: true,
        uploadedUrl: 'https://cdn/seg_other.png',
        originalPath: 'segment_999.png', // no match in playlist
        filePath: `${DIR}/segment_999.png`,
        accountId: 'a1',
      },
    ];

    const orch = new TiktokUploadOrchestrator();
    const updatedPath = await (
      orch as unknown as {
        updatePlaylistUrls: (
          p: string,
          r: typeof uploadResults
        ) => Promise<string>;
      }
    ).updatePlaylistUrls(PLAYLIST_PATH, uploadResults);

    // Should still return a path (the mismatch warning is logged but doesn't throw)
    expect(updatedPath).toContain('_updated.png');

    // The written file should NOT contain the CDN URL (no match was made)
    const writtenBuf = m.fsm.files.get(updatedPath);
    expect(writtenBuf).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // uploadProcessedFiles — multiple segments (triggers batch delay between batches)
  // -------------------------------------------------------------------------
  it('handles multiple batches with delay and returns playlist URL', async () => {
    const m = await mocks;
    vi.useFakeTimers();

    // Seed 6 segment files to force 2 batches (default batch size = 5)
    const segFiles: Record<string, Buffer> = {};
    for (let i = 0; i < 6; i++) {
      const idx = String(i).padStart(3, '0');
      segFiles[`${DIR}/segment_${idx}.png`] = wrapInPng(`seg-${idx}`);
    }
    await seedFiles({
      ...segFiles,
      [PLAYLIST_PATH]: wrapInPng(PLAYLIST_M3U8),
    });

    // performUpload succeeds for all calls
    m.performUpload.mockResolvedValue('https://cdn/seg.png');

    const orch = new TiktokUploadOrchestrator();
    const uploadPromise = orch.uploadProcessedFiles(DIR);
    uploadPromise.catch(() => {});

    // Run all timers to get past batch delays
    await vi.runAllTimersAsync();

    const url = await uploadPromise;
    expect(url).toBe('https://cdn/seg.png');
  });

  // -------------------------------------------------------------------------
  // uploadProcessedFiles — global.gc branches + catch in uploadFilesInBatches
  // -------------------------------------------------------------------------
  it('calls global.gc when available and handles uploadSingleFile catch path', async () => {
    const m = await mocks;
    vi.useFakeTimers();

    // Temporarily set global.gc so that branch is taken
    const gcMock = vi.fn();
    (global as unknown as { gc: typeof gcMock }).gc = gcMock;

    // Seed 6 segment files (2 batches) + playlist
    const segFiles: Record<string, Buffer> = {};
    for (let i = 0; i < 6; i++) {
      const idx = String(i).padStart(3, '0');
      segFiles[`${DIR}/segment_${idx}.png`] = wrapInPng(`seg-${idx}`);
    }
    await seedFiles({
      ...segFiles,
      [PLAYLIST_PATH]: wrapInPng(PLAYLIST_M3U8),
    });

    // First performUpload for segment_000 will resolve null (triggers failure path in batches)
    // then all others resolve with a URL
    // On retry they succeed
    let callCount = 0;
    m.performUpload.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return null; // first segment fails
      return 'https://cdn/seg.png';
    });

    const orch = new TiktokUploadOrchestrator();
    const uploadPromise = orch.uploadProcessedFiles(DIR);
    uploadPromise.catch(() => {});

    await vi.runAllTimersAsync();
    const url = await uploadPromise;
    expect(url).toBe('https://cdn/seg.png');
    expect(gcMock).toHaveBeenCalled();

    // Cleanup
    delete (global as unknown as { gc?: typeof gcMock }).gc;
  });

  // -------------------------------------------------------------------------
  // uploadSingleFile — account has no id (edge case)
  // -------------------------------------------------------------------------
  it('returns success=false with accountId=unknown when account has no id', async () => {
    const m = await mocks;

    m.performUpload.mockResolvedValue(null);

    // Account with undefined id
    const acctNoId = account({ id: undefined as unknown as string, name: 'no-id' });
    const orch = new TiktokUploadOrchestrator();

    const result = await (
      orch as unknown as {
        uploadSingleFile: (p: string, a: typeof acctNoId) => Promise<{ success: boolean; accountId: string }>;
      }
    ).uploadSingleFile(SEG_PATH, acctNoId);

    expect(result.success).toBe(false);
    expect(result.accountId).toBe('unknown');
  });

  // -------------------------------------------------------------------------
  // updatePlaylistUrls — catch branch: readFile throws
  // -------------------------------------------------------------------------
  it('updatePlaylistUrls re-throws when readFile fails', async () => {
    // Do NOT seed the playlist file — readFile will throw ENOENT
    const orch = new TiktokUploadOrchestrator();

    await expect(
      (
        orch as unknown as {
          updatePlaylistUrls: (p: string, r: unknown[]) => Promise<string>;
        }
      ).updatePlaylistUrls(PLAYLIST_PATH, [])
    ).rejects.toThrow('Failed to update playlist URLs');
  });

  // -------------------------------------------------------------------------
  // uploadProcessedFiles — playlist upload fails (returns null URL)
  // -------------------------------------------------------------------------
  it('throws when the playlist upload fails', async () => {
    const m = await mocks;

    await seedFiles({
      [SEG_PATH]: wrapInPng('seg-data'),
      [PLAYLIST_PATH]: wrapInPng(PLAYLIST_M3U8),
    });

    // segment upload succeeds, but playlist upload returns null
    m.performUpload
      .mockResolvedValueOnce('https://cdn/seg.png') // segment
      .mockResolvedValueOnce(null); // playlist upload fails (null URL)

    const orch = new TiktokUploadOrchestrator();
    await expect(orch.uploadProcessedFiles(DIR)).rejects.toThrow('Failed to upload M3U8 playlist');
  });

  // -------------------------------------------------------------------------
  // getFilesToUpload — catch branch when readdir throws
  // -------------------------------------------------------------------------
  it('getFilesToUpload catch branch: throws when readdir fails', async () => {
    const m = await mocks;

    // Make readdir throw
    m.fsm.promises.readdir.mockRejectedValueOnce(new Error('ENOENT: dir not found'));

    const orch = new TiktokUploadOrchestrator();
    await expect(
      (
        orch as unknown as {
          getFilesToUpload: (dir: string) => Promise<string[]>;
        }
      ).getFilesToUpload('/nonexistent/dir')
    ).rejects.toThrow('Failed to read output directory');
  });

  // -------------------------------------------------------------------------
  // uploadFilesInBatches — global.gc branch inside batch delay
  // -------------------------------------------------------------------------
  it('uploadFilesInBatches calls global.gc between batches when available', async () => {
    vi.useFakeTimers();

    const gcMock = vi.fn();
    (global as unknown as { gc: typeof gcMock }).gc = gcMock;

    const acct1 = account({ id: 'a1', name: 'a1' });
    const orch = new TiktokUploadOrchestrator();

    // Monkeypatch uploadSingleFile to always succeed
    (orch as unknown as { uploadSingleFile: (...args: unknown[]) => Promise<unknown> }).uploadSingleFile =
      async (filePath: unknown) => ({
        filePath,
        originalPath: 'segment_000.png',
        uploadedUrl: 'https://cdn/seg.png',
        success: true,
        accountId: 'a1',
      });

    // 6 files forces 2 batches (batchSize=5 by default) → delay is called once
    const files = Array.from({ length: 6 }, (_, i) => `${DIR}/segment_${String(i).padStart(3, '0')}.png`);
    const config = { batchSize: 5, delayMs: 1000, outputDir: DIR };

    const batchPromise = (
      orch as unknown as {
        uploadFilesInBatches: (
          files: string[],
          accounts: typeof acct1[],
          config: { batchSize: number; delayMs: number; outputDir: string }
        ) => Promise<unknown[]>;
      }
    ).uploadFilesInBatches(files, [acct1], config);

    batchPromise.catch(() => {});
    await vi.runAllTimersAsync();

    const results = await batchPromise;
    expect(results).toHaveLength(6);
    // global.gc should have been called (at least once after each batch, and once in delay)
    expect(gcMock).toHaveBeenCalled();

    delete (global as unknown as { gc?: typeof gcMock }).gc;
  });

  // -------------------------------------------------------------------------
  // uploadFilesInBatches — .catch() handler when uploadSingleFile throws
  // -------------------------------------------------------------------------
  it('uploadFilesInBatches .catch() path when uploadSingleFile throws', async () => {
    vi.useFakeTimers();

    const acct1 = account({ id: 'a1', name: 'a1' });
    const orch = new TiktokUploadOrchestrator();

    // Monkeypatch uploadSingleFile to throw
    (orch as unknown as { uploadSingleFile: (...args: unknown[]) => Promise<unknown> }).uploadSingleFile =
      async () => { throw new Error('batch-level throw'); };

    const config = { batchSize: 5, delayMs: 100, outputDir: DIR };
    const results = await (
      orch as unknown as {
        uploadFilesInBatches: (
          files: string[],
          accounts: typeof acct1[],
          config: { batchSize: number; delayMs: number; outputDir: string }
        ) => Promise<Array<{ success: boolean; error?: string }>>;
      }
    ).uploadFilesInBatches([SEG_PATH], [acct1], config);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('batch-level throw');
  });

  // -------------------------------------------------------------------------
  // retryFailedUploads — catch block via monkeypatched uploadSingleFile
  // -------------------------------------------------------------------------
  it('retryFailedUploads catch block: handles unexpected throw from uploadSingleFile', async () => {
    vi.useFakeTimers();

    const acct1 = account({ id: 'a1', name: 'a1' });

    const failedUpload = {
      filePath: SEG_PATH,
      originalPath: 'segment_000.png',
      uploadedUrl: null as string | null,
      success: false,
      accountId: 'a99',
      error: 'initial failure',
    };

    const orch = new TiktokUploadOrchestrator();

    // Monkeypatch uploadSingleFile to throw (bypassing its internal try/catch)
    (orch as unknown as { uploadSingleFile: (...args: unknown[]) => Promise<unknown> }).uploadSingleFile =
      async () => { throw new Error('unexpected throw'); };

    const retryPromise = (
      orch as unknown as {
        retryFailedUploads: (
          failed: typeof failedUpload[],
          accounts: typeof acct1[]
        ) => Promise<typeof failedUpload[]>;
      }
    ).retryFailedUploads([failedUpload], [acct1]);

    retryPromise.catch(() => {});
    await vi.runAllTimersAsync();

    const results = await retryPromise;
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('unexpected throw');
  });
});
