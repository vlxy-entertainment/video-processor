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
  execFile: (...args: unknown[]) => h.execFile(...(args as [])),
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

  it('routes to remux when predicted segment is under budget', async () => {
    // 1 Mbps × 6s max gap ≈ 0.715 MB ≤ 4.0 MB budget → remux
    h.ff.setProbe({ streams: [{ codec_type: 'video', bit_rate: '1000000', width: 1920 }], format: {} });
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('remux');
    expect(plan.predictedMaxSegmentMB).toBeGreaterThan(0);
  });

  it('routes to transcode when predicted segment exceeds budget', async () => {
    // 50 Mbps × 6s ≈ 35.76 MB > 4.0 MB budget → transcode
    h.ff.setProbe({ streams: [{ codec_type: 'video', bit_rate: '50000000', width: 1920 }], format: {} });
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('transcode');
  });

  it('defaults to transcode when probing throws', async () => {
    h.ff.setProbe(null, new Error('unreachable'));
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('transcode');
    expect(plan.reason).toContain('probe failed');
  });

  it('falls back to format bitrate, then resolution estimate', async () => {
    // No stream bit_rate, format bit_rate = '0' → resolution estimate.
    // width=1280 → 20 Mbps estimate × 6s ≈ 14.3 MB > 4.0 MB → transcode
    h.ff.setProbe({ streams: [{ codec_type: 'video', width: 1280 }], format: { bit_rate: '0' } });
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('transcode');
  });

  it('reports an infinite keyframe gap (→ transcode) when fewer than 2 keyframes sampled', async () => {
    // Only one keyframe → maxGap = Infinity → transcode regardless of bitrate
    h.cp.stdout = '0.000000,K_\n';
    h.ff.setProbe({ streams: [{ codec_type: 'video', bit_rate: '1000000', width: 1920 }], format: {} });
    const plan = await new ProcessingPlanner().plan('http://src');
    expect(plan.route).toBe('transcode');
  });
});
