import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ requestDownloadLink: vi.fn() }));
vi.mock('@torbox/torbox-api', () => ({
  TorboxApi: class {
    torrents = { requestDownloadLink: m.requestDownloadLink };
  },
}));

import { TorboxService } from '@/services/torboxService';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TorboxService.requestDownloadUrl', () => {
  it('returns download URL on success', async () => {
    m.requestDownloadLink.mockResolvedValueOnce({ data: { data: 'http://cdn.example.com/file.mp4' } });
    const url = await new TorboxService().requestDownloadUrl('torrent-1', 'file-1');
    expect(url).toBe('http://cdn.example.com/file.mp4');
  });

  it('throws "TorBox API returned no data" when data is null', async () => {
    m.requestDownloadLink.mockResolvedValueOnce({ data: null });
    await expect(new TorboxService().requestDownloadUrl('t', 'f')).rejects.toThrow(
      'TorBox API returned no data'
    );
  });

  it('throws "TorBox API error" when data.error is set', async () => {
    m.requestDownloadLink.mockResolvedValueOnce({
      data: { error: 'some API error', data: null },
    });
    await expect(new TorboxService().requestDownloadUrl('t', 'f')).rejects.toThrow(
      'TorBox API error: some API error'
    );
  });

  it('throws "TorBox API returned no download URL" when data.data is null', async () => {
    m.requestDownloadLink.mockResolvedValueOnce({ data: { error: null, data: null } });
    await expect(new TorboxService().requestDownloadUrl('t', 'f')).rejects.toThrow(
      'TorBox API returned no download URL'
    );
  });

  it('wraps thrown errors with "Failed to request download URL from TorBox"', async () => {
    m.requestDownloadLink.mockRejectedValueOnce(new Error('network timeout'));
    await expect(new TorboxService().requestDownloadUrl('t', 'f')).rejects.toThrow(
      'Failed to request download URL from TorBox: network timeout'
    );
  });

  it('wraps non-Error throws with "Unknown error"', async () => {
    m.requestDownloadLink.mockRejectedValueOnce('string-error');
    await expect(new TorboxService().requestDownloadUrl('t', 'f')).rejects.toThrow(
      'Failed to request download URL from TorBox: Unknown error'
    );
  });
});
