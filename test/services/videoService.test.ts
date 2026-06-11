import { describe, it, expect, vi, beforeEach } from 'vitest';
import { video } from '../helpers/fixtures';

const state = vi.hoisted(() => ({ results: [] as { data: unknown; error: unknown }[] }));
vi.mock('@/config/supabase', () => {
  const builder: any = {};
  for (const mth of ['select', 'insert', 'update', 'delete', 'eq', 'order', 'limit'])
    builder[mth] = () => builder;
  const next = () =>
    (state.results.length > 1 ? state.results.shift() : state.results[0]) ?? {
      data: null,
      error: null,
    };
  builder.single = () => Promise.resolve(next());
  builder.then = (f: (v: unknown) => unknown) => Promise.resolve(next()).then(f);
  return { supabase: { from: () => builder } };
});

import { VideoService } from '@/services/videoService';

beforeEach(() => {
  state.results = [];
});

// ---------------------------------------------------------------------------
// createVideo
// ---------------------------------------------------------------------------
describe('VideoService.createVideo — title/description derivation', () => {
  it('uses video_name as title when provided', async () => {
    const v = video({ title: 'My Video', description: 'Video: My Video' });
    state.results = [{ data: v, error: null }];
    const result = await new VideoService().createVideo({
      id: 'q1',
      video_path: '/tmp/some/file.mp4',
      video_name: 'My Video',
    });
    expect(result.title).toBe('My Video');
  });

  it('falls back to filename when video_name is absent', async () => {
    const v = video({ title: 'file.mp4', description: 'Video file: file.mp4' });
    state.results = [{ data: v, error: null }];
    const result = await new VideoService().createVideo({
      id: 'q1',
      video_path: '/tmp/some/file.mp4',
    });
    expect(result.title).toBe('file.mp4');
  });

  it('uses video_description when provided', async () => {
    const v = video({ description: 'Custom desc' });
    state.results = [{ data: v, error: null }];
    const result = await new VideoService().createVideo({
      id: 'q1',
      video_path: '/tmp/file.mp4',
      video_name: 'Test',
      video_description: 'Custom desc',
    });
    expect(result.description).toBe('Custom desc');
  });

  it('throws when insert fails', async () => {
    state.results = [{ data: null, error: { message: 'insert fail' } }];
    await expect(
      new VideoService().createVideo({ id: 'q1', video_path: '/tmp/file.mp4' })
    ).rejects.toThrow('insert fail');
  });
});

describe('VideoService.createVideo — with video_network', () => {
  it('finds existing network and uses its id', async () => {
    const NET_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const v = video({ video_network_id: NET_ID });
    state.results = [
      // findOrCreateNetwork: find existing → returns { id: NET_ID }
      { data: { id: NET_ID }, error: null },
      // video insert
      { data: v, error: null },
    ];
    const result = await new VideoService().createVideo({
      id: 'q1',
      video_path: '/tmp/file.mp4',
      video_network: 'TestNet',
    });
    expect(result.video_network_id).toBe(NET_ID);
  });

  it('creates network when not found (PGRST116)', async () => {
    const newNetId = 'ffffffff-0000-1111-2222-333333333333';
    const v = video({ video_network_id: newNetId });
    state.results = [
      // findOrCreateNetwork: not found → PGRST116
      { data: null, error: { code: 'PGRST116', message: 'not found' } },
      // findOrCreateNetwork: create
      { data: { id: newNetId }, error: null },
      // video insert
      { data: v, error: null },
    ];
    const result = await new VideoService().createVideo({
      id: 'q1',
      video_path: '/tmp/file.mp4',
      video_network: 'NewNet',
    });
    expect(result.video_network_id).toBe(newNetId);
  });

  it('throws when network find returns a non-PGRST116 error', async () => {
    state.results = [{ data: null, error: { code: 'OTHER', message: 'db error' } }];
    await expect(
      new VideoService().createVideo({
        id: 'q1',
        video_path: '/tmp/file.mp4',
        video_network: 'BadNet',
      })
    ).rejects.toThrow('db error');
  });

  it('throws when network create fails', async () => {
    state.results = [
      { data: null, error: { code: 'PGRST116', message: 'not found' } },
      { data: null, error: { message: 'create net fail' } },
    ];
    await expect(
      new VideoService().createVideo({
        id: 'q1',
        video_path: '/tmp/file.mp4',
        video_network: 'FailNet',
      })
    ).rejects.toThrow('create net fail');
  });
});

describe('VideoService.createVideo — with actresses', () => {
  it('finds existing actress and assigns her', async () => {
    const v = video({ id: '22222222-2222-2222-2222-222222222222' });
    state.results = [
      // video insert
      { data: v, error: null },
      // findOrCreateActress: found
      { data: { id: 'act-uuid-1111-1111-1111-111111111111' }, error: null },
      // assignActressesToVideo: insert video_actresses
      { data: null, error: null },
    ];
    const result = await new VideoService().createVideo({
      id: 'q1',
      video_path: '/tmp/file.mp4',
      actresses: 'Jane Doe',
    });
    expect(result.id).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('creates actress when not found (PGRST116)', async () => {
    const v = video({ id: '22222222-2222-2222-2222-222222222222' });
    state.results = [
      // video insert
      { data: v, error: null },
      // findOrCreateActress: not found → PGRST116
      { data: null, error: { code: 'PGRST116', message: 'not found' } },
      // findOrCreateActress: create
      { data: { id: 'new-act-1111-1111-1111-111111111111' }, error: null },
      // assignActressesToVideo: insert
      { data: null, error: null },
    ];
    const result = await new VideoService().createVideo({
      id: 'q1',
      video_path: '/tmp/file.mp4',
      actresses: 'New Actress',
    });
    expect(result.id).toBeDefined();
  });

  it('throws when actress find errors with non-PGRST116', async () => {
    const v = video({ id: '22222222-2222-2222-2222-222222222222' });
    state.results = [
      { data: v, error: null },
      { data: null, error: { code: 'OTHER', message: 'actress db error' } },
    ];
    await expect(
      new VideoService().createVideo({
        id: 'q1',
        video_path: '/tmp/file.mp4',
        actresses: 'Bad Actress',
      })
    ).rejects.toThrow('actress db error');
  });

  it('throws when actress create fails', async () => {
    const v = video({ id: '22222222-2222-2222-2222-222222222222' });
    state.results = [
      { data: v, error: null },
      { data: null, error: { code: 'PGRST116', message: 'not found' } },
      { data: null, error: { message: 'create actress fail' } },
    ];
    await expect(
      new VideoService().createVideo({
        id: 'q1',
        video_path: '/tmp/file.mp4',
        actresses: 'Fail Actress',
      })
    ).rejects.toThrow('create actress fail');
  });

  it('returns early when actresses string is empty/whitespace', async () => {
    const v = video({ id: '22222222-2222-2222-2222-222222222222' });
    state.results = [{ data: v, error: null }];
    const result = await new VideoService().createVideo({
      id: 'q1',
      video_path: '/tmp/file.mp4',
      actresses: '  ,  , ',
    });
    expect(result.id).toBeDefined();
  });

  it('throws when video_actresses insert fails', async () => {
    const v = video({ id: '22222222-2222-2222-2222-222222222222' });
    state.results = [
      { data: v, error: null },
      { data: { id: 'act-uuid-1111-1111-1111-111111111111' }, error: null }, // find actress
      { data: null, error: { message: 'assign fail' } }, // insert video_actresses
    ];
    await expect(
      new VideoService().createVideo({
        id: 'q1',
        video_path: '/tmp/file.mp4',
        actresses: 'Jane',
      })
    ).rejects.toThrow('assign fail');
  });

  it('handles multiple actresses comma-separated', async () => {
    const v = video({ id: '22222222-2222-2222-2222-222222222222' });
    state.results = [
      { data: v, error: null },
      // actress 1: found
      { data: { id: 'act-uuid-1111-1111-1111-1111-111111111111' }, error: null },
      // actress 2: found
      { data: { id: 'act-uuid-2222-2222-2222-2222-222222222222' }, error: null },
      // insert video_actresses
      { data: null, error: null },
    ];
    const result = await new VideoService().createVideo({
      id: 'q1',
      video_path: '/tmp/file.mp4',
      actresses: 'Alice, Bob',
    });
    expect(result.id).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// updateVideoStatus
// ---------------------------------------------------------------------------
describe('VideoService.updateVideoStatus', () => {
  it('updates status without hlsPlaylistUrl', async () => {
    const v = video({ status: 'ready' });
    state.results = [{ data: v, error: null }];
    const result = await new VideoService().updateVideoStatus('vid-id', 'ready');
    expect(result.status).toBe('ready');
  });

  it('updates status with hlsPlaylistUrl', async () => {
    const v = video({ status: 'ready', hls_playlist_url: 'https://cdn.example.com/p.m3u8' });
    state.results = [{ data: v, error: null }];
    const result = await new VideoService().updateVideoStatus(
      'vid-id',
      'ready',
      'https://cdn.example.com/p.m3u8'
    );
    expect(result.hls_playlist_url).toBe('https://cdn.example.com/p.m3u8');
  });

  it('throws on error', async () => {
    state.results = [{ data: null, error: { message: 'update fail' } }];
    await expect(new VideoService().updateVideoStatus('vid-id', 'failed')).rejects.toThrow(
      'update fail'
    );
  });
});

// ---------------------------------------------------------------------------
// getVideo
// ---------------------------------------------------------------------------
describe('VideoService.getVideo', () => {
  it('returns the video when found', async () => {
    const v = video();
    state.results = [{ data: v, error: null }];
    const result = await new VideoService().getVideo('22222222-2222-2222-2222-222222222222');
    expect(result?.id).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('returns null when not found (PGRST116)', async () => {
    state.results = [{ data: null, error: { code: 'PGRST116', message: 'not found' } }];
    const result = await new VideoService().getVideo('22222222-2222-2222-2222-222222222222');
    expect(result).toBeNull();
  });

  it('throws on a non-PGRST116 error', async () => {
    state.results = [{ data: null, error: { code: 'OTHER', message: 'db exploded' } }];
    await expect(
      new VideoService().getVideo('22222222-2222-2222-2222-222222222222')
    ).rejects.toThrow('db exploded');
  });
});
