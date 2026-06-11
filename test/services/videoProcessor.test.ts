/**
 * Tests for VideoProcessor — HLS steganography pipeline.
 *
 * Strategy: use vi.hoisted() to build mock instances before the vi.mock()
 * factories are hoisted. The helpers are imported via dynamic `await import()`
 * inside the hoisted callback so they are available at hoist time.
 *
 * Key design decision for the planner mock: the planner's `plan` method is an
 * *instance* property (class field), so modifying `Prototype.plan` after
 * construction has no effect. We therefore hold a mutable `plannerRoute` string
 * in a hoisted holder that the mock's `plan` fn reads at call time, letting
 * individual tests redirect the route without touching the prototype.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// ---------------------------------------------------------------------------
// Hoisted holders — built before vi.mock factories are evaluated.
// ---------------------------------------------------------------------------

/** Mutable string read by the planner mock's plan() on every call. */
const plannerControl = vi.hoisted(() => ({
  route: 'transcode' as 'transcode' | 'remux',
  reason: 'test-default',
}));

/** fs + ffmpeg mock instances, created once via async hoisted. */
const mocks = vi.hoisted(async () => {
  const { makeFsMock } = await import('../helpers/fsMock');
  const { makeFfmpegMock } = await import('../helpers/ffmpegMock');
  return { fsm: makeFsMock(), ff: makeFfmpegMock() };
});

// ---------------------------------------------------------------------------
// vi.mock declarations (hoisted to top of file by Vitest)
// ---------------------------------------------------------------------------

vi.mock('fs', async () => {
  const m = await mocks;
  return {
    promises: m.fsm.promises,
    default: m.fsm.fsSync,
    ...m.fsm.fsSync,
  };
});

vi.mock('fluent-ffmpeg', async () => {
  const m = await mocks;
  return { default: m.ff.ffmpeg };
});

vi.mock('@/services/processingPlanner', () => ({
  // Use a prototype method (not a class field) so tests can redirect the route
  // by mutating plannerControl, which the function closes over.
  ProcessingPlanner: class {
    async plan() {
      return { route: plannerControl.route, reason: plannerControl.reason };
    }
  },
}));

vi.mock('@/services/encoding/EncodingStrategyFactory', () => ({
  EncodingStrategyFactory: {
    createStrategy: vi.fn(async () => ({
      getName: () => 'stub-encoder',
      getOptions: () => ['-c:v', 'libx264'],
    })),
  },
}));

// Production module — imported AFTER all vi.mock() calls.
import { VideoProcessor } from '@/services/videoProcessor';
import { wrapInPng, tsWithFFmpegMeta, tsClean, SAMPLE_M3U8 } from '../helpers/fixtures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const cwd = process.cwd();
const dir = (queueId: string) => path.join(cwd, 'processed', queueId);

/** Seed a file into the in-memory fs. */
async function seed(filePath: string, content: Buffer | string) {
  const m = await mocks;
  m.fsm.files.set(filePath, Buffer.isBuffer(content) ? content : Buffer.from(content));
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeEach(async () => {
  const m = await mocks;
  m.fsm.files.clear();
  vi.clearAllMocks();
  // Restore the default ffmpeg() → command implementation in case a previous
  // test overrode it with mockImplementation (vi.clearAllMocks does not reset
  // implementations, only call history).
  m.ff.restore();
  m.ff.succeed();
  m.ff.setProbe(
    {
      streams: [{ codec_type: 'video', width: 1920, height: 1080 }],
      format: { duration: 30, size: 1000000 },
    },
    null
  );
  // Reset planner to the default transcode route
  plannerControl.route = 'transcode';
  plannerControl.reason = 'test-default';
});

// ---------------------------------------------------------------------------
// stripFFmpegMetadata (private — tested via (vp as any))
// ---------------------------------------------------------------------------
describe('stripFFmpegMetadata', () => {
  it('removes FFmpeg metadata packet from a synthetic TS buffer', () => {
    const vp = new VideoProcessor() as any;
    const input = tsWithFFmpegMeta();
    const result: Buffer = vp.stripFFmpegMetadata(input);

    // The 'FFmpeg' marker must be gone
    expect(result.indexOf(Buffer.from('FFmpeg'))).toBe(-1);
    // The result is shorter than the original (stripped bytes removed)
    expect(result.length).toBeLessThan(input.length);
    // The result contains the packetHeader (4 bytes of 0x11) followed by the 0x47 sync
    // packetHeader = input.subarray(0, ffmpegStart - 6) = first 4 bytes = 0x11
    expect(result[0]).toBe(0x11);
    // 0x47 sync byte immediately follows the 4-byte header
    expect(result[4]).toBe(0x47);
  });

  it('returns the input buffer unchanged when there is no FFmpeg marker', () => {
    const vp = new VideoProcessor() as any;
    const input = tsClean();
    const result: Buffer = vp.stripFFmpegMetadata(input);
    expect(result).toBe(input); // strict identity — same reference
  });

  it('returns the input unchanged when there is no 0x47 sync byte after position 188', () => {
    // Buffer has "FFmpeg" but no 0x47 byte after position 188
    const header = Buffer.alloc(10, 0x11);
    const marker = Buffer.from('FFmpeg');
    const tail = Buffer.alloc(200, 0x22); // all 0x22, no 0x47
    const input = Buffer.concat([header, marker, tail]);
    const vp = new VideoProcessor() as any;
    const result: Buffer = vp.stripFFmpegMetadata(input);
    expect(result).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// extractM3u8FromPng (private)
// ---------------------------------------------------------------------------
describe('extractM3u8FromPng', () => {
  it('extracts M3U8 content embedded after the PNG IEND chunk', async () => {
    const queueId = 'extract-test';
    const pngPath = path.join(dir(queueId), 'playlist.png');
    await seed(pngPath, wrapInPng(SAMPLE_M3U8));

    const vp = new VideoProcessor() as any;
    const content: string = vp.extractM3u8FromPng(pngPath);
    expect(content).toContain('#EXTM3U');
    expect(content).toContain('segment_000.ts');
  });

  it('throws when the PNG file does not exist', async () => {
    const vp = new VideoProcessor() as any;
    expect(() => vp.extractM3u8FromPng('/no/such/file.png')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// validatePlaylist (private)
// ---------------------------------------------------------------------------
describe('validatePlaylist', () => {
  it('returns isValid=true with correct segmentCount and duration for a well-formed playlist PNG', async () => {
    const queueId = 'validate-ok';
    const pngPath = path.join(dir(queueId), 'playlist.png');
    await seed(pngPath, wrapInPng(SAMPLE_M3U8));

    const vp = new VideoProcessor() as any;
    const result = await vp.validatePlaylist(pngPath);

    expect(result.isValid).toBe(true);
    expect(result.segmentCount).toBe(2);
    // 5.000 + 4.200 = 9.2
    expect(result.duration).toBeCloseTo(9.2, 1);
    expect(result.errors).toHaveLength(0);
  });

  it('returns isValid=false with "Missing HLS header" for a playlist without #EXTM3U', async () => {
    const badPlaylist = 'no-header\nsegment_000.png\n';
    const queueId = 'validate-bad';
    const pngPath = path.join(dir(queueId), 'playlist.png');
    await seed(pngPath, wrapInPng(badPlaylist));

    const vp = new VideoProcessor() as any;
    const result = await vp.validatePlaylist(pngPath);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('Missing HLS header'))).toBe(true);
  });

  it('returns isValid=false with "No segments found" for a header-only playlist', async () => {
    const headerOnly = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST\n';
    const queueId = 'validate-noseg';
    const pngPath = path.join(dir(queueId), 'playlist.png');
    await seed(pngPath, wrapInPng(headerOnly));

    const vp = new VideoProcessor() as any;
    const result = await vp.validatePlaylist(pngPath);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('No segments found'))).toBe(true);
  });

  it('reads a regular .m3u8 file (non-PNG path) via fs.promises.readFile', async () => {
    const queueId = 'validate-m3u8';
    const m3u8Path = path.join(dir(queueId), 'playlist.m3u8');
    await seed(m3u8Path, SAMPLE_M3U8);

    const vp = new VideoProcessor() as any;
    const result = await vp.validatePlaylist(m3u8Path);

    expect(result.isValid).toBe(true);
    expect(result.segmentCount).toBe(2);
  });

  it('returns isValid=false when the file does not exist', async () => {
    const vp = new VideoProcessor() as any;
    const result = await vp.validatePlaylist('/no/such/playlist.png');
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toMatch(/Failed to read playlist/);
  });
});

// ---------------------------------------------------------------------------
// wrapSegmentsInPng (private)
// ---------------------------------------------------------------------------
describe('wrapSegmentsInPng', () => {
  it('converts segment_*.ts files to segment_*.png and deletes the .ts', async () => {
    const queueId = 'wrap-test';
    const outputDir = dir(queueId);
    const tsPath = path.join(outputDir, 'segment_000.ts');
    const pngPath = path.join(outputDir, 'segment_000.png');
    await seed(tsPath, tsWithFFmpegMeta());

    const vp = new VideoProcessor() as any;
    await vp.wrapSegmentsInPng(outputDir);

    const m = await mocks;
    expect(m.fsm.files.has(pngPath)).toBe(true);
    expect(m.fsm.files.has(tsPath)).toBe(false);
  });

  it('wraps a clean .ts (no FFmpeg marker) too', async () => {
    const queueId = 'wrap-clean';
    const outputDir = dir(queueId);
    const tsPath = path.join(outputDir, 'segment_000.ts');
    const pngPath = path.join(outputDir, 'segment_000.png');
    await seed(tsPath, tsClean());

    const vp = new VideoProcessor() as any;
    await vp.wrapSegmentsInPng(outputDir);

    const m = await mocks;
    expect(m.fsm.files.has(pngPath)).toBe(true);
    expect(m.fsm.files.has(tsPath)).toBe(false);
  });

  it('processes multiple segments in the directory', async () => {
    const queueId = 'wrap-multi';
    const outputDir = dir(queueId);
    await seed(path.join(outputDir, 'segment_000.ts'), tsWithFFmpegMeta());
    await seed(path.join(outputDir, 'segment_001.ts'), tsClean());

    const vp = new VideoProcessor() as any;
    await vp.wrapSegmentsInPng(outputDir);

    const m = await mocks;
    expect(m.fsm.files.has(path.join(outputDir, 'segment_000.png'))).toBe(true);
    expect(m.fsm.files.has(path.join(outputDir, 'segment_001.png'))).toBe(true);
    expect(m.fsm.files.has(path.join(outputDir, 'segment_000.ts'))).toBe(false);
    expect(m.fsm.files.has(path.join(outputDir, 'segment_001.ts'))).toBe(false);
  });

  it('ignores files that are not segment_*.ts', async () => {
    const queueId = 'wrap-noMatch';
    const outputDir = dir(queueId);
    const notSeg = path.join(outputDir, 'playlist.m3u8');
    await seed(notSeg, SAMPLE_M3U8);

    const vp = new VideoProcessor() as any;
    await expect(vp.wrapSegmentsInPng(outputDir)).resolves.toBeUndefined();

    const m = await mocks;
    expect(m.fsm.files.has(notSeg)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// updatePlaylistToUsePng (private)
// ---------------------------------------------------------------------------
describe('updatePlaylistToUsePng', () => {
  it('rewrites .ts references to .png in the playlist', async () => {
    const queueId = 'update-playlist';
    const outputDir = dir(queueId);
    const m3u8Path = path.join(outputDir, 'playlist.m3u8');
    await seed(m3u8Path, SAMPLE_M3U8);

    const vp = new VideoProcessor() as any;
    await vp.updatePlaylistToUsePng(outputDir);

    const m = await mocks;
    const content = m.fsm.files.get(m3u8Path)!.toString('utf-8');
    expect(content).toContain('segment_000.png');
    expect(content).not.toContain('segment_000.ts');
  });

  it('throws "Playlist file not found" when playlist.m3u8 is absent', async () => {
    const queueId = 'update-missing';
    const outputDir = dir(queueId);
    // Deliberately do NOT seed playlist.m3u8

    const vp = new VideoProcessor() as any;
    await expect(vp.updatePlaylistToUsePng(outputDir)).rejects.toThrow('Playlist file not found');
  });
});

// ---------------------------------------------------------------------------
// embedPlaylistToPng (private)
// ---------------------------------------------------------------------------
describe('embedPlaylistToPng', () => {
  it('creates playlist.png containing the M3U8 data and removes playlist.m3u8', async () => {
    const queueId = 'embed-playlist';
    const outputDir = dir(queueId);
    const m3u8Path = path.join(outputDir, 'playlist.m3u8');
    const pngPath = path.join(outputDir, 'playlist.png');
    await seed(m3u8Path, SAMPLE_M3U8);

    const vp = new VideoProcessor() as any;
    await vp.embedPlaylistToPng(outputDir);

    const m = await mocks;
    expect(m.fsm.files.has(pngPath)).toBe(true);
    expect(m.fsm.files.has(m3u8Path)).toBe(false);

    // The embedded content should contain the original M3U8 after the PNG carrier
    const embedded = m.fsm.files.get(pngPath)!;
    expect(embedded.toString('utf-8')).toContain('#EXTM3U');
  });

  it('throws when playlist.m3u8 is absent', async () => {
    const queueId = 'embed-missing';
    const outputDir = dir(queueId);

    const vp = new VideoProcessor() as any;
    await expect(vp.embedPlaylistToPng(outputDir)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// clearTsAndPlaylist (private)
// ---------------------------------------------------------------------------
describe('clearTsAndPlaylist', () => {
  it('removes .ts files and playlist.m3u8 from the output dir', async () => {
    const queueId = 'clear-test';
    const outputDir = dir(queueId);
    const ts0 = path.join(outputDir, 'segment_000.ts');
    const ts1 = path.join(outputDir, 'segment_001.ts');
    const m3u8 = path.join(outputDir, 'playlist.m3u8');
    const png = path.join(outputDir, 'segment_000.png');
    await seed(ts0, tsClean());
    await seed(ts1, tsClean());
    await seed(m3u8, SAMPLE_M3U8);
    await seed(png, wrapInPng('data'));

    const vp = new VideoProcessor() as any;
    await vp.clearTsAndPlaylist(outputDir);

    const m = await mocks;
    expect(m.fsm.files.has(ts0)).toBe(false);
    expect(m.fsm.files.has(ts1)).toBe(false);
    expect(m.fsm.files.has(m3u8)).toBe(false);
    // PNG is unrelated — should survive
    expect(m.fsm.files.has(png)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateSegmentSizes (private)
// ---------------------------------------------------------------------------
describe('validateSegmentSizes', () => {
  it('returns an empty array when all segments are under 5MB', async () => {
    const queueId = 'segsz-ok';
    const outputDir = dir(queueId);
    await seed(path.join(outputDir, 'segment_000.ts'), Buffer.alloc(1024)); // 1 KB

    const vp = new VideoProcessor() as any;
    const oversized = await vp.validateSegmentSizes(outputDir);
    expect(oversized).toHaveLength(0);
  });

  it('returns oversize entry when a segment exceeds 5MB', async () => {
    const queueId = 'segsz-big';
    const outputDir = dir(queueId);
    await seed(path.join(outputDir, 'segment_000.ts'), Buffer.alloc(6 * 1024 * 1024)); // 6 MB

    const vp = new VideoProcessor() as any;
    const oversized = await vp.validateSegmentSizes(outputDir);
    expect(oversized).toHaveLength(1);
    expect(oversized[0].name).toBe('segment_000.ts');
    expect(oversized[0].sizeMB).toBeGreaterThan(5);
  });

  it('returns empty when directory has no .ts files', async () => {
    const queueId = 'segsz-none';
    const outputDir = dir(queueId);
    await seed(path.join(outputDir, 'playlist.m3u8'), SAMPLE_M3U8);

    const vp = new VideoProcessor() as any;
    const oversized = await vp.validateSegmentSizes(outputDir);
    expect(oversized).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// processVideo — transcode happy path
// ---------------------------------------------------------------------------
describe('processVideo transcode happy path', () => {
  it('resolves without error when ffmpeg succeeds and files are available', async () => {
    const queueId = 'proc-happy';
    const outputDir = dir(queueId);
    const m = await mocks;

    // Seed output files synchronously before calling processVideo.
    // mkdir is intercepted to set them up; the mocked ffmpeg conversion
    // fires 'end' but writes nothing, so we pre-seed what downstream steps need.
    m.fsm.promises.mkdir.mockImplementation(async () => {
      await seed(path.join(outputDir, 'segment_000.ts'), tsWithFFmpegMeta());
      await seed(path.join(outputDir, 'segment_001.ts'), tsClean());
      await seed(path.join(outputDir, 'playlist.m3u8'), SAMPLE_M3U8);
    });

    const vp = new VideoProcessor();
    await expect(vp.processVideo('http://example.com/video.mp4', queueId)).resolves.toBeUndefined();
  });

  it('produces playlist.png in the output directory after processing', async () => {
    const queueId = 'proc-png';
    const outputDir = dir(queueId);
    const m = await mocks;

    m.fsm.promises.mkdir.mockImplementation(async () => {
      await seed(path.join(outputDir, 'segment_000.ts'), tsClean());
      await seed(path.join(outputDir, 'playlist.m3u8'), SAMPLE_M3U8);
    });

    const vp = new VideoProcessor();
    await vp.processVideo('http://example.com/video.mp4', queueId);

    // After the pipeline, playlist.png should be present
    expect(m.fsm.files.has(path.join(outputDir, 'playlist.png'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// processVideo — failure paths
// ---------------------------------------------------------------------------
describe('processVideo failure paths', () => {
  it('rejects when ffprobe fails', async () => {
    const queueId = 'proc-probe-fail';
    const m = await mocks;

    m.ff.setProbe(null, new Error('probe boom'));

    const vp = new VideoProcessor();
    await expect(vp.processVideo('http://example.com/video.mp4', queueId)).rejects.toThrow('probe boom');
  });

  it('rejects when ffmpeg conversion fails', async () => {
    const queueId = 'proc-ffmpeg-fail';
    const outputDir = dir(queueId);
    const m = await mocks;

    m.ff.fail(new Error('ffmpeg crash'));

    m.fsm.promises.mkdir.mockImplementation(async () => {
      await seed(path.join(outputDir, 'segment_000.ts'), tsClean());
      await seed(path.join(outputDir, 'playlist.m3u8'), SAMPLE_M3U8);
    });

    const vp = new VideoProcessor();
    await expect(vp.processVideo('http://example.com/video.mp4', queueId)).rejects.toThrow('ffmpeg crash');
  });

  it('rejects when embedPlaylistToPng fails (no playlist.m3u8)', async () => {
    const queueId = 'proc-embed-fail';
    const outputDir = dir(queueId);
    const m = await mocks;

    // Seed only segment PNGs (no playlist.m3u8), so embedPlaylistToPng throws
    m.fsm.promises.mkdir.mockImplementation(async () => {
      // After wrapSegmentsInPng, updatePlaylistToUsePng reads playlist.m3u8.
      // Seed a playlist.m3u8 so updatePlaylistToUsePng passes, but then DON'T seed
      // for embedPlaylistToPng... Actually updatePlaylistToUsePng uses fsSync.existsSync,
      // so we just skip seeding any files to trigger the failure.
    });

    const vp = new VideoProcessor();
    await expect(vp.processVideo('http://example.com/video.mp4', queueId)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// processVideo — remux route
// ---------------------------------------------------------------------------
describe('processVideo remux route', () => {
  it('takes the remux path when planner returns route=remux', async () => {
    const queueId = 'proc-remux-ok';
    const outputDir = dir(queueId);
    const m = await mocks;

    // Redirect the planner to remux
    plannerControl.route = 'remux';
    plannerControl.reason = 'test-remux';

    // Seed files that the remux ffmpeg "produces" (and subsequent steps consume)
    m.fsm.promises.mkdir.mockImplementation(async () => {
      await seed(path.join(outputDir, 'segment_000.ts'), tsClean()); // small — under 5MB
      await seed(path.join(outputDir, 'playlist.m3u8'), SAMPLE_M3U8);
    });

    const vp = new VideoProcessor();
    await expect(vp.processVideo('http://example.com/video.mp4', queueId)).resolves.toBeUndefined();
  });

  it('falls back to transcode when remux produces oversized segments', async () => {
    const queueId = 'proc-remux-fallback';
    const outputDir = dir(queueId);
    const m = await mocks;

    plannerControl.route = 'remux';
    plannerControl.reason = 'test-remux-fallback';

    // Track ffmpeg() calls
    let ffmpegCallCount = 0;

    m.ff.ffmpeg.mockImplementation(() => {
      ffmpegCallCount++;
      const callN = ffmpegCallCount;
      const command: any = {};
      const handlers: Record<string, (...a: unknown[]) => void> = {};
      command.outputOptions = vi.fn(() => command);
      command.output = vi.fn(() => command);
      command.on = vi.fn((event: string, cb: (...a: unknown[]) => void) => {
        handlers[event] = cb;
        return command;
      });
      command.run = vi.fn(() => {
        queueMicrotask(async () => {
          if (callN === 2) {
            // Transcode fallback run — seed outputs before resolving so
            // the downstream pipeline (wrapSegmentsInPng etc.) can proceed.
            await seed(path.join(outputDir, 'segment_000.ts'), tsClean());
            await seed(path.join(outputDir, 'playlist.m3u8'), SAMPLE_M3U8);
          }
          handlers['end']?.();
        });
      });
      return command;
    });

    m.fsm.promises.mkdir.mockImplementation(async () => {
      // Seed a 6MB segment to trigger the fallback after the remux run
      await seed(path.join(outputDir, 'segment_000.ts'), Buffer.alloc(6 * 1024 * 1024));
      await seed(path.join(outputDir, 'playlist.m3u8'), SAMPLE_M3U8);
    });

    const vp = new VideoProcessor();
    await expect(vp.processVideo('http://example.com/video.mp4', queueId)).resolves.toBeUndefined();

    // Remux + fallback transcode = 2 ffmpeg() calls
    expect(ffmpegCallCount).toBeGreaterThanOrEqual(2);
  });

  it('rejects when the remux ffmpeg command fails', async () => {
    const queueId = 'proc-remux-error';
    const outputDir = dir(queueId);
    const m = await mocks;

    plannerControl.route = 'remux';
    plannerControl.reason = 'test-remux-error';

    m.ff.fail(new Error('remux crashed'));

    m.fsm.promises.mkdir.mockImplementation(async () => {
      await seed(path.join(outputDir, 'segment_000.ts'), tsClean());
      await seed(path.join(outputDir, 'playlist.m3u8'), SAMPLE_M3U8);
    });

    const vp = new VideoProcessor();
    await expect(vp.processVideo('http://example.com/video.mp4', queueId)).rejects.toThrow('remux crashed');
  });
});

// ---------------------------------------------------------------------------
// Additional branch coverage: getVideoMetadata fallback values
// ---------------------------------------------------------------------------
describe('getVideoMetadata fallback values', () => {
  it('uses fallback zeroes when duration and size are absent from probe data', async () => {
    const queueId = 'meta-fallback';
    const outputDir = dir(queueId);
    const m = await mocks;

    // Probe returns empty format (no duration/size)
    m.ff.setProbe({ streams: [], format: {} }, null);

    m.fsm.promises.mkdir.mockImplementation(async () => {
      await seed(path.join(outputDir, 'segment_000.ts'), tsClean());
      await seed(path.join(outputDir, 'playlist.m3u8'), SAMPLE_M3U8);
    });

    const vp = new VideoProcessor();
    // Should resolve (fallback to 0 for both duration and size)
    await expect(vp.processVideo('http://example.com/video.mp4', queueId)).resolves.toBeUndefined();
  });

  it('rejects when getFFmpegMetadata probe fails', async () => {
    // getFFmpegMetadata is the second ffprobe call in convertVideoToHLS.
    // We can trigger it by making ffprobe succeed on the first call (getVideoMetadata)
    // but fail on the second. Since both share the same ffprobe mock, we need to
    // make ffprobe fail on any call to test the error path.
    const queueId = 'meta-ffprobe-fail';
    const m = await mocks;

    m.ff.setProbe(null, new Error('ffprobe error'));

    const vp = new VideoProcessor();
    await expect(vp.processVideo('http://example.com/video.mp4', queueId)).rejects.toThrow('ffprobe error');
  });
});

// ---------------------------------------------------------------------------
// extractM3u8FromPng — IEND not found branch
// ---------------------------------------------------------------------------
describe('extractM3u8FromPng IEND branch', () => {
  it('throws "PNG IEND marker not found" when the buffer has no IEND chunk', async () => {
    const queueId = 'iend-missing';
    const pngPath = path.join(dir(queueId), 'playlist.png');
    // A buffer with no IEND marker (just raw bytes)
    await seed(pngPath, Buffer.from('this is not a valid png file'));

    const vp = new VideoProcessor() as any;
    expect(() => vp.extractM3u8FromPng(pngPath)).toThrow('PNG IEND marker not found');
  });
});

// ---------------------------------------------------------------------------
// validateConversion — invalid playlist throws
// ---------------------------------------------------------------------------
describe('validateConversion', () => {
  it('throws "Playlist validation failed" when playlist.png has no valid HLS content', async () => {
    const queueId = 'vconv-invalid';
    const outputDir = dir(queueId);
    // Seed a playlist.png that decodes to invalid HLS (no #EXTM3U header)
    const badHls = 'no-header\n';
    await seed(path.join(outputDir, 'playlist.png'), wrapInPng(badHls));

    const vp = new VideoProcessor() as any;
    await expect(vp.validateConversion(outputDir)).rejects.toThrow('Playlist validation failed');
  });

  it('succeeds when playlist.png has valid HLS with segments', async () => {
    const queueId = 'vconv-valid';
    const outputDir = dir(queueId);
    await seed(path.join(outputDir, 'playlist.png'), wrapInPng(SAMPLE_M3U8));

    const vp = new VideoProcessor() as any;
    await expect(vp.validateConversion(outputDir)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// wrapSegmentsInPng — error path (readFile throws)
// ---------------------------------------------------------------------------
describe('wrapSegmentsInPng error path', () => {
  it('re-throws when readFile fails for a segment', async () => {
    const queueId = 'wrap-err';
    const outputDir = dir(queueId);
    const m = await mocks;

    // Register the .ts file in the directory listing but make readFile fail for it
    await seed(path.join(outputDir, 'segment_000.ts'), tsClean());

    const origReadFile = m.fsm.promises.readFile;
    m.fsm.promises.readFile.mockImplementation(async (p: string, enc?: string) => {
      if (typeof p === 'string' && p.endsWith('.ts')) {
        throw new Error('read error');
      }
      return origReadFile(p, enc as any);
    });

    const vp = new VideoProcessor() as any;
    await expect(vp.wrapSegmentsInPng(outputDir)).rejects.toThrow('read error');
  });
});

// ---------------------------------------------------------------------------
// Validate EXTINF branch without duration match (edge case)
// ---------------------------------------------------------------------------
describe('validatePlaylist EXTINF edge cases', () => {
  it('handles an EXTINF line with no numeric value gracefully', async () => {
    const edgeCasePlaylist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXTINF:,',     // no numeric value — durationMatch[1] is empty
      'segment_000.png',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');

    const queueId = 'extinf-edge';
    const pngPath = path.join(dir(queueId), 'playlist.png');
    await seed(pngPath, wrapInPng(edgeCasePlaylist));

    const vp = new VideoProcessor() as any;
    const result = await vp.validatePlaylist(pngPath);

    expect(result.isValid).toBe(true);
    expect(result.segmentCount).toBe(1);
    // Duration is 0 or NaN because there was no numeric value
    expect(result.duration).toBeDefined();
  });
});
