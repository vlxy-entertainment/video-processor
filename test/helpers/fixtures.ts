import type { VideoProcessingQueueItem, Video, TiktokAccount } from '@/types';

/** The 1x1 transparent carrier PNG the production code prepends. Ends in IEND. */
export const CARRIER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/** Wraps a payload after the carrier PNG, exactly like the production wrap step. */
export function wrapInPng(payload: Buffer | string): Buffer {
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([CARRIER_PNG, buf]);
}

/**
 * A synthetic MPEG-TS-ish buffer with an embedded "FFmpeg" metadata marker and a
 * later 0x47 sync byte, for exercising stripFFmpegMetadata.
 * Layout: [10 bytes header][6 "FFmpeg"][junk ...][0x47 sync + payload].
 */
export function tsWithFFmpegMeta(): Buffer {
  const header = Buffer.alloc(10, 0x11); // 10 bytes; "FFmpeg" starts at index 10
  const marker = Buffer.from('FFmpeg');
  const junk = Buffer.alloc(200, 0x22); // pushes the next 0x47 well past byte 188
  const sync = Buffer.from([0x47, 0xde, 0xad, 0xbe, 0xef]);
  return Buffer.concat([header, marker, junk, sync]);
}

/** A clean TS buffer with no FFmpeg marker. */
export function tsClean(): Buffer {
  return Buffer.from([0x47, 0x01, 0x02, 0x03, 0x04]);
}

/** Sample HLS playlist text. */
export const SAMPLE_M3U8 = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:5',
  '#EXTINF:5.000,',
  'segment_000.ts',
  '#EXTINF:4.200,',
  'segment_001.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

/** ffprobe packet CSV (pts_time,flags) with keyframes (K) at 0, 4, 10 seconds. */
export const KEYFRAME_CSV = [
  '0.000000,K_',
  '1.000000,__',
  '4.000000,K_',
  '7.000000,__',
  '10.000000,K_',
  '',
].join('\n');

export function queueItem(overrides: Partial<VideoProcessingQueueItem> = {}): VideoProcessingQueueItem {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    index: 0,
    status: 'queued',
    progress: 0,
    video_name: 'Test Video',
    torrent_id: 'torrent-1',
    file_id: 'file-1',
    ...overrides,
  };
}

export function video(overrides: Partial<Video> = {}): Video {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    title: 'Test Video',
    description: 'desc',
    status: 'ready',
    ...overrides,
  };
}

export function account(overrides: Partial<TiktokAccount> = {}): TiktokAccount {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    name: 'acct-1',
    aadvid: 'aad-1',
    sid_guard_ads: 'sid-1',
    csrftoken: 'csrf-1',
    status: 'active',
    upload_count: 0,
    ...overrides,
  };
}
