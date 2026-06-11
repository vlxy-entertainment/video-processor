import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { account } from '../../helpers/fixtures';

// vi.hoisted ensures `post` is available when the mock factory runs.
const post = vi.hoisted(() => vi.fn());

vi.mock('@/services/apiClientService', () => ({
  ApiClientService: class {
    post = post;
    setHeader = vi.fn();
  },
}));

vi.mock('fs', () => {
  const { PassThrough } = require('stream');
  return {
    promises: { stat: vi.fn(async () => ({ size: 100 })) },
    createReadStream: vi.fn(() => new PassThrough()),
  };
});

import { TiktokUploadService } from '@/services/tiktok/TiktokUploadService';

// The CDN is the default from EnvConfigSchema: 'https://p21-ad-sg.ibyteimg.com/obj/'
// extractImageUrl strips leading slash from uri before appending to CDN.
// uri '/img/x.png' → 'https://p21-ad-sg.ibyteimg.com/obj/img/x.png'
const okResponse = {
  data: {
    status_code: 0,
    data: { uri: '/img/x.png', url_list: [], url_prefix: '' },
  },
};

describe('TiktokUploadService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    post.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the CDN URL on success', async () => {
    post.mockResolvedValue(okResponse);
    const url = await new TiktokUploadService().performUpload('/f/segment_000.png', account());
    expect(url).toContain('img/x.png');
  });

  it('returns null when status_code is non-zero', async () => {
    post.mockResolvedValue({ data: { status_code: 10, status_msg: 'bad' } });
    expect(await new TiktokUploadService().performUpload('/f.png', account())).toBeNull();
  });

  it('returns null when response has no uri', async () => {
    post.mockResolvedValue({ data: { status_code: 0, data: { uri: '', url_list: [], url_prefix: '' } } });
    expect(await new TiktokUploadService().performUpload('/f.png', account())).toBeNull();
  });

  it('throws when the account has no CSRF token', async () => {
    await expect(
      new TiktokUploadService().performUpload('/f.png', account({ csrftoken: null as unknown as string }))
    ).rejects.toThrow(/CSRF token/);
  });

  it('retries on a 5xx then succeeds', async () => {
    const err = Object.assign(new Error('5xx'), { response: { status: 503 } });
    post.mockRejectedValueOnce(err).mockResolvedValueOnce(okResponse);
    const promise = new TiktokUploadService().performUpload('/f.png', account());
    await vi.runAllTimersAsync();
    expect(await promise).toContain('img/x.png');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('rethrows a non-retryable error immediately', async () => {
    const err = Object.assign(new Error('403'), { response: { status: 403 } });
    post.mockRejectedValue(err);
    await expect(new TiktokUploadService().performUpload('/f.png', account())).rejects.toBe(err);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting MAX_RETRIES (3) on repeated 5xx', async () => {
    const err = Object.assign(new Error('503'), { response: { status: 503 } });
    // MAX_RETRIES=3, so 4 total attempts (attempt 0,1,2,3) → attempt 3 >= MAX_RETRIES → throws
    post
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err);
    // Attach rejection handler immediately to prevent unhandled rejection warning
    const promise = new TiktokUploadService().performUpload('/f.png', account());
    const caught = promise.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const result = await caught;
    expect(result).toBe(err);
    expect(post).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it('builds a correct CDN URL stripping the leading slash', async () => {
    post.mockResolvedValue(okResponse);
    const url = await new TiktokUploadService().performUpload('/f.png', account());
    // Should not have double-slash in the path part (after the protocol ://)
    // Extract path portion after host to avoid matching 'http://' itself
    const pathPart = url!.replace(/^https?:\/\/[^/]+/, '');
    expect(pathPart).not.toMatch(/\/\//);
    expect(url).toMatch(/img\/x\.png$/);
  });
});

describe('getContentType', () => {
  it('maps extensions and defaults to octet-stream', () => {
    const svc = new TiktokUploadService() as unknown as Record<string, (f: string) => string>;
    expect(svc['getContentType']('a.png')).toBe('image/png');
    expect(svc['getContentType']('a.mp4')).toBe('video/mp4');
    expect(svc['getContentType']('a.xyz')).toBe('application/octet-stream');
  });

  it('handles jpg/jpeg and other image types', () => {
    const svc = new TiktokUploadService() as unknown as Record<string, (f: string) => string>;
    expect(svc['getContentType']('a.jpg')).toBe('image/jpeg');
    expect(svc['getContentType']('a.jpeg')).toBe('image/jpeg');
    expect(svc['getContentType']('a.gif')).toBe('image/gif');
    expect(svc['getContentType']('a.webp')).toBe('image/webp');
    expect(svc['getContentType']('a.svg')).toBe('image/svg+xml');
  });

  it('handles video types', () => {
    const svc = new TiktokUploadService() as unknown as Record<string, (f: string) => string>;
    expect(svc['getContentType']('a.avi')).toBe('video/avi');
    expect(svc['getContentType']('a.mov')).toBe('video/quicktime');
    expect(svc['getContentType']('a.webm')).toBe('video/webm');
    expect(svc['getContentType']('a.mkv')).toBe('video/x-matroska');
  });
});
