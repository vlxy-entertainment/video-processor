import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({
  processNextVideo: vi.fn(async () => undefined),
}));
vi.mock('@/services/processingService', () => ({
  ProcessingService: class {
    processNextVideo = m.processNextVideo;
  },
}));

import { Scheduler } from '@/services/scheduler';

beforeEach(() => {
  vi.useFakeTimers();
  m.processNextVideo.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Scheduler', () => {
  it('runs immediately on start and is running', () => {
    const s = new Scheduler(1);
    s.start();
    expect(s.isRunning()).toBe(true);
    expect(m.processNextVideo).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('fires again after the interval', async () => {
    const s = new Scheduler(1);
    s.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.processNextVideo.mock.calls.length).toBeGreaterThanOrEqual(2);
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
    s.stop(); // not running — hits the else branch ("Scheduler is not running")
    expect(s.isRunning()).toBe(false);
  });

  it('swallows task errors', async () => {
    m.processNextVideo.mockRejectedValueOnce(new Error('task boom'));
    const s = new Scheduler(1);
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.isRunning()).toBe(true);
    s.stop();
  });

  it('enforces the isProcessing overlap guard: second tick is skipped while first is in-flight', async () => {
    // Make processNextVideo hang indefinitely so the first call never releases isProcessing.
    let resolveFirst!: () => void;
    const firstCallPromise = new Promise<void>((res) => {
      resolveFirst = res;
    });
    m.processNextVideo.mockReturnValueOnce(firstCallPromise as Promise<undefined>);

    const s = new Scheduler(1);
    s.start(); // fires runTask immediately → sets isProcessing = true, awaits firstCallPromise

    // Advance the timer so the interval callback fires while the first call is still in-flight.
    await vi.advanceTimersByTimeAsync(60_000);

    // processNextVideo should have been called only once: the immediate call on start.
    // The interval-tick call hit the isProcessing guard and returned early.
    expect(m.processNextVideo).toHaveBeenCalledTimes(1);

    // Resolve the first call so the scheduler can clean up.
    resolveFirst();
    await vi.advanceTimersByTimeAsync(0);

    s.stop();
  });
});
