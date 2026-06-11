import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queueItem } from '../helpers/fixtures';

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

import { QueueService } from '@/services/queueService';

beforeEach(() => {
  state.results = [];
});

// ---------------------------------------------------------------------------
// getNextItem
// ---------------------------------------------------------------------------
describe('QueueService.getNextItem', () => {
  it('returns null when a video is already processing', async () => {
    state.results = [{ data: [{ id: 'p' }], error: null }];
    expect(await new QueueService().getNextItem()).toBeNull();
  });

  it('returns null when no queued items exist', async () => {
    state.results = [{ data: [], error: null }, { data: [], error: null }];
    expect(await new QueueService().getNextItem()).toBeNull();
  });

  it('claims the next queued item atomically', async () => {
    const item = queueItem({ status: 'queued' });
    state.results = [
      { data: [], error: null },
      { data: [item], error: null },
      { data: { ...item, status: 'processing' }, error: null },
    ];
    const claimed = await new QueueService().getNextItem();
    expect(claimed?.status).toBe('processing');
  });

  it('returns null when another instance already claimed it', async () => {
    const item = queueItem();
    state.results = [
      { data: [], error: null },
      { data: [item], error: null },
      { data: null, error: null },
    ];
    expect(await new QueueService().getNextItem()).toBeNull();
  });

  it('returns null when the processing-check query errors', async () => {
    state.results = [{ data: null, error: { message: 'db down' } }];
    expect(await new QueueService().getNextItem()).toBeNull();
  });

  it('returns null when the select-queued query errors', async () => {
    state.results = [
      { data: [], error: null }, // no processing items
      { data: null, error: { message: 'select fail' } }, // queued select fails
    ];
    expect(await new QueueService().getNextItem()).toBeNull();
  });

  it('returns null when the atomic update errors', async () => {
    const item = queueItem({ status: 'queued' });
    state.results = [
      { data: [], error: null },
      { data: [item], error: null },
      { data: null, error: { message: 'update race' } },
    ];
    expect(await new QueueService().getNextItem()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// addToQueue / getNextIndex
// ---------------------------------------------------------------------------
describe('QueueService writes', () => {
  it('addToQueue inserts and returns the parsed item', async () => {
    state.results = [
      { data: [{ index: 4 }], error: null },
      { data: queueItem({ index: 5 }), error: null },
    ];
    const created = await new QueueService().addToQueue('n', 't', 'f');
    expect(created.index).toBe(5);
  });

  it('addToQueue with empty queue uses index 0', async () => {
    // getNextIndex returns 0 when data=[]
    state.results = [
      { data: [], error: null }, // getNextIndex → empty
      { data: queueItem({ index: 0 }), error: null }, // insert
    ];
    const created = await new QueueService().addToQueue();
    expect(created.index).toBe(0);
  });

  it('addToQueue handles getNextIndex error and falls back to 0', async () => {
    state.results = [
      { data: null, error: { message: 'idx fail' } }, // getNextIndex error
      { data: queueItem({ index: 0 }), error: null }, // insert
    ];
    const created = await new QueueService().addToQueue();
    expect(created.index).toBe(0);
  });

  it('updateStatus throws on a supabase error', async () => {
    state.results = [{ data: null, error: { message: 'boom' } }];
    await expect(new QueueService().updateStatus('id', 'failed', 0)).rejects.toThrow('boom');
  });

  it('updateStatus returns the parsed item on success', async () => {
    const item = queueItem({ status: 'processing', progress: 50 });
    state.results = [{ data: item, error: null }];
    const result = await new QueueService().updateStatus('id', 'processing', 50);
    expect(result.status).toBe('processing');
    expect(result.progress).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// getQueue / logCurrentQueue
// ---------------------------------------------------------------------------
describe('QueueService.getQueue', () => {
  it('returns parsed items on success', async () => {
    const items = [queueItem({ index: 0 }), queueItem({ id: '22222222-2222-2222-2222-222222222222', index: 1 })];
    state.results = [{ data: items, error: null }];
    const queue = await new QueueService().getQueue();
    expect(queue).toHaveLength(2);
    expect(queue[0].index).toBe(0);
  });

  it('throws on error', async () => {
    state.results = [{ data: null, error: { message: 'queue fetch fail' } }];
    await expect(new QueueService().getQueue()).rejects.toThrow('queue fetch fail');
  });
});

describe('QueueService.logCurrentQueue', () => {
  it('returns queue items and logs them', async () => {
    const items = [queueItem()];
    state.results = [{ data: items, error: null }];
    const result = await new QueueService().logCurrentQueue();
    expect(result).toHaveLength(1);
  });

  it('re-throws on error', async () => {
    state.results = [{ data: null, error: { message: 'log fail' } }];
    await expect(new QueueService().logCurrentQueue()).rejects.toThrow('log fail');
  });
});

// ---------------------------------------------------------------------------
// isTorrentInQueue
// ---------------------------------------------------------------------------
describe('QueueService.isTorrentInQueue', () => {
  it('returns true when torrent is found', async () => {
    state.results = [{ data: [{ id: 'x' }], error: null }];
    expect(await new QueueService().isTorrentInQueue('t1', 'f1')).toBe(true);
  });

  it('returns false when not found', async () => {
    state.results = [{ data: [], error: null }];
    expect(await new QueueService().isTorrentInQueue('t1', 'f1')).toBe(false);
  });

  it('returns false on error', async () => {
    state.results = [{ data: null, error: { message: 'db error' } }];
    expect(await new QueueService().isTorrentInQueue('t1', 'f1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// removeFromQueue
// ---------------------------------------------------------------------------
describe('QueueService.removeFromQueue', () => {
  it('resolves successfully', async () => {
    state.results = [{ data: null, error: null }];
    await expect(new QueueService().removeFromQueue('some-id')).resolves.toBeUndefined();
  });

  it('throws on error', async () => {
    state.results = [{ data: null, error: { message: 'delete fail' } }];
    await expect(new QueueService().removeFromQueue('some-id')).rejects.toThrow('delete fail');
  });
});
