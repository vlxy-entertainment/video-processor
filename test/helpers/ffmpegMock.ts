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
