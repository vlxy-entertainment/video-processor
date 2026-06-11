import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('axios', () => ({ default: { post: m.post }, post: m.post }));

import { IndexNowService } from '@/services/indexNowService';

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// submitVideo
// ---------------------------------------------------------------------------
describe('IndexNowService.submitVideo', () => {
  it('resolves without throwing on 200', async () => {
    m.post.mockResolvedValueOnce({ status: 200 });
    await expect(new IndexNowService().submitVideo('video-uuid-1')).resolves.toBeUndefined();
    expect(m.post).toHaveBeenCalledOnce();
  });

  it('resolves without throwing on 202', async () => {
    m.post.mockResolvedValueOnce({ status: 202 });
    await expect(new IndexNowService().submitVideo('video-uuid-2')).resolves.toBeUndefined();
  });

  it('resolves without throwing on unexpected status (e.g. 500)', async () => {
    m.post.mockResolvedValueOnce({ status: 500 });
    await expect(new IndexNowService().submitVideo('video-uuid-3')).resolves.toBeUndefined();
  });

  it('swallows a rejected promise — never throws', async () => {
    m.post.mockRejectedValueOnce(Object.assign(new Error('network error'), { response: null }));
    await expect(new IndexNowService().submitVideo('video-uuid-4')).resolves.toBeUndefined();
  });

  it('constructs correct IndexNow request body', async () => {
    m.post.mockResolvedValueOnce({ status: 200 });
    await new IndexNowService().submitVideo('abc-123');
    const [, body] = m.post.mock.calls[0];
    expect(body).toMatchObject({ urlList: ['https://vlxy.org/video/abc-123'] });
    expect(body.host).toBeDefined();
    expect(body.key).toBeDefined();
  });

  it('swallows AxiosError with response data', async () => {
    const axiosError = Object.assign(new Error('Unprocessable'), {
      response: { status: 422, statusText: 'Unprocessable Entity', data: 'Invalid URL' },
    });
    m.post.mockRejectedValueOnce(axiosError);
    await expect(new IndexNowService().submitVideo('vid-5')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// submitVideos
// ---------------------------------------------------------------------------
describe('IndexNowService.submitVideos', () => {
  it('returns early without calling post when array is empty', async () => {
    await expect(new IndexNowService().submitVideos([])).resolves.toBeUndefined();
    expect(m.post).not.toHaveBeenCalled();
  });

  it('submits all URLs on success (200)', async () => {
    m.post.mockResolvedValueOnce({ status: 200 });
    await expect(
      new IndexNowService().submitVideos(['vid-a', 'vid-b'])
    ).resolves.toBeUndefined();
    expect(m.post).toHaveBeenCalledOnce();
    const [, body] = m.post.mock.calls[0];
    expect(body.urlList).toHaveLength(2);
  });

  it('submits on 202', async () => {
    m.post.mockResolvedValueOnce({ status: 202 });
    await expect(new IndexNowService().submitVideos(['v1'])).resolves.toBeUndefined();
  });

  it('handles unexpected status without throwing', async () => {
    m.post.mockResolvedValueOnce({ status: 400 });
    await expect(new IndexNowService().submitVideos(['v1'])).resolves.toBeUndefined();
  });

  it('swallows a rejected promise — never throws', async () => {
    m.post.mockRejectedValueOnce(new Error('timeout'));
    await expect(new IndexNowService().submitVideos(['vid-c'])).resolves.toBeUndefined();
  });
});
