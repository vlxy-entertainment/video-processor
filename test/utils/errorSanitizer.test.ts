import { describe, it, expect } from 'vitest';
import { sanitizeForLogging, createSafeLogEntry } from '@/utils/errorSanitizer';

describe('sanitizeForLogging', () => {
  it('passes primitives through', () => {
    expect(sanitizeForLogging(null)).toBeNull();
    expect(sanitizeForLogging(undefined)).toBeUndefined();
    expect(sanitizeForLogging(5)).toBe(5);
    expect(sanitizeForLogging(true)).toBe(true);
  });

  it('truncates long strings', () => {
    const out = sanitizeForLogging('a'.repeat(10001)) as string;
    expect(out).toContain('[truncated 1 chars]');
  });

  it('extracts safe fields from an Error with cause and extra props', () => {
    const err = new Error('boom') as Error & { cause?: unknown; extra?: string };
    err.cause = new Error('root');
    err.extra = 'x';
    const out = sanitizeForLogging(err) as Record<string, unknown>;
    expect(out.name).toBe('Error');
    expect(out.message).toBe('boom');
    expect(out.cause).toBeDefined();
    expect(out.properties).toBeDefined();
  });

  it('caps arrays at 100 items', () => {
    const out = sanitizeForLogging(Array.from({ length: 150 }, (_, i) => i)) as unknown[];
    expect(out.length).toBe(101);
    expect(out[100]).toContain('50 more items');
  });

  it('caps object keys at 50 and skips functions', () => {
    const obj: Record<string, unknown> = { fn: () => 1 };
    for (let i = 0; i < 60; i++) obj[`k${i}`] = i;
    const out = sanitizeForLogging(obj) as Record<string, unknown>;
    expect(out.fn).toBeUndefined();
    expect(out['...']).toContain('more keys');
  });

  it('summarizes Buffer and Date', () => {
    expect(sanitizeForLogging(Buffer.alloc(3))).toBe('[Buffer: 3 bytes]');
    const d = new Date('2020-01-01T00:00:00.000Z');
    expect(sanitizeForLogging(d)).toBe('2020-01-01T00:00:00.000Z');
  });

  it('stops at max depth', () => {
    expect(sanitizeForLogging({}, 11)).toBe('[Max depth exceeded]');
  });

  it('special-cases large response data with important fields', () => {
    const big = { message: 'm', status: 500, blob: 'x'.repeat(11000) };
    const out = sanitizeForLogging({ data: big }) as Record<string, Record<string, unknown>>;
    expect(out.data._truncated).toBe(true);
    expect(out.data.message).toBe('m');
  });
});

describe('createSafeLogEntry', () => {
  it('returns sanitized data', () => {
    expect(createSafeLogEntry('msg', { a: 1 })).toEqual({ message: 'msg', data: { a: 1 } });
  });

  it('truncates entries above the max size', () => {
    // Use many keys with strings at the per-string limit (10000 chars) so
    // sanitizeForLogging doesn't shrink them but the total exceeds 100 KB.
    const huge: Record<string, string> = {};
    for (let i = 0; i < 50; i++) huge[`k${i}`] = 'x'.repeat(10000);
    const out = createSafeLogEntry('msg', huge);
    expect((out.data as Record<string, unknown>)._truncated).toBe(true);
  });

  it('omits data when none is given', () => {
    expect(createSafeLogEntry('msg')).toEqual({ message: 'msg', data: undefined });
  });
});
