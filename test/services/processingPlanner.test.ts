import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KEYFRAME_CSV } from '../helpers/fixtures';

// ---------------------------------------------------------------------------
// vi.hoisted: build mock controls BEFORE vi.mock factories are hoisted.
// We use a mutable holder `h` so that reassigning `h.cpStdout` in beforeEach
// is visible to the child_process mock factory (which closes over `h`).
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  // --- fluent-ffmpeg mock ---
  let probeData: unknown = { streams: [], format: {} };
  let probeErr: unknown = null;

  const ffmpeg: any = vi.fn();
  ffmpeg.ffprobe = vi.fn((_path: string, cb: (e: unknown, d: unknown) => void) => {
    cb(probeErr, probeData);
  });

  const ffControl = {
    ffmpeg,
    setProbe: (data: unknown, err: unknown = null) => {
      probeData = data;
      probeErr = err;
    },
  };

  // --- child_process mock ---
  // `cpStdout` and `cpErr` are stored on `h` so beforeEach can reassign them.
  const cpHolder = {
    stdout: '',
    err: null as unknown,
  };

  const execFile = vi.fn(
    (_cmd: string, _args: string[], cb: (e: unknown, r: { stdout: string; stderr: string }) => void) => {
      cb(cpHolder.err, { stdout: cpHolder.stdout, stderr: '' });
    },
  );

  return {
    ff: ffControl,
    execFile,
    cp: cpHolder,
  };
});

vi.mock('fluent-ffmpeg', () => ({ default: h.ff.ffmpeg }));
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => h.execFile(...(args as Parameters<typeof h.execFile>)),
}));

import { ProcessingPlanner } from '@/services/processingPlanner';

describe('ProcessingPlanner', () => {
  beforeEach(() => {
    // Reset child_process mock to the default KEYFRAME_CSV fixture.
    h.cp.stdout = KEYFRAME_CSV;
    h.cp.err = null;
    // Reset execFile call history so counts don't bleed between tests.
    h.execFile.mockClear();
  });

  // A keyframe CSV with dense 1s spacing (the besties-video scenario): the gap
  // alone is tiny, but each remux segment still runs ~HLS_SEGMENT_DURATION long.
  const DENSE_KEYFRAME_CSV =
    '0.000000,K_\n1.000000,K_\n2.000000,K_\n3.000000,K_\n4.000000,K_\n5.000000,K_\n6.000000,K_\n';

  it('routes to remux when predicted segment is under budget (h264 + aac)', async () => {
    // 1 Mbps × (5s hls_time + 6s max gap) = 11s ≈ 1.375 MB ≤ 4.0 MB budget → remux
    h.ff.setProbe({
      streams: [
        { codec_type: 'video', codec_name: 'h264', bit_rate: '1000000', width: 1920 },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
      format: {},
    });
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('remux');
    // Locks the formula: bitrate/8 × (HLS_SEGMENT_DURATION + maxGap), not × maxGap
    // alone. 1e6/8 × 11s = 1,375,000 B ÷ 1024² ≈ 1.31 MiB.
    expect(plan.predictedMaxSegmentMB).toBeCloseTo(1.31, 1);
  });

  it('routes to transcode when predicted segment exceeds budget', async () => {
    // 50 Mbps × 11s ≈ 65.6 MB > 4.0 MB budget → transcode
    h.ff.setProbe({
      streams: [{ codec_type: 'video', codec_name: 'h264', bit_rate: '50000000', width: 1920 }],
      format: {},
    });
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('transcode');
  });

  it('routes a dense-keyframe high-bitrate source to transcode (hls_time dominates segment size)', async () => {
    // Regression for the 60s-probe misprediction: gap is only 1s, so the old
    // formula (bitrate × gap) predicted ~1.25 MB and WRONGLY chose remux, then
    // produced oversize ~5s segments. The corrected formula uses hls_time + gap.
    // 10e6/8 × (5 + 1)s = 7,500,000 B ÷ 1024² ≈ 7.15 MiB > 4.0 MB budget → transcode.
    h.cp.stdout = DENSE_KEYFRAME_CSV;
    h.ff.setProbe({
      streams: [{ codec_type: 'video', codec_name: 'h264', bit_rate: '10000000', width: 1920 }],
      format: {},
    });
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('transcode');
    expect(plan.predictedMaxSegmentMB).toBeCloseTo(7.15, 1);
  });

  it('routes to transcode when the video codec is not h264 (e.g. HEVC), even if it would fit', async () => {
    // hls.js/MediaSource silently fails on HEVC in target browsers → never remux it.
    h.ff.setProbe({
      streams: [{ codec_type: 'video', codec_name: 'hevc', bit_rate: '1000000', width: 1920 }],
      format: {},
    });
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('transcode');
    expect(plan.reason).toMatch(/codec/i);
  });

  it('routes to transcode when the audio codec is not aac (e.g. opus), even if it would fit', async () => {
    h.ff.setProbe({
      streams: [
        { codec_type: 'video', codec_name: 'h264', bit_rate: '1000000', width: 1920 },
        { codec_type: 'audio', codec_name: 'opus' },
      ],
      format: {},
    });
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('transcode');
    expect(plan.reason).toMatch(/codec/i);
  });

  it('allows remux for a video-only h264 source (no audio stream)', async () => {
    h.ff.setProbe({
      streams: [{ codec_type: 'video', codec_name: 'h264', bit_rate: '1000000', width: 1920 }],
      format: {},
    });
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('remux');
  });

  it('defaults to transcode when probing throws', async () => {
    h.ff.setProbe(null, new Error('unreachable'));
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('transcode');
    expect(plan.reason).toContain('probe failed');
  });

  it('falls back to format bitrate, then resolution estimate', async () => {
    // No stream bit_rate, format bit_rate = '0' → resolution estimate.
    // width=1280 → 20 Mbps estimate × 11s ≈ 26.2 MB > 4.0 MB → transcode
    h.ff.setProbe({
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280 }],
      format: { bit_rate: '0' },
    });
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('transcode');
  });

  it('falls back to 8 Mbps resolution estimate for width < 1280', async () => {
    // No stream bit_rate, no format bit_rate, width=640 → 8 Mbps estimate.
    // 8 Mbps × 11s ≈ 10.5 MB > 4.0 MB budget → transcode (exercises the <1280 tier).
    h.ff.setProbe({
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 640 }],
      format: { bit_rate: '0' },
    });
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('transcode');
  });

  it('reports an infinite keyframe gap (→ transcode) when fewer than 2 keyframes sampled', async () => {
    // Only one keyframe → maxGap = Infinity → transcode regardless of bitrate
    h.cp.stdout = '0.000000,K_\n';
    h.ff.setProbe({
      streams: [{ codec_type: 'video', codec_name: 'h264', bit_rate: '1000000', width: 1920 }],
      format: {},
    });
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('transcode');
  });
});
