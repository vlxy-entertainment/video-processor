import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs before vi.mock factories, ensuring the flags are defined
// when the mocks are installed — avoids "Cannot access before initialization".
const flags = vi.hoisted(() => ({ nvAvailable: false, qsvAvailable: false, cpuAvailable: true }));

// vi.mock factories must use a real constructor function (not an arrow fn) when
// the production code does `new Strategy()`. We use a class expression that
// delegates to a plain object so we can capture `flags` at call-time.
vi.mock('@/services/encoding/NvidiaEncodingStrategy', () => ({
  NvidiaEncodingStrategy: class {
    getName() { return 'NVIDIA NVENC'; }
    async isAvailable() { return flags.nvAvailable; }
    getOptions() { return []; }
  },
}));
vi.mock('@/services/encoding/IntelQsvEncodingStrategy', () => ({
  IntelQsvEncodingStrategy: class {
    getName() { return 'Intel Quick Sync Video'; }
    async isAvailable() { return flags.qsvAvailable; }
    getOptions() { return []; }
  },
}));
vi.mock('@/services/encoding/CpuEncodingStrategy', () => ({
  CpuEncodingStrategy: class {
    getName() { return 'CPU (libx264)'; }
    async isAvailable() { return flags.cpuAvailable; }
    getOptions() { return []; }
  },
}));

import { EncodingStrategyFactory } from '@/services/encoding/EncodingStrategyFactory';

describe('EncodingStrategyFactory', () => {
  beforeEach(() => {
    // Reset the static cache between tests.
    // The field is `cachedStrategy` (private static in EncodingStrategyFactory.ts line 13).
    (EncodingStrategyFactory as unknown as { cachedStrategy: unknown }).cachedStrategy = null;
    flags.nvAvailable = false;
    flags.qsvAvailable = false;
    flags.cpuAvailable = true;
  });

  it('selects NVENC first when available', async () => {
    flags.nvAvailable = true;
    expect((await EncodingStrategyFactory.createStrategy()).getName()).toBe('NVIDIA NVENC');
  });

  it('falls through to QSV when NVENC is unavailable', async () => {
    flags.qsvAvailable = true;
    expect((await EncodingStrategyFactory.createStrategy()).getName()).toBe('Intel Quick Sync Video');
  });

  it('falls back to libx264 when no GPU encoder is available', async () => {
    expect((await EncodingStrategyFactory.createStrategy()).getName()).toBe('CPU (libx264)');
  });

  it('caches the result (no re-probe on second call)', async () => {
    flags.nvAvailable = true;
    const first = await EncodingStrategyFactory.createStrategy();
    const second = await EncodingStrategyFactory.createStrategy();
    expect(second).toBe(first);
  });

  it('getStrategyInfo reports available + recommended', async () => {
    flags.nvAvailable = true;
    const info = await EncodingStrategyFactory.getStrategyInfo();
    expect(info.recommendedStrategy).toBe('NVIDIA NVENC');
    expect(info.availableStrategies).toContain('CPU (libx264)');
  });

  it('forces libx264 fallback when all candidates (including CPU) return false', async () => {
    // Covers the "unreachable" path at lines 46-49: all isAvailable() return false
    flags.cpuAvailable = false;
    const strategy = await EncodingStrategyFactory.createStrategy();
    // The fallback creates a new CpuEncodingStrategy whose getName() uses cpuAvailable=false
    // but the fallback object itself has getName() from the class mock
    expect(strategy.getName()).toBe('CPU (libx264)');
  });
});
