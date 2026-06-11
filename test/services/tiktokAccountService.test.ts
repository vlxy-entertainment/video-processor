import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { account } from '../helpers/fixtures';

const state = vi.hoisted(
  () =>
    ({
      results: [] as { data: unknown; error: unknown }[],
      lastUpdate: null as Record<string, unknown> | null,
    }) as {
      results: { data: unknown; error: unknown }[];
      lastUpdate: Record<string, unknown> | null;
    }
);

vi.mock('@/config/supabase', () => {
  const builder: any = {};
  for (const mth of ['select', 'insert', 'delete', 'eq', 'order', 'limit'])
    builder[mth] = () => builder;
  // Override update to capture payload
  builder.update = (payload: Record<string, unknown>) => {
    state.lastUpdate = payload;
    return builder;
  };
  const next = () =>
    (state.results.length > 1 ? state.results.shift() : state.results[0]) ?? {
      data: null,
      error: null,
    };
  builder.single = () => Promise.resolve(next());
  builder.then = (f: (v: unknown) => unknown) => Promise.resolve(next()).then(f);
  return { supabase: { from: () => builder } };
});

import { TiktokAccountService } from '@/services/tiktokAccountService';

beforeEach(() => {
  state.results = [];
  state.lastUpdate = null;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// getActiveAccounts
// ---------------------------------------------------------------------------
describe('TiktokAccountService.getActiveAccounts', () => {
  it('maps database rows to TiktokAccount objects', async () => {
    const acct = account();
    state.results = [{ data: [acct], error: null }];
    const accounts = await new TiktokAccountService().getActiveAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe(acct.id);
    expect(accounts[0].aadvid).toBe(acct.aadvid);
  });

  it('returns empty array when no active accounts exist', async () => {
    state.results = [{ data: [], error: null }];
    const accounts = await new TiktokAccountService().getActiveAccounts();
    expect(accounts).toEqual([]);
  });

  it('returns empty array when data is null', async () => {
    state.results = [{ data: null, error: null }];
    const accounts = await new TiktokAccountService().getActiveAccounts();
    expect(accounts).toEqual([]);
  });

  it('throws on error', async () => {
    state.results = [{ data: null, error: { message: 'fetch fail' } }];
    await expect(new TiktokAccountService().getActiveAccounts()).rejects.toThrow('fetch fail');
  });

  it('defaults upload_count to 0 when null in db', async () => {
    const acct = { ...account(), upload_count: null };
    state.results = [{ data: [acct], error: null }];
    const accounts = await new TiktokAccountService().getActiveAccounts();
    expect(accounts[0].upload_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// updateUploadStats
// ---------------------------------------------------------------------------
describe('TiktokAccountService.updateUploadStats', () => {
  it('increments upload_count correctly', async () => {
    state.results = [
      { data: { upload_count: 5 }, error: null }, // fetch current
      { data: null, error: null }, // update
    ];
    await new TiktokAccountService().updateUploadStats('acct-id');
    expect(state.lastUpdate).not.toBeNull();
    expect((state.lastUpdate as Record<string, unknown>).upload_count).toBe(6);
  });

  it('handles null upload_count (treats as 0)', async () => {
    state.results = [
      { data: { upload_count: null }, error: null },
      { data: null, error: null },
    ];
    await new TiktokAccountService().updateUploadStats('acct-id');
    expect((state.lastUpdate as Record<string, unknown>).upload_count).toBe(1);
  });

  it('throws when fetch current upload count fails', async () => {
    state.results = [{ data: null, error: { message: 'fetch count fail' } }];
    await expect(new TiktokAccountService().updateUploadStats('acct-id')).rejects.toThrow(
      'fetch count fail'
    );
  });

  it('throws when update fails', async () => {
    state.results = [
      { data: { upload_count: 3 }, error: null },
      { data: null, error: { message: 'update fail' } },
    ];
    await expect(new TiktokAccountService().updateUploadStats('acct-id')).rejects.toThrow(
      'update fail'
    );
  });
});

// ---------------------------------------------------------------------------
// setAccountLimited
// ---------------------------------------------------------------------------
describe('TiktokAccountService.setAccountLimited', () => {
  it('sets status to limited with 24h cooldown by default', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T00:00:00.000Z'));
    state.results = [{ data: null, error: null }];

    await new TiktokAccountService().setAccountLimited('acct-id');

    expect(state.lastUpdate).not.toBeNull();
    expect((state.lastUpdate as Record<string, unknown>).status).toBe('limited');

    // cooldown_until should be 24h later: 2026-06-12T00:00:00.000Z
    const cooldownUntil = new Date(
      (state.lastUpdate as Record<string, unknown>).cooldown_until as string
    );
    expect(cooldownUntil.getUTCHours()).toBe(0);
    expect(cooldownUntil.toISOString()).toBe('2026-06-12T00:00:00.000Z');
  });

  it('uses custom cooldown hours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T12:00:00.000Z'));
    state.results = [{ data: null, error: null }];

    await new TiktokAccountService().setAccountLimited('acct-id', 6);

    const cooldownUntil = new Date(
      (state.lastUpdate as Record<string, unknown>).cooldown_until as string
    );
    expect(cooldownUntil.toISOString()).toBe('2026-06-11T18:00:00.000Z');
  });

  it('throws on error', async () => {
    state.results = [{ data: null, error: { message: 'limit fail' } }];
    await expect(new TiktokAccountService().setAccountLimited('acct-id')).rejects.toThrow(
      'limit fail'
    );
  });
});

// ---------------------------------------------------------------------------
// updateCsrfToken
// ---------------------------------------------------------------------------
describe('TiktokAccountService.updateCsrfToken', () => {
  it('resolves successfully', async () => {
    state.results = [{ data: null, error: null }];
    await expect(
      new TiktokAccountService().updateCsrfToken('acct-id', 'new-csrf')
    ).resolves.toBeUndefined();
    expect((state.lastUpdate as Record<string, unknown>).csrftoken).toBe('new-csrf');
  });

  it('throws on error', async () => {
    state.results = [{ data: null, error: { message: 'csrf fail' } }];
    await expect(
      new TiktokAccountService().updateCsrfToken('acct-id', 'token')
    ).rejects.toThrow('csrf fail');
  });
});
