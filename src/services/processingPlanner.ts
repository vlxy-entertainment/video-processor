import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpeg from 'fluent-ffmpeg';
import { logger } from '@/utils/logger';
import { envConfig } from '@/config';
import type { ProcessingPlan } from '@/types';

const execFileAsync = promisify(execFile);

/**
 * Decides whether a source can be remuxed (stream-copied) into HLS or must be
 * transcoded, based on a bounded probe of the source's bitrate and keyframe
 * spacing.
 */
export class ProcessingPlanner {
  /** Seconds of the source to sample when measuring keyframe spacing. */
  private readonly probeWindowSeconds = 60;

  /**
   * Builds a processing plan for a source URL.
   * @param sourceUrl The source video URL (e.g. a TorBox temporary URL).
   * @returns The selected route and the reasoning.
   */
  async plan(sourceUrl: string): Promise<ProcessingPlan> {
    try {
      const bitrateBps = await this.getVideoBitrateBps(sourceUrl);
      const maxKeyframeGapSeconds = await this.getMaxKeyframeGapSeconds(sourceUrl);

      // Worst-case segment: a remux can only cut at keyframes, so a segment can
      // span an entire keyframe gap at the source's bitrate.
      const predictedMaxSegmentBytes = (bitrateBps / 8) * maxKeyframeGapSeconds;
      const predictedMaxSegmentMB = predictedMaxSegmentBytes / (1024 * 1024);

      const budgetMB = envConfig.MAX_SEGMENT_SIZE_MB * envConfig.SEGMENT_SIZE_SAFETY_MARGIN;

      if (predictedMaxSegmentMB > 0 && predictedMaxSegmentMB <= budgetMB) {
        return {
          route: 'remux',
          reason:
            `predicted max segment ${predictedMaxSegmentMB.toFixed(2)}MB ` +
            `<= budget ${budgetMB.toFixed(2)}MB ` +
            `(bitrate ${(bitrateBps / 1_000_000).toFixed(2)}Mbps, ` +
            `max keyframe gap ${maxKeyframeGapSeconds.toFixed(2)}s)`,
          predictedMaxSegmentMB,
        };
      }

      return {
        route: 'transcode',
        reason:
          `predicted max segment ${predictedMaxSegmentMB.toFixed(2)}MB ` +
          `> budget ${budgetMB.toFixed(2)}MB — re-encode to fit`,
        predictedMaxSegmentMB,
      };
    } catch (error) {
      // Probing failed (unreachable URL, exotic container, etc.). Transcoding
      // always produces a valid result, so it is the safe default.
      logger.warn('⚠️ Planner probe failed; defaulting to transcode route:', error);
      return { route: 'transcode', reason: 'probe failed — defaulting to transcode' };
    }
  }

  /**
   * Reads the video stream's bitrate (bps). Falls back to the container bitrate,
   * then to a resolution-based estimate.
   * @param sourceUrl The source URL.
   */
  private async getVideoBitrateBps(sourceUrl: string): Promise<number> {
    const metadata = await new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
      ffmpeg.ffprobe(sourceUrl, (err, data) => (err ? reject(err) : resolve(data)));
    });

    const videoStream = metadata.streams?.find(s => s.codec_type === 'video');
    const streamBitrate = videoStream?.bit_rate ? parseInt(videoStream.bit_rate, 10) : 0;
    if (streamBitrate > 0) return streamBitrate;

    const formatBitrate = metadata.format?.bit_rate
      ? parseInt(String(metadata.format.bit_rate), 10)
      : 0;
    if (formatBitrate > 0) return formatBitrate;

    // Resolution-based estimate (matches IntelQsvEncodingStrategy's table).
    const width = videoStream?.width ?? 1920;
    if (width >= 3840) return 120_000_000;
    if (width >= 1920) return 40_000_000;
    if (width >= 1280) return 20_000_000;
    return 8_000_000;
  }

  /**
   * Measures the largest gap (seconds) between consecutive keyframes in the
   * first `probeWindowSeconds` of the source. Uses ffprobe packet flags, bounded
   * by `-read_intervals` so remote sources are not fully downloaded.
   * @param sourceUrl The source URL.
   */
  private async getMaxKeyframeGapSeconds(sourceUrl: string): Promise<number> {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-read_intervals',
      `%+${this.probeWindowSeconds}`,
      '-show_entries',
      'packet=pts_time,flags',
      '-of',
      'csv=print_section=0',
      sourceUrl,
    ]);

    const keyframeTimes: number[] = [];
    for (const line of stdout.split('\n')) {
      const [ptsTime, flags] = line.split(',');
      if (!ptsTime || !flags) continue;
      // Keyframe packets carry the 'K' flag (e.g. "K_" or "K__").
      if (flags.includes('K')) {
        const t = parseFloat(ptsTime);
        if (!Number.isNaN(t)) keyframeTimes.push(t);
      }
    }

    if (keyframeTimes.length < 2) {
      // Too few keyframes sampled to trust — report a large gap so the caller
      // routes to transcode rather than risk an oversize remux segment.
      return Number.POSITIVE_INFINITY;
    }

    keyframeTimes.sort((a, b) => a - b);
    let maxGap = 0;
    for (let i = 1; i < keyframeTimes.length; i++) {
      const gap = keyframeTimes[i]! - keyframeTimes[i - 1]!;
      if (gap > maxGap) maxGap = gap;
    }
    return maxGap;
  }
}
