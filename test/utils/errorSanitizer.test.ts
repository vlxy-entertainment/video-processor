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

  it('handles circular JSON in final size check (covers line 226)', () => {
    // After sanitizeForLogging processes it, the sanitized result must itself be
    // circular so JSON.stringify throws in the final-size-check block.
    // The easiest way: pass a plain object through sanitizeForLogging so it returns
    // an object, then have that object be circular. We can't do this directly since
    // sanitizeForLogging doesn't produce circulars, so we exercise the path by
    // passing something that sanitizeForLogging returns as a non-undefined value and
    // then manually verifying the branch exists. Instead, mock JSON.stringify for one call.
    // Simpler approach: the path at line 226 is the inner catch of JSON.stringify inside
    // createSafeLogEntry. We trigger it by passing data that, after sanitization, still
    // fails JSON.stringify. Since sanitizeForLogging deeply cleans objects, a plain circular
    // at top level becomes an object with a '...' key — it won't be circular after sanitize.
    // Verified: this specific line is hit only via the catch of the inner JSON.stringify.
    // We can use a Symbol value (JSON.stringify({a: Symbol()}) does NOT throw — it omits it).
    // The only reliable way is to temporarily override JSON.stringify.
    const orig = JSON.stringify;
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (JSON as any).stringify = (...args: unknown[]) => {
      callCount++;
      if (callCount === 1) throw new Error('circular');
      return orig.apply(JSON, args as Parameters<typeof orig>);
    };
    try {
      const out = createSafeLogEntry('msg', { x: 1 });
      expect(out.data).toBe('[Unable to serialize log data]');
    } finally {
      (JSON as any).stringify = orig;
    }
  });

  it('handles outer catch when sanitizeForLogging throws (covers line 238)', () => {
    // Trigger the outermost catch by making sanitizeForLogging throw.
    // We do this by passing a getter that throws during property enumeration.
    const evil = Object.defineProperty({}, 'boom', {
      get() { throw new Error('getter exploded'); },
      enumerable: true,
    });
    const out = createSafeLogEntry('msg', evil);
    // Should return the error message wrapped in the fallback
    expect(typeof out.data).toBe('string');
    expect(out.data as string).toContain('getter exploded');
  });
});

describe('sanitizeForLogging extra branches', () => {
  it('returns truncated string for large response object without important fields (line 185)', () => {
    // A response-data object whose JSON.stringify exceeds 10000 bytes but has
    // none of message/error/status/statusCode, so it falls through to the
    // "[Response data too large]" string (line 185).
    const big = { blob: 'x'.repeat(10001) };
    const out = sanitizeForLogging({ data: big }) as Record<string, string>;
    expect(out.data).toContain('[Response data too large:');
  });

  it('returns [Unable to serialize response data] when JSON.stringify throws (line 189-190)', () => {
    // Circular objects cannot be JSON.stringified.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = sanitizeForLogging({ data: circular }) as Record<string, string>;
    expect(out.data).toBe('[Unable to serialize response data]');
  });

  it('converts non-string, non-object primitives via String() path (line 128-136)', () => {
    // BigInt falls through all typed checks and hits the final String(data) path.
    // BigInt(42) is not a boolean, number, string, Error, Array, or object in the
    // traditional sense — actually typeof BigInt is 'bigint', which none of the
    // type guards match. String(BigInt(42)) = '42'.
    const out = sanitizeForLogging(BigInt(42));
    expect(out).toBe('42');
  });
});
