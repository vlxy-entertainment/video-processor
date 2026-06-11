import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queueItem, video } from '../helpers/fixtures';

const m = vi.hoisted(() => ({
  getNextItem: vi.fn(),
  updateStatus: vi.fn(async () => undefined),
  requestDownloadUrl: vi.fn(async () => 'http://video'),
  processVideo: vi.fn(async () => undefined),
  uploadProcessedFiles: vi.fn(async () => 'https://cdn/playlist.png'),
  createVideo: vi.fn(),
  updateVideoStatus: vi.fn(),
  submitVideo: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
}));

vi.mock('@/services/queueService', () => ({
  QueueService: class {
    getNextItem = m.getNextItem;
    updateStatus = m.updateStatus;
  },
}));
vi.mock('@/services/torboxService', () => ({
  TorboxService: class {
    requestDownloadUrl = m.requestDownloadUrl;
  },
}));
vi.mock('@/services/videoProcessor', () => ({
  VideoProcessor: class {
    processVideo = m.processVideo;
  },
}));
vi.mock('@/services/tiktokUploadOrchestrator', () => ({
  TiktokUploadOrchestrator: class {
    uploadProcessedFiles = m.uploadProcessedFiles;
  },
}));
vi.mock('@/services/videoService', () => ({
  VideoService: class {
    createVideo = m.createVideo;
    updateVideoStatus = m.updateVideoStatus;
  },
}));
vi.mock('@/services/indexNowService', () => ({
  IndexNowService: class {
    submitVideo = m.submitVideo;
  },
}));
vi.mock('fs', () => ({ promises: { access: m.access, rm: m.rm } }));

import { ProcessingService } from '@/services/processingService';

beforeEach(() => {
  vi.clearAllMocks();
  m.getNextItem.mockResolvedValue(queueItem());
  m.processVideo.mockResolvedValue(undefined);
  m.createVideo.mockResolvedValue(video());
  m.updateVideoStatus.mockResolvedValue(video());
  m.requestDownloadUrl.mockResolvedValue('http://video');
  m.uploadProcessedFiles.mockResolvedValue('https://cdn/playlist.png');
  m.access.mockResolvedValue(undefined);
  m.rm.mockResolvedValue(undefined);
});

describe('ProcessingService.processNextVideo', () => {
  it('returns early when the queue is empty', async () => {
    m.getNextItem.mockResolvedValue(null);
    await new ProcessingService().processNextVideo();
    expect(m.requestDownloadUrl).not.toHaveBeenCalled();
  });

  it('runs the full pipeline and marks the item processed', async () => {
    await new ProcessingService().processNextVideo();
    expect(m.updateStatus).toHaveBeenCalledWith(expect.any(String), 'processed', 100);
  });

  it('marks the item failed and rethrows when a step throws', async () => {
    m.processVideo.mockRejectedValue(new Error('encode failed'));
    await expect(new ProcessingService().processNextVideo()).rejects.toThrow('encode failed');
    expect(m.updateStatus).toHaveBeenCalledWith(expect.any(String), 'failed', 0);
  });

  it('throws when torrent_id/file_id are missing', async () => {
    m.getNextItem.mockResolvedValue(queueItem({ torrent_id: null, file_id: null }));
    await expect(new ProcessingService().processNextVideo()).rejects.toThrow();
    // torrent_id/file_id check is inside the inner try/catch → marks failed
    expect(m.updateStatus).toHaveBeenCalledWith(expect.any(String), 'failed', 0);
  });

  it('throws "Queue item ID is required" when id is missing, without marking failed', async () => {
    // The !queueItem.id guard (line 53) is OUTSIDE the inner try/catch.
    // It is inside the outer try which only re-throws — so updateStatus is never called.
    m.getNextItem.mockResolvedValue(queueItem({ id: undefined as unknown as string }));
    await expect(new ProcessingService().processNextVideo()).rejects.toThrow(
      'Queue item ID is required'
    );
    // The outer catch re-throws without calling updateStatus
    expect(m.updateStatus).not.toHaveBeenCalled();
  });

  it('calls submitVideo when video.id is present', async () => {
    m.createVideo.mockResolvedValue(video({ id: 'vid-uuid' }));
    await new ProcessingService().processNextVideo();
    expect(m.submitVideo).toHaveBeenCalledWith('vid-uuid');
  });

  it('skips submitVideo when video.id is falsy', async () => {
    m.createVideo.mockResolvedValue(video({ id: undefined as unknown as string }));
    await new ProcessingService().processNextVideo();
    expect(m.submitVideo).not.toHaveBeenCalled();
    // Pipeline still completes successfully
    expect(m.updateStatus).toHaveBeenCalledWith(expect.any(String), 'processed', 100);
  });

  it('uses "Unknown" as video name when both video_name and torrent_id are absent', async () => {
    // Covers the `|| 'Unknown'` branches on lines 57 and 150 (the error-path videoName).
    // torrent_id is null → inner try fails ("torrent_id and file_id are required")
    // but line 57 already ran with video_name=null, torrent_id=null → falls through to 'Unknown'
    m.getNextItem.mockResolvedValue(
      queueItem({ video_name: null as unknown as string, torrent_id: null, file_id: null })
    );
    await expect(new ProcessingService().processNextVideo()).rejects.toThrow();
    // marks failed (inner-try path)
    expect(m.updateStatus).toHaveBeenCalledWith(expect.any(String), 'failed', 0);
  });

  it('covers ?? null branches when optional queue fields are undefined', async () => {
    // Covers the `?? null` branches for optional fields (video_name, video_description, etc.)
    // by providing a queue item where those fields are undefined.
    m.getNextItem.mockResolvedValue(
      queueItem({
        video_name: undefined as unknown as string,
        video_description: undefined,
        release_date: undefined,
        thumbnail_url: undefined,
        actresses: undefined,
        video_network: undefined,
      })
    );
    await new ProcessingService().processNextVideo();
    expect(m.createVideo).toHaveBeenCalledWith(
      expect.objectContaining({ video_name: null })
    );
    expect(m.updateStatus).toHaveBeenCalledWith(expect.any(String), 'processed', 100);
  });

  it('error path: timingBreakdown empty when torrent_id/file_id missing (covers else branch)', async () => {
    // torrent_id/file_id check fails BEFORE any timing entry is added → timingBreakdown empty.
    // Also exercises 'Unknown' in the error-path videoName when video_name is null.
    m.getNextItem.mockResolvedValue(
      queueItem({ video_name: null as unknown as string, torrent_id: null, file_id: null })
    );
    await expect(new ProcessingService().processNextVideo()).rejects.toThrow(
      'torrent_id and file_id are required'
    );
    expect(m.updateStatus).toHaveBeenCalledWith(expect.any(String), 'failed', 0);
  });

  describe('cleanupOutputFolder', () => {
    it('skips rm when the directory does not exist (access throws)', async () => {
      m.access.mockRejectedValue(new Error('ENOENT'));
      // Should complete without calling rm (dir doesn't exist — nothing to delete)
      await new ProcessingService().processNextVideo();
      expect(m.rm).not.toHaveBeenCalled();
      expect(m.updateStatus).toHaveBeenCalledWith(expect.any(String), 'processed', 100);
    });

    it('does not throw when rm itself fails (error is swallowed)', async () => {
      m.access.mockResolvedValue(undefined);
      m.rm.mockRejectedValue(new Error('permission denied'));
      // cleanup failure is swallowed — the overall pipeline still succeeds
      await expect(new ProcessingService().processNextVideo()).resolves.toBeUndefined();
    });

    it('also skips rm during failure cleanup when directory does not exist', async () => {
      m.processVideo.mockRejectedValue(new Error('encode failed'));
      m.access.mockRejectedValue(new Error('ENOENT'));
      await expect(new ProcessingService().processNextVideo()).rejects.toThrow('encode failed');
      expect(m.rm).not.toHaveBeenCalled();
    });
  });
});
