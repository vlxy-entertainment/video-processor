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
    expect(cfg.TIKTOK_ITEMS_PER_ACCOUNT).toBe(10);
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
    const cfg = EnvConfigSchema.parse({
      ...baseEnv,
      TIKTOK_ITEMS_PER_ACCOUNT: '8',
      MAX_SEGMENT_SIZE_MB: '9.5',
    });
    expect(cfg.TIKTOK_ITEMS_PER_ACCOUNT).toBe(8);
    expect(cfg.MAX_SEGMENT_SIZE_MB).toBe(9.5);
  });

  it('rejects TIKTOK_ITEMS_PER_ACCOUNT below 1', () => {
    expect(() => EnvConfigSchema.parse({ ...baseEnv, TIKTOK_ITEMS_PER_ACCOUNT: '0' })).toThrow();
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
