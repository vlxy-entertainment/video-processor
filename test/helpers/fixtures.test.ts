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
    expect(tsWithFFmpegMeta().indexOf(Buffer.from('FFmpeg')).valueOf()).toBe(10);
  });
});
