import { describe, it, expect, vi } from 'vitest';

// vi.hoisted runs BEFORE vi.mock factories, so `ff` is safe to reference there.
const ff = vi.hoisted(() => {
  // Inline equivalent of makeFfmpegMock so we don't import from a helper
  // (which would itself be hoisted and could create ordering problems).
  let mode: 'end' | 'error' = 'end';
  let error: Error = new Error('ffmpeg failed');

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
    queueMicrotask(() => {
      if (mode === 'end') handlers['end']?.();
      else handlers['error']?.(error, 'stdout', 'stderr');
    });
  });

  const ffmpegFn: any = vi.fn(() => command);
  ffmpegFn.ffprobe = vi.fn((_path: string, cb: (e: unknown, d: unknown) => void) => {
    cb(null, { streams: [], format: {} });
  });

  return {
    ffmpeg: ffmpegFn,
    succeed: () => { mode = 'end'; },
    fail: (err?: Error) => { mode = 'error'; if (err) error = err; },
  };
});

vi.mock('fluent-ffmpeg', () => ({ default: ff.ffmpeg }));

import { NvidiaEncodingStrategy } from '@/services/encoding/NvidiaEncodingStrategy';
import { IntelQsvEncodingStrategy } from '@/services/encoding/IntelQsvEncodingStrategy';
import { CpuEncodingStrategy } from '@/services/encoding/CpuEncodingStrategy';
import { AmdEncodingStrategy } from '@/services/encoding/AmdEncodingStrategy';
import { AppleVideoToolboxEncodingStrategy } from '@/services/encoding/AppleVideoToolboxEncodingStrategy';

const meta = (streams: unknown[]) => ({ streams, format: {} }) as any;

// ---------------------------------------------------------------------------
// NvidiaEncodingStrategy
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// IntelQsvEncodingStrategy
// ---------------------------------------------------------------------------
describe('IntelQsvEncodingStrategy', () => {
  it('names itself correctly', () => {
    expect(new IntelQsvEncodingStrategy().getName()).toBe('Intel Quick Sync Video');
  });

  it('uses h264_qsv codec', () => {
    const opts = new IntelQsvEncodingStrategy().getOptions(
      meta([{ codec_type: 'video', width: 1920, height: 1080 }])
    );
    expect(opts).toContain('h264_qsv');
  });

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

  it('isAvailable resolves true on ffmpeg end', async () => {
    ff.succeed();
    await expect(new IntelQsvEncodingStrategy().isAvailable()).resolves.toBe(true);
  });

  it('isAvailable resolves false on ffmpeg error', async () => {
    ff.fail();
    await expect(new IntelQsvEncodingStrategy().isAvailable()).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CpuEncodingStrategy
// ---------------------------------------------------------------------------
describe('CpuEncodingStrategy', () => {
  it('names itself correctly', () => {
    expect(new CpuEncodingStrategy().getName()).toBe('CPU (libx264)');
  });

  it('emits libx264 fixed options', () => {
    const s = new CpuEncodingStrategy('medium');
    expect(s.getName()).toBe('CPU (libx264)');
    expect(s.getOptions()).toContain('libx264');
  });

  it('isAvailable resolves true on ffmpeg end', async () => {
    ff.succeed();
    await expect(new CpuEncodingStrategy().isAvailable()).resolves.toBe(true);
  });

  it('isAvailable resolves false on ffmpeg error', async () => {
    ff.fail();
    await expect(new CpuEncodingStrategy().isAvailable()).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AmdEncodingStrategy
// ---------------------------------------------------------------------------
describe('AmdEncodingStrategy', () => {
  it('names itself correctly', () => {
    expect(new AmdEncodingStrategy().getName()).toBe('AMD AMF');
  });

  it('emits h264_amf codec', () => {
    const opts = new AmdEncodingStrategy().getOptions(meta([{ width: 1920, height: 1080 }]));
    expect(opts).toContain('h264_amf');
    expect(opts.length).toBeGreaterThan(0);
  });

  it('uses stream bitrate when present', () => {
    const opts = new AmdEncodingStrategy().getOptions(
      meta([{ codec_type: 'video', bit_rate: '8000000', width: 1920 }])
    );
    expect(opts.join(' ')).toContain('8000k');
  });

  it('estimates bitrate from resolution when missing', () => {
    const opts = new AmdEncodingStrategy().getOptions(meta([{ codec_type: 'video', width: 1280 }]));
    expect(opts.join(' ')).toContain('20000k');
  });

  it('isAvailable resolves true on ffmpeg end', async () => {
    ff.succeed();
    await expect(new AmdEncodingStrategy().isAvailable()).resolves.toBe(true);
  });

  it('isAvailable resolves false on ffmpeg error', async () => {
    ff.fail();
    await expect(new AmdEncodingStrategy().isAvailable()).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AppleVideoToolboxEncodingStrategy
// ---------------------------------------------------------------------------
describe('AppleVideoToolboxEncodingStrategy', () => {
  it('names itself correctly', () => {
    expect(new AppleVideoToolboxEncodingStrategy().getName()).toBe('Apple VideoToolbox');
  });

  it('emits h264_videotoolbox codec', () => {
    const opts = new AppleVideoToolboxEncodingStrategy().getOptions(meta([{ width: 1920, height: 1080 }]));
    expect(opts).toContain('h264_videotoolbox');
    expect(opts.length).toBeGreaterThan(0);
  });

  it('uses stream bitrate when present', () => {
    const opts = new AppleVideoToolboxEncodingStrategy().getOptions(
      meta([{ codec_type: 'video', bit_rate: '4000000', width: 1920 }])
    );
    expect(opts.join(' ')).toContain('4000k');
  });

  it('estimates bitrate from resolution when missing', () => {
    const opts = new AppleVideoToolboxEncodingStrategy().getOptions(meta([{ codec_type: 'video', width: 1280 }]));
    expect(opts.join(' ')).toContain('20000k');
  });

  it('isAvailable resolves true on ffmpeg end', async () => {
    ff.succeed();
    await expect(new AppleVideoToolboxEncodingStrategy().isAvailable()).resolves.toBe(true);
  });

  it('isAvailable resolves false on ffmpeg error', async () => {
    ff.fail();
    await expect(new AppleVideoToolboxEncodingStrategy().isAvailable()).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AMD + Apple: combined surface check (mirrors the original task spec)
// ---------------------------------------------------------------------------
describe('AMD + Apple strategies', () => {
  it('expose a name and option list', () => {
    expect(new AmdEncodingStrategy().getOptions(meta([{ width: 1920 }])).length).toBeGreaterThan(0);
    expect(new AppleVideoToolboxEncodingStrategy().getOptions(meta([{ width: 1920 }])).length).toBeGreaterThan(0);
  });
});
